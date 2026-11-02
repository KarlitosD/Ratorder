import { chooseAudioCodec, chooseVideoCodec } from '../media/codecs'
import { computeVideoBitrate, inferQualityPreset } from '../recording/config'
import type { RecordingMetadata } from '../types'
import type { RecordingStore } from '../storage/recording-store'
import { holdRecordingLock } from '../storage/recording-lock'
import { layoutTimeline, projectDuration, projectHasAudio } from './model'
import type { EditorProject } from './types'
import type {
  ExportMainMessage,
  ExportWorkerMessage,
} from './export-protocol'

const AUDIO_SAMPLE_RATE = 48_000
const AUDIO_CHANNELS = 2
const AUDIO_BITRATE = 192_000
const WORKER_READY_TIMEOUT_MS = 10_000
const WORKER_TERMINATE_TIMEOUT_MS = 8_000

export interface ExportDependencies {
  store: RecordingStore
  getSourceFile: () => Promise<File>
  getAssetFile: (assetId: string) => Promise<File>
}

export interface ExportOptions {
  sourceRecording: RecordingMetadata
  title?: string
  onProgress?: (progress: number, message: string) => void
  signal?: AbortSignal
}

export interface ExportResult {
  metadata: RecordingMetadata
}

export function editedTitle(sourceTitle: string, override?: string): string {
  if (override?.trim()) return override.trim().slice(0, 120)
  const base =
    sourceTitle
      .replace(/\s*\(editada\)\s*$/i, '')
      .trim() || 'Grabación'
  return `${base} (editada)`.slice(0, 120)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Exportación cancelada.', 'AbortError')
  }
}

