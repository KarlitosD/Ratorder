/// <reference lib="webworker" />

import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  BlobSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  VideoSample,
  VideoSampleSource,
  AudioSampleSource,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  type AudioCodec,
  type VideoCodec,
} from 'mediabunny'
import { clipAudioFrames, type DecodedAudioFrame } from './audio-frames'
import { renderFrame } from './compositor'
import {
  layoutTimeline,
  projectDuration,
  projectHasAudio,
  sourceTimeForView,
} from './model'
import type { ExportMainMessage, ExportWorkerMessage } from './export-protocol'
import { ExportOpfsWriter } from './export-opfs'
import type { EditorMediaInfo } from './types'
import interLatinUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url'
import interLatinExtUrl from '@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2?url'

const AUDIO_SAMPLE_RATE = 48_000
const AUDIO_CHANNELS = 2

const scope = self as unknown as DedicatedWorkerGlobalScope & {
  fonts: FontFaceSet
}

let canceled = false
let running = false

function post(message: ExportWorkerMessage): void {
  scope.postMessage(message)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function throwIfCanceled(): void {
  if (canceled) {
    throw new DOMException('Exportación cancelada.', 'AbortError')
  }
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

async function ensureApis(): Promise<void> {
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error(
      'Este navegador no ofrece OffscreenCanvas en workers; no se puede exportar fuera del hilo principal.',
    )
  }
  if (
    typeof (globalThis as Record<string, unknown>).VideoEncoder === 'undefined' ||
    typeof (globalThis as Record<string, unknown>).AudioEncoder === 'undefined'
  ) {
    throw new Error(
      'Este navegador no ofrece WebCodecs en workers; no se puede exportar.',
    )
  }
  try {
    const root = await navigator.storage.getDirectory()
    void root
  } catch {
    throw new Error(
      'Este navegador no ofrece almacenamiento local persistente (OPFS); no se puede exportar.',
    )
  }
}

async function loadFonts(): Promise<void> {
  // La carga de fuentes nunca bloquea la exportación: cada cara compite
  // con un timeout y un fallo solo deja la fuente del sistema.
  const withTimeout = async (task: Promise<unknown>, ms: number) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      await Promise.race([
        task,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms)
        }),
      ])
    } catch {
      // Se registra abajo; continuar con la fuente del sistema.
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  try {
    const faces: FontFace[] = []
    for (const [url, unicodeRange] of [
      [interLatinUrl as string, 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'],
      [interLatinExtUrl as string, 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'],
    ] as Array<[string, string]>) {
      const face = new FontFace('Inter Variable', `url(${url})`, {
        weight: '100 900',
        style: 'normal',
        unicodeRange,
      })
      faces.push(face)
    }
    for (const face of faces) {
      await withTimeout(
        face
          .load()
          .then(() => {
            scope.fonts.add(face)
          })
          .catch((error: unknown) => {
            console.warn('No se pudo cargar una fuente en el worker.', error)
          }),
        5000,
      )
      throwIfCanceled()
    }
    await withTimeout(scope.fonts.ready.catch(() => undefined), 5000)
  } catch (error) {
    // Continúa con la fuente del sistema; no bloquea la exportación.
    console.warn('No se pudieron cargar las fuentes en el worker.', error)
  }
}

interface OpenedWorkerMedia {
  input: Input
  videoTrack: import('mediabunny').InputVideoTrack
  audioTrack: import('mediabunny').InputAudioTrack | null
  info: EditorMediaInfo
  sink: import('mediabunny').CanvasSink
  dispose(): void
}

async function openMediaFile(file: Blob): Promise<OpenedWorkerMedia> {
  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  })
  try {
    const videoTrack = await input.getPrimaryVideoTrack()
    if (!videoTrack) {
      throw new Error('El archivo no contiene una pista de video compatible.')
    }
    if (!(await videoTrack.canDecode())) {
      throw new Error(
        'Este navegador no puede decodificar el video de este archivo.',
      )
    }
    let audioTrack = await input.getPrimaryAudioTrack()
    if (audioTrack && !(await audioTrack.canDecode())) {
      audioTrack = null
    }
    const videoStart = await videoTrack.getFirstTimestamp()
    const videoEnd = await videoTrack.computeDuration()
    const videoDuration = Math.max(0, videoEnd - videoStart)
    const audioStart = audioTrack
      ? await audioTrack.getFirstTimestamp()
      : videoStart
    const audioEnd = audioTrack
      ? await audioTrack.computeDuration()
      : videoStart
    const audioDuration = audioTrack ? Math.max(0, audioEnd - audioStart) : 0
    const frameRate = await videoTrack
      .computeFrameRateMetrics({ targetPacketCount: 128 })
      .catch(() => null)
    const info: EditorMediaInfo = {
      duration: Math.max(videoDuration, audioDuration),
      width: Math.max(2, Math.round(videoTrack.displayWidth)),
      height: Math.max(2, Math.round(videoTrack.displayHeight)),
      fps: Math.max(1, Math.round(frameRate?.bestGuessFrameRate || 30)),
      hasAudio: Boolean(audioTrack),
      startTimestamp: Number.isFinite(videoStart) ? videoStart : 0,
      audioStartTimestamp: Number.isFinite(audioStart) ? audioStart : 0,
    }
    const { CanvasSink } = await import('mediabunny')
    const sink = new CanvasSink(videoTrack, {
      alpha: false,
      poolSize: 2,
      fit: 'contain',
    })
    return {
      input,
      videoTrack,
      audioTrack,
      info,
      sink,
      dispose() {
        input.dispose()
      },
    }
  } catch (error) {
    input.dispose()
    throw error
  }
}