export async function exportEditedRecording(
  project: EditorProject,
  deps: ExportDependencies,
  options: ExportOptions,
): Promise<ExportResult> {
  const duration = projectDuration(project)
  if (duration <= 0) {
    throw new Error('La edición no tiene ningún segmento para exportar.')
  }

  const report = (() => {
    let last = -1
    let lastAt = 0
    return (progress: number, message: string, force = false) => {
      const now = performance.now()
      if (!force && now - lastAt < 120) return
      lastAt = now
      const safe = Math.min(1, Math.max(0, progress))
      const next = force ? Math.max(last, safe) : safe
      if (!force && next <= last) return
      last = next
      options.onProgress?.(next, message)
    }
  })()

  throwIfAborted(options.signal)
  report(0.02, 'Preparando la exportación', true)

  const preset = inferQualityPreset(project.width, project.height)
  const videoBitrate = computeVideoBitrate(preset, project.fps)
  const videoCodec = await chooseVideoCodec(project.container, {
    width: project.width,
    height: project.height,
    fps: project.fps,
    bitrate: videoBitrate,
  })
  if (!videoCodec) {
    throw new Error(
      project.container === 'mp4'
        ? 'Este navegador no puede codificar el video MP4 de la edición.'
        : 'Este navegador no puede codificar el video WebM de la edición.',
    )
  }
  throwIfAborted(options.signal)

  const hasAudio = projectHasAudio(project)
  const audioCodec = hasAudio
    ? await chooseAudioCodec(project.container, {
        numberOfChannels: AUDIO_CHANNELS,
        sampleRate: AUDIO_SAMPLE_RATE,
        bitrate: AUDIO_BITRATE,
      })
    : null
  if (hasAudio && !audioCodec) {
    throw new Error('Este navegador no puede codificar el audio de la edición.')
  }
  throwIfAborted(options.signal)

  const now = new Date().toISOString()
  const recordingId = crypto.randomUUID()
  let metadata: RecordingMetadata = {
    version: 1,
    id: recordingId,
    title: editedTitle(project.title, options.title),
    createdAt: now,
    updatedAt: now,
    startedAtEpochMs: Date.now(),
    durationMs: Math.round(duration * 1000),
    size: 0,
    width: project.width,
    height: project.height,
    fps: project.fps,
    container: project.container,
    extension: project.container,
    mimeType: null,
    status: 'recording',
    hasAudio,
    hasMicrophone: false,
    hasSystemAudio: hasAudio,
    audioCodec,
    videoCodec,
    sourceLabel: 'Edición',
    thumbnail: null,
    editedFrom: options.sourceRecording.id,
  }

  await deps.store.createRecording(metadata)
  const releaseLock = await holdRecordingLock(recordingId)

  let worker: Worker | null = null
  let settled = false
  let onAbort: (() => void) | null = null
  let readyTimer = 0
  let terminateTimer: ReturnType<typeof setTimeout> | null = null

  const cleanupWorker = () => {
    if (onAbort && options.signal) {
      options.signal.removeEventListener('abort', onAbort)
      onAbort = null
    }
    if (readyTimer) {
      window.clearTimeout(readyTimer)
      readyTimer = 0
    }
    if (terminateTimer) {
      clearTimeout(terminateTimer)
      terminateTimer = null
    }
    if (worker) {
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
      worker = null
    }
  }

  try {
    throwIfAborted(options.signal)
    // Recolecta los archivos necesarios sin copiar su contenido.
    const sourceFile = await deps.getSourceFile()
    throwIfAborted(options.signal)
    const views = layoutTimeline(project)
    const videoAssetIds = new Set(
      views.map((view) => view.clip.mediaId).filter((id) => id !== 'source'),
    )
    const imageAssetIds = new Set(
      project.overlays
        .filter((overlay) => overlay.kind === 'image' && overlay.assetId)
        .map((overlay) => overlay.assetId as string),
    )
    const assetFiles: Record<string, File> = {}
    for (const assetId of new Set([...videoAssetIds, ...imageAssetIds])) {
      throwIfAborted(options.signal)
      const asset = project.assets.find((item) => item.id === assetId)
      if (!asset) {
        throw new Error('Falta un medio importado que usa la edición.')
      }
      try {
        assetFiles[assetId] = await deps.getAssetFile(assetId)
      } catch (error) {
        throw new Error(
          `No se pudo abrir el medio importado “${asset.name}”: ${
            error instanceof Error ? error.message : 'formato no compatible'
          }`,
        )
      }
    }
    throwIfAborted(options.signal)

    worker = new Worker(new URL('./export.worker.ts', import.meta.url), {
      type: 'module',
    })

    const ready = new Promise<void>((resolve, reject) => {
      readyTimer = window.setTimeout(() => {
        reject(
          new Error(
            'El worker de exportación no respondió a tiempo. Prueba a recargar la página.',
          ),
        )
      }, WORKER_READY_TIMEOUT_MS)
      const w = worker
      if (!w) {
        reject(new Error('No se pudo crear el worker de exportación.'))
        return
      }
      const handleReady = (event: MessageEvent<ExportWorkerMessage>) => {
        if (event.data?.type === 'ready') {
          window.clearTimeout(readyTimer)
          readyTimer = 0
          w.removeEventListener('message', handleReady as EventListener)
          resolve()
        }
      }
      w.addEventListener('message', handleReady as EventListener)
      w.addEventListener(
        'error',
        () => {
          window.clearTimeout(readyTimer)
          readyTimer = 0
          reject(
            new Error(
              'No se pudo cargar el worker de exportación. Comprueba la conexión y recarga.',
            ),
          )
        },
        { once: true },
      )
      w.addEventListener(
        'messageerror',
        () => {
          window.clearTimeout(readyTimer)
          readyTimer = 0
          reject(new Error('El worker de exportación envió un mensaje no válido.'))
        },
        { once: true },
      )
    })
    await ready
    throwIfAborted(options.signal)

    const result = await new Promise<{
      size: number
      mimeType: string | null
      thumbnail: Blob | null
    }>((resolve, reject) => {
      const w = worker
      if (!w) {
        reject(new Error('No se pudo crear el worker de exportación.'))
        return
      }
      let done = false
      const finish = (
        fn: () => void,
      ) => {
        if (done || settled) return
        done = true
        fn()
      }
      onAbort = () => {
        w.postMessage({ type: 'cancel' } satisfies ExportMainMessage)
        // Espera el cierre cooperativo; si no responde, termina el worker.
        terminateTimer = setTimeout(() => {
          finish(() => {
            reject(new DOMException('Exportación cancelada.', 'AbortError'))
          })
        }, WORKER_TERMINATE_TIMEOUT_MS)
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      w.onmessage = (event: MessageEvent<ExportWorkerMessage>) => {
        const message = event.data
        if (!message || typeof message !== 'object') {
          finish(() => {
            reject(new Error('El worker de exportación envió un mensaje no válido.'))
          })
          return
        }
        switch (message.type) {
          case 'progress':
            report(message.progress, message.message)
            break
          case 'done':
            finish(() => {
              if (terminateTimer) {
                clearTimeout(terminateTimer)
                terminateTimer = null
              }
              resolve(message.result)
            })
            break
          case 'error':
            finish(() => {
              if (terminateTimer) {
                clearTimeout(terminateTimer)
                terminateTimer = null
              }
              reject(new Error(message.error))
            })
            break
          case 'canceled':
            finish(() => {
              if (terminateTimer) {
                clearTimeout(terminateTimer)
                terminateTimer = null
              }
              reject(new DOMException('Exportación cancelada.', 'AbortError'))
            })
            break
        }
      }
      w.onerror = (event) => {
        finish(() => {
          reject(
            new Error(
              event.message
                ? `El worker de exportación falló: ${event.message}`
                : 'El worker de exportación se detuvo de forma inesperada.',
            ),
          )
        })
      }
      w.onmessageerror = () => {
        finish(() => {
          reject(new Error('El worker de exportación envió un mensaje no válido.'))
        })
      }
      const start: ExportMainMessage = {
        type: 'start',
        project,
        sourceFile,
        assetFiles,
        recordingId,
        extension: project.container,
        videoCodec,
        audioCodec,
        videoBitrate,
        audioBitrate: AUDIO_BITRATE,
      }
      w.postMessage(start)
    })

    // Una vez iniciado el cierre cooperativo / persistencia final, una
    // cancelación tardía no borra una grabación ya completada.
    if (options.signal?.aborted) {
      throw new DOMException('Exportación cancelada.', 'AbortError')
    }
    report(0.98, 'Guardando la copia', true)
    let thumbnail = result.thumbnail
    metadata = {
      ...metadata,
      updatedAt: new Date().toISOString(),
      durationMs: Math.round(duration * 1000),
      size: result.size,
      mimeType: result.mimeType,
      status: 'completed',
      hasAudio,
      audioCodec,
      videoCodec,
    }
    if (thumbnail && thumbnail.size > 0) {
      try {
        metadata.thumbnail = await deps.store.saveThumbnail(metadata.id, thumbnail)
      } catch (error) {
        console.warn('No se pudo guardar la miniatura de la edición.', error)
      }
    }
    thumbnail = null
    await deps.store.saveMetadata(metadata)
    settled = true
    cleanupWorker()
    releaseLock()
    report(1, 'Copia editada guardada', true)
    return { metadata }
  } catch (error) {
    cleanupWorker()
    // Si la grabación ya se completó y persistió, no borrarla.
    if (!settled) {
      await deps.store.deleteRecording(recordingId).catch(() => undefined)
    }
    throw error
  } finally {
    if (!settled) {
      cleanupWorker()
    }
    releaseLock()
  }
}