async function* readDecodedFrames(
  media: OpenedWorkerMedia,
  start: number,
  end: number,
): AsyncGenerator<DecodedAudioFrame> {
  const track = media.audioTrack
  if (!track) return
  const sink = new AudioSampleSink(track)
  let planeA = new Float32Array(8192)
  let planeB = new Float32Array(8192)
  for await (const sample of sink.samples(start, end)) {
    try {
      throwIfCanceled()
      const frames = sample.numberOfFrames
      const channels = sample.numberOfChannels
      if (frames <= 0 || channels <= 0) continue
      if (planeA.length < frames) {
        planeA = new Float32Array(frames)
        planeB = new Float32Array(frames)
      }
      const out: Float32Array[] = []
      const count = Math.min(channels, 2)
      for (let channel = 0; channel < count; channel += 1) {
        const target = channel === 0 ? planeA : planeB
        sample.copyTo(target, { planeIndex: channel, format: 'f32-planar' })
        out.push(target.slice(0, frames))
      }
      yield {
        channels: out,
        sampleRate: sample.sampleRate,
        timestamp: sample.timestamp,
      }
    } finally {
      sample.close()
    }
  }
}

async function runExport(message: Extract<ExportMainMessage, { type: 'start' }>): Promise<void> {
  const { project, sourceFile, assetFiles, recordingId, extension } = message
  const duration = projectDuration(project)
  if (duration <= 0) {
    throw new Error('La edición no tiene ningún segmento para exportar.')
  }
  await ensureApis()

  const videoCodec = message.videoCodec as VideoCodec
  const audioCodec = message.audioCodec as AudioCodec | null
  // Revalida la configuración en el entorno del worker.
  const encodableVideo = await getFirstEncodableVideoCodec([videoCodec], {
    width: project.width,
    height: project.height,
    frameRate: project.fps,
    quality: new Quality({ bitrate: message.videoBitrate, bitrateMode: 'variable' }),
  }).catch(() => null)
  if (!encodableVideo) {
    throw new Error(
      'Este navegador no puede codificar el video de la edición en el worker.',
    )
  }
  const hasAudio = projectHasAudio(project)
  let encodableAudio: AudioCodec | null = null
  if (hasAudio) {
    if (!audioCodec) {
      throw new Error('Este navegador no puede codificar el audio de la edición.')
    }
    encodableAudio = await getFirstEncodableAudioCodec([audioCodec], {
      numberOfChannels: AUDIO_CHANNELS,
      sampleRate: AUDIO_SAMPLE_RATE,
      quality: new Quality({ bitrate: message.audioBitrate }),
    }).catch(() => null)
    if (!encodableAudio) {
      throw new Error(
        'Este navegador no puede codificar el audio de la edición en el worker.',
      )
    }
  }

  await loadFonts()
  throwIfCanceled()

  const media = new Map<string, OpenedWorkerMedia>()
  const images = new Map<string, ImageBitmap>()
  let output: Output | null = null
  const writer = new ExportOpfsWriter(recordingId, extension)
  const report = (() => {
    let last = -1
    let lastAt = 0
    return (progress: number, text: string, force = false) => {
      const now = performance.now()
      if (!force && now - lastAt < 120) return
      lastAt = now
      const safe = Math.min(1, Math.max(0, progress))
      const next = force ? Math.max(last, safe) : safe
      if (!force && next <= last) return
      last = next
      post({ type: 'progress', progress: next, message: text })
    }
  })()

  try {
    throwIfCanceled()
    report(0.02, 'Preparando la exportación', true)

    // Abre solo los medios realmente usados y comparte imágenes por asset.
    const videoAssetIds = new Set(
      project.clips
        .map((clip) => clip.mediaId)
        .filter((id) => id !== 'source'),
    )
    media.set('source', await openMediaFile(sourceFile))
    throwIfCanceled()
    for (const assetId of videoAssetIds) {
      const asset = project.assets.find((item) => item.id === assetId)
      if (!asset || asset.kind !== 'video') {
        throw new Error('Falta un video importado que usa la edición.')
      }
      const file = assetFiles[assetId]
      if (!file) {
        throw new Error(`No se pudo abrir el video importado “${asset.name}”.`)
      }
      try {
        media.set(assetId, await openMediaFile(file))
      } catch (error) {
        throw new Error(
          `No se pudo abrir el video importado “${asset.name}”: ${
            error instanceof Error ? error.message : 'formato no compatible'
          }`,
        )
      }
      throwIfCanceled()
    }
    const imageAssetIds = new Set(
      project.overlays
        .filter((overlay) => overlay.kind === 'image' && overlay.assetId)
        .map((overlay) => overlay.assetId as string),
    )
    for (const assetId of imageAssetIds) {
      const file = assetFiles[assetId]
      if (!file) continue
      try {
        images.set(assetId, await createImageBitmap(file))
      } catch {
        // Sin imagen: el overlay se omite como en el preview.
      }
      throwIfCanceled()
    }

    await writer.open()
    const format =
      extension === 'mp4'
        ? new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 2 })
        : new WebMOutputFormat()
    const target = new StreamTarget(writer.createWritable(), {
      chunked: true,
      chunkSize: 64 * 1024,
    })
    output = new Output({ format, target })

    const videoSource = new VideoSampleSource({
      codec: encodableVideo,
      quality: new Quality({ bitrate: message.videoBitrate, bitrateMode: 'variable' }),
      keyFrameInterval: 2,
      sizeChangeBehavior: 'deny',
    })
    output.addVideoTrack(videoSource, {
      frameRate: project.fps,
      bitrate: message.videoBitrate,
      name: 'Pantalla',
    })
    const audioSource =
      hasAudio && encodableAudio
        ? new AudioSampleSource({
            codec: encodableAudio,
            quality: new Quality({ bitrate: message.audioBitrate }),
          })
        : null
    if (audioSource) {
      output.addAudioTrack(audioSource, {
        bitrate: message.audioBitrate,
        name: 'Audio de la edición',
      })
    }
    await output.start()
    throwIfCanceled()
    report(0.05, 'Codificando video', true)

    const canvas = new OffscreenCanvas(project.width, project.height)
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) {
      throw new Error('No se pudo preparar el lienzo de la exportación.')
    }
    const views = layoutTimeline(project)
    const totalFrames = Math.max(1, Math.round(duration * project.fps))
    const totalAudioFrames = Math.round(duration * AUDIO_SAMPLE_RATE)
    let frameCursor = 0
    let audioCursor = 0
    let lastCanvas: unknown = null
    let lastCanvasWidth = 0
    let lastCanvasHeight = 0

    function* timestampGenerator(start: number, count: number, offset: number) {
      for (let index = 0; index < count; index += 1) {
        yield (start + index) / project.fps + offset
      }
    }

    for (let viewIndex = 0; viewIndex < views.length; viewIndex += 1) {
      throwIfCanceled()
      const view = views[viewIndex]
      const opened = media.get(view.clip.mediaId)
      if (!opened) {
        throw new Error(`No se pudo abrir el medio de “${view.mediaName}”.`)
      }
      const frameStart = viewIndex === 0 ? 0 : frameCursor
      const frameEnd = Math.max(
        frameStart,
        viewIndex === views.length - 1
          ? totalFrames
          : Math.min(totalFrames, Math.round(view.end * project.fps)),
      )
      const frameCount = Math.max(0, frameEnd - frameStart)
      frameCursor = frameEnd
      const clipAudioStart = Math.round(view.start * AUDIO_SAMPLE_RATE)
      const clipAudioEnd =
        viewIndex === views.length - 1
          ? totalAudioFrames
          : Math.round(view.end * AUDIO_SAMPLE_RATE)

      const sink = opened.sink
      const timestamps = timestampGenerator(
        frameStart,
        frameCount,
        opened.info.startTimestamp,
      )
      // Ajusta cada timestamp al tiempo fuente del clip.
      const mapped = (function* () {
        let index = 0
        for (const _ignored of timestamps) {
          void _ignored
          const timelineTime = (frameStart + index) / project.fps
          yield sourceTimeForView(view, timelineTime) + opened.info.startTimestamp
          index += 1
        }
      })()

      let audioIterator: AsyncIterator<{ channels: Float32Array[]; frames: number }> | null = null
      if (audioSource) {
        const mediaInfo = opened.info
        const clip = view.clip
        const start = mediaInfo.audioStartTimestamp + clip.inPoint
        const end = start + clip.sourceSpan
        const frames = clipAudioFrames({
          clip,
          audioStart: mediaInfo.audioStartTimestamp,
          hasAudio: mediaInfo.hasAudio,
          startFrame: clipAudioStart,
          endFrame: clipAudioEnd,
          sampleRate: AUDIO_SAMPLE_RATE,
          channels: AUDIO_CHANNELS,
          chunkFrames: AUDIO_SAMPLE_RATE,
          readFrames: () => readDecodedFrames(opened, start, end),
          yieldBetweenBlocks: yieldToEventLoop,
        })
        audioIterator = frames[Symbol.asyncIterator]()
      }

      const addNextAudio = async () => {
        if (!audioIterator || !audioSource) return
        const next = await audioIterator.next()
        if (next.done || !next.value) return
        const chunk = next.value
        if (chunk.frames <= 0) return
        const packed = new Float32Array(chunk.frames * AUDIO_CHANNELS)
        for (let channel = 0; channel < AUDIO_CHANNELS; channel += 1) {
          packed.set(
            chunk.channels[Math.min(channel, chunk.channels.length - 1)].subarray(0, chunk.frames),
            channel * chunk.frames,
          )
        }
        const sample = new AudioSample({
          format: 'f32-planar',
          sampleRate: AUDIO_SAMPLE_RATE,
          numberOfChannels: AUDIO_CHANNELS,
          timestamp: audioCursor / AUDIO_SAMPLE_RATE,
          data: packed,
        })
        audioCursor += chunk.frames
        try {
          await audioSource.add(sample)
        } finally {
          sample.close()
        }
      }

      if (audioIterator) {
        await addNextAudio()
      }

      let index = 0
      let framesSinceAudio = 0
      const audioEvery = Math.max(1, Math.round(project.fps))
      // `canvasesAtTimestamps` acepta iterables: no se materializa un array
      // proporcional a la duración del clip.
      for await (const wrapped of sink.canvasesAtTimestamps(mapped)) {
        throwIfCanceled()
        const timelineTime = (frameStart + index) / project.fps
        if (wrapped) {
          lastCanvas = wrapped.canvas
          lastCanvasWidth = wrapped.canvas.width
          lastCanvasHeight = wrapped.canvas.height
        }
        renderFrame({
          ctx: context as unknown as CanvasRenderingContext2D,
          width: canvas.width,
          height: canvas.height,
          project,
          duration,
          time: timelineTime,
          overlays: project.overlays,
          images,
          frame:
            lastCanvas && lastCanvasWidth > 0
              ? {
                  image: lastCanvas as CanvasImageSource,
                  width: lastCanvasWidth,
                  height: lastCanvasHeight,
                }
              : null,
          showSelection: false,
        })
        const sample = new VideoSample(canvas, {
          timestamp: (frameStart + index) / project.fps,
          duration: 1 / project.fps,
        })
        try {
          await videoSource.add(sample)
        } finally {
          sample.close()
        }
        index += 1
        framesSinceAudio += 1
        if (audioIterator && framesSinceAudio >= audioEvery) {
          await addNextAudio()
          framesSinceAudio = 0
        }
        report(
          duration > 0 ? timelineTime / duration : 0.9,
          `Codificando video · ${Math.min(99, Math.round((timelineTime / duration) * 100))}%`,
        )
        if (index % 12 === 0) {
          await yieldToEventLoop()
        }
      }

      if (audioIterator) {
        while (true) {
          throwIfCanceled()
          const next = await audioIterator.next()
          if (next.done) break
          if (!next.value || next.value.frames <= 0) continue
          const chunk = next.value
          const packed = new Float32Array(chunk.frames * AUDIO_CHANNELS)
          for (let channel = 0; channel < AUDIO_CHANNELS; channel += 1) {
            packed.set(
              chunk.channels[Math.min(channel, chunk.channels.length - 1)].subarray(0, chunk.frames),
              channel * chunk.frames,
            )
          }
          const sample = new AudioSample({
            format: 'f32-planar',
            sampleRate: AUDIO_SAMPLE_RATE,
            numberOfChannels: AUDIO_CHANNELS,
            timestamp: audioCursor / AUDIO_SAMPLE_RATE,
            data: packed,
          })
          audioCursor += chunk.frames
          try {
            await audioSource!.add(sample)
          } finally {
            sample.close()
          }
          await yieldToEventLoop()
        }
      }
      // Cierra explícitamente la fuente de video si un clip no produjo
      // frames? No: es una sola pista continua; no cerrar por clip.
      report(
        duration > 0 ? view.end / duration : 0.9,
        `Codificando segmento ${viewIndex + 1} de ${views.length}`,
        true,
      )
      await yieldToEventLoop()
    }

    throwIfCanceled()
    report(0.96, 'Finalizando el archivo', true)

    let thumbnailBlob: Blob | null = null
    const thumbTime = Math.min(1, duration / 2)
    const thumbView = views.find(
      (view) => thumbTime >= view.start && thumbTime < view.end,
    )
    if (thumbView) {
      const opened = media.get(thumbView.clip.mediaId)
      if (opened) {
        const sourceTime =
          sourceTimeForView(thumbView, thumbTime) + opened.info.startTimestamp
        const wrapped = await opened.sink.getCanvas(sourceTime)
        const thumbCanvas = new OffscreenCanvas(720, 405)
        const thumbContext = thumbCanvas.getContext('2d', { alpha: false })
        if (thumbContext) {
          renderFrame({
            ctx: thumbContext as unknown as CanvasRenderingContext2D,
            width: 720,
            height: 405,
            project,
            duration,
            time: thumbTime,
            overlays: project.overlays,
            images,
            frame: wrapped
              ? {
                  image: wrapped.canvas as unknown as CanvasImageSource,
                  width: wrapped.canvas.width,
                  height: wrapped.canvas.height,
                }
              : null,
            showSelection: false,
          })
          thumbnailBlob = await thumbCanvas.convertToBlob({
            type: 'image/webp',
            quality: 0.82,
          })
        }
      }
    }

    // Señala el fin de cada pista antes de finalizar para reducir buffering.
    try {
      videoSource.close()
    } catch { /* puede ya estar cerrada */ }
    try {
      audioSource?.close()
    } catch { /* sin pista de audio */ }
    await output.finalize()
    const mimeType = await output.getMimeType().catch(() => null)
    const size = writer.close()
    output = null

    for (const bitmap of images.values()) bitmap.close()
    for (const opened of media.values()) opened.dispose()
    post({ type: 'done', result: { size, mimeType, thumbnail: thumbnailBlob } })
  } catch (error) {
    if (output) {
      await output.cancel().catch(() => undefined)
    }
    try {
      writer.abort()
    } catch { /* best-effort */ }
    for (const bitmap of images.values()) {
      try { bitmap.close() } catch { /* noop */ }
    }
    for (const opened of media.values()) {
      try { opened.dispose() } catch { /* noop */ }
    }
    if (canceled || (error instanceof DOMException && error.name === 'AbortError')) {
      post({ type: 'canceled' })
    } else {
      post({ type: 'error', error: errorMessage(error) })
    }
  }
}

scope.addEventListener('message', (event: MessageEvent<ExportMainMessage>) => {
  const message = event.data
  if (message.type === 'cancel') {
    canceled = true
    return
  }
  if (message.type === 'start') {
    if (running) {
      post({ type: 'error', error: 'El worker ya está exportando.' })
      return
    }
    running = true
    canceled = false
    void runExport(message).finally(() => {
      running = false
    })
  }
})

post({ type: 'ready' })
