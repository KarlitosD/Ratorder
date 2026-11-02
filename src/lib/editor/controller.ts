import type { RecordingMetadata } from '../types'
import type { RecordingStore } from '../storage/recording-store'
import { exportEditedRecording } from './export'
import { EditorPlayer } from './player'
import {
  addClipFromAsset,
  addOverlay,
  clamp,
  cloneProject,
  createDefaultProject,
  createId,
  createOverlay,
  deleteClip,
  EditorHistory,
  layoutTimeline,
  normalizeProject,
  parseEditorProject,
  projectDuration,
  removeOverlay,
  setClipMuted,
  setClipSpeed,
  setClipVolume,
  splitAt,
  toggleMute,
  trimClip,
  updateOverlay,
  type TrimEdge,
} from './model'
import {
  computeAudioWaveform,
  imageExtensionFor,
  isSupportedImageFile,
  isSupportedVideoFile,
  probeImage,
  probeMedia,
  videoExtensionFor,
} from './media'
import {
  readWaveformCache,
  waveformSafeName,
  writeWaveformCache,
} from './waveform-cache'
import type {
  EditorAsset,
  EditorExportState,
  EditorOverlayKind,
  EditorOverlayPatch,
  EditorProject,
  EditorSelection,
  EditorSnapshot,
  EditorSourceInfo,
  EditorWaveform,
} from './types'

type NoticeKind = 'info' | 'success' | 'warning' | 'error'

interface EditorControllerDeps {
  store: RecordingStore
  recording: RecordingMetadata
  onNotice?: (message: string, kind: NoticeKind) => void
  onExported?: (recording: RecordingMetadata) => void
  onBusyChange?: (busy: boolean) => void
  onDirtyChange?: (dirty: boolean) => void
}

const INITIAL_EXPORT_STATE: EditorExportState = {
  phase: 'idle',
  progress: 0,
  message: '',
  error: null,
  result: null,
}

const INITIAL_SNAPSHOT: EditorSnapshot = {
  status: 'loading',
  error: null,
  project: null,
  playhead: 0,
  playing: false,
  previewRate: 1,
  waveforms: {},
  waveformRevision: 0,
  selection: null,
  zoom: 80,
  duration: 0,
  importBusy: false,
  exportState: { ...INITIAL_EXPORT_STATE },
  canUndo: false,
  canRedo: false,
  savedAt: null,
  dirty: false,
  saving: false,
}

function projectSignature(project: EditorProject): string {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...content } = project
  return JSON.stringify(content)
}

function isOriginalProject(
  project: EditorProject,
  source: EditorSourceInfo,
): boolean {
  if (project.assets.length > 0 || project.overlays.length > 0) return false
  if (project.clips.length !== 1) return false
  const clip = project.clips[0]
  return (
    clip.mediaId === 'source' &&
    clip.speed === 1 &&
    Math.abs(clip.volume - 1) < 1e-3 &&
    !clip.muted &&
    Math.abs(clip.inPoint) < 1e-3 &&
    Math.abs(clip.sourceSpan - source.duration) < 1e-3
  )
}

export class EditorController {
  #deps: EditorControllerDeps
  #snapshot: EditorSnapshot = { ...INITIAL_SNAPSHOT }
  #listeners = new Set<(snapshot: EditorSnapshot) => void>()
  #project: EditorProject | null = null
  #baselineProject: EditorProject | null = null
  #history: EditorHistory | null = null
  #sourceFile: File | null = null
  #sourceInfo: EditorSourceInfo | null = null
  #images = new Map<string, ImageBitmap>()
  #sessionAssets = new Map<string, string>()
  #waveforms: Record<string, EditorWaveform> = {}
  #waveformRevision = 0
  #waveformAbort = new AbortController()
  #player: EditorPlayer
  #exportAbort: AbortController | null = null
  #disposed = false
  #initialized = false
  // Edición en vivo coalescada: un proyecto pendiente y un único flush por
  // rAF durante la interacción. Las lecturas usan el efectivo (pendiente ??
  // publicado) para que dos parches distintos no se sobrescriban.
  #pendingProject: EditorProject | null = null
  #pendingRaf = 0
  #baselineSignature: string | null = null
  #waveformQueue: Array<{
    mediaId: string
    file: File
    size: number
    expectedDuration: number
  }> = []
  #waveformActive = 0
  #waveformCacheBlocked = new Set<string>()
  #beforeUnloadHandler = (event: BeforeUnloadEvent) => {
    const exporting = ['preparing', 'exporting', 'finalizing'].includes(
      this.#snapshot.exportState.phase,
    )
    if (!exporting && !this.#snapshot.dirty && !this.#pendingProject) return
    event.preventDefault()
    event.returnValue = ''
  }

  constructor(deps: EditorControllerDeps) {
    this.#deps = deps
    this.#player = new EditorPlayer({
      getFile: (mediaId) => this.#getMediaFile(mediaId),
      getImages: () => this.#images,
      onTimeChange: (time, playing) => {
        this.#emit({ playhead: time, playing })
      },
      onPlayingChange: (playing) => {
        this.#emit({ playing })
      },
      onError: (message) => {
        this.#notice(message, 'error')
      },
    })
  }

  get snapshot(): EditorSnapshot {
    return this.#snapshot
  }

  subscribe(listener: (snapshot: EditorSnapshot) => void): () => void {
    this.#listeners.add(listener)
    listener(this.#snapshot)
    return () => this.#listeners.delete(listener)
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return
    this.#initialized = true
    this.#emit({ status: 'loading', error: null })
    try {
      const sourceFile = await this.#deps.store.getVideoFile(this.#deps.recording)
      this.#sourceFile = sourceFile
      const opened = await probeMedia(sourceFile)
      const info = opened.info
      opened.dispose()

      const sourceInfo: EditorSourceInfo = {
        duration: Math.max(0, info.duration),
        width: Math.max(2, info.width),
        height: Math.max(2, info.height),
        fps: this.#recordingFps(info.fps),
        container: this.#deps.recording.container,
        hasAudio: info.hasAudio,
        extension: this.#deps.recording.extension,
      }
      this.#sourceInfo = sourceInfo
      this.#startWaveform(
        'source',
        sourceFile,
        info.hasAudio,
        sourceInfo.duration,
      )

      let project = createDefaultProject({
        sourceId: this.#deps.recording.id,
        title: this.#deps.recording.title,
        source: sourceInfo,
      })
      let repairs: string[] = []
      const raw = await this.#deps.store.getEditorProject(
        this.#deps.recording.id,
      )
      const parsed = raw ? parseEditorProject(raw) : null
      const loadedSavedProject = Boolean(
        parsed && parsed.sourceId === this.#deps.recording.id,
      )
      if (parsed && parsed.sourceId === this.#deps.recording.id) {
        const restored = await this.#restoreAssets(parsed)
        const normalized = normalizeProject(parsed, {
          sourceInfo,
          mediaDurations: restored.mediaDurations,
          availableAssets: restored.assets,
        })
        project = normalized.project
        repairs = normalized.repairs
        if (project.clips.length === 0) {
          project = createDefaultProject({
            sourceId: this.#deps.recording.id,
            title: this.#deps.recording.title,
            source: sourceInfo,
          })
          if (repairs.length === 0) {
            repairs.push('La edición anterior no tenía segmentos; se reinició.')
          }
        }
      } else if (raw) {
        this.#notice(
          'El proyecto guardado no corresponde a esta grabación. Se abrió una edición nueva.',
          'warning',
        )
      }

      await this.#loadImages(project)
      if (this.#disposed) return
      this.#project = project
      this.#baselineProject = cloneProject(project)
      this.#baselineSignature = projectSignature(this.#baselineProject)
      this.#history = new EditorHistory(project)
      this.#player.setProject(project)
      const firstClip = project.clips[0]
      this.#emit({
        status: 'ready',
        error: null,
        project,
        duration: projectDuration(project),
        playhead: 0,
        selection: firstClip ? { type: 'clip', id: firstClip.id } : null,
        canUndo: false,
        canRedo: false,
        savedAt: loadedSavedProject ? Date.now() : null,
        dirty: false,
        saving: false,
      })
      window.addEventListener('beforeunload', this.#beforeUnloadHandler)
      void this.#player.syncPlayback()
      this.#deps.onDirtyChange?.(false)
      if (repairs.length > 0) {
        this.#notice(repairs.join(' '), 'warning')
      }
    } catch (error) {
      if (this.#disposed) return
      const message =
        error instanceof Error
          ? error.message
          : 'No se pudo abrir el editor de esta grabación.'
      this.#emit({ status: 'error', error: message })
      this.#notice(message, 'error')
    }
  }

  attachCanvas(canvas: HTMLCanvasElement): void {
    this.#player.attach(canvas)
    this.#player.setSelection(
      this.#snapshot.selection?.type === 'overlay'
        ? this.#snapshot.selection.id
        : null,
    )
  }

  setZoom(zoom: number): void {
    this.#emit({ zoom: clamp(zoom, 12, 240) })
  }

  setSelection(selection: EditorSelection): void {
    const effective = this.#effectiveProject()
    if (!effective || !selection) {
      this.#applySelection(null)
      return
    }
    const exists =
      selection.type === 'clip'
        ? effective.clips.some((clip) => clip.id === selection.id)
        : effective.overlays.some((overlay) => overlay.id === selection.id)
    this.#applySelection(exists ? selection : null)
  }

  selectClip(clipId: string): void {
    this.setSelection({ type: 'clip', id: clipId })
  }

  selectOverlay(overlayId: string): void {
    this.setSelection({ type: 'overlay', id: overlayId })
  }

  seek(time: number): void {
    if (!this.#project) return
    const duration = projectDuration(this.#project)
    const next = clamp(time, 0, duration)
    this.#player.seek(next)
    this.#emit({ playhead: next })
  }

  step(frames: number): void {
    if (!this.#project) return
    this.seek(this.#snapshot.playhead + frames / this.#project.fps)
  }

  async togglePlayback(): Promise<void> {
    await this.#player.toggle()
  }

  setPreviewRate(rate: number): void {
    const next = clamp(rate, 0.25, 2)
    this.#player.setPlaybackRate(next)
    this.#emit({ previewRate: next })
  }

  pause(): void {
    this.#player.pause()
  }

  #effectiveProject(): EditorProject | null {
    return this.#pendingProject ?? this.#project
  }

  #scheduleLiveFlush(): void {
    if (this.#pendingRaf || this.#disposed) return
    this.#pendingRaf = requestAnimationFrame(() => {
      this.#pendingRaf = 0
      this.#flushLive()
    })
  }

  #flushLive(): void {
    if (!this.#pendingProject || this.#disposed) return
    const next = this.#pendingProject
    this.#pendingProject = null
    this.#apply(next, { commit: false, sync: false })
  }

  #flushLiveSync(): void {
    if (this.#pendingRaf) {
      cancelAnimationFrame(this.#pendingRaf)
      this.#pendingRaf = 0
    }
    if (this.#pendingProject && !this.#disposed) {
      const next = this.#pendingProject
      this.#pendingProject = null
      this.#apply(next, { commit: false, sync: false })
    }
  }

  #cancelPending(): void {
    if (this.#pendingRaf) {
      cancelAnimationFrame(this.#pendingRaf)
      this.#pendingRaf = 0
    }
    this.#pendingProject = null
  }

  splitAtPlayhead(): void {
    this.#flushLiveSync()
    if (!this.#project) return
    const next = splitAt(this.#project, this.#snapshot.playhead)
    if (next === this.#project) {
      this.#notice('No se puede dividir tan cerca de un borde.', 'info')
      return
    }
    this.#apply(next, { sync: false })
    this.#notice('Segmento dividido.', 'success')
  }

  toggleMuteSelected(): void {
    this.#flushLiveSync()
    if (!this.#project) return
    const clipId = this.#selectedClipId()
    if (!clipId) {
      this.#notice('Selecciona un segmento para silenciarlo.', 'info')
      return
    }
    const clip = this.#project.clips.find((item) => item.id === clipId)
    if (!clip) return
    if (clip.muted || clip.volume <= 0) {
      let next = setClipMuted(this.#project, clipId, false)
      if (clip.volume <= 0) next = setClipVolume(next, clipId, 1)
      this.#apply(next, { sync: true })
    } else {
      this.#apply(toggleMute(this.#project, clipId), { sync: true })
    }
  }

  setSelectedSpeed(speed: number): void {
    this.#flushLiveSync()
    if (!this.#project) return
    const clipId = this.#selectedClipId()
    if (!clipId) return
    this.#apply(setClipSpeed(this.#project, clipId, speed), { sync: true })
  }

  setSelectedVolumeLive(volume: number): void {
    const effective = this.#effectiveProject()
    if (!effective) return
    const clipId = this.#selectedClipId()
    if (!clipId) return
    let next = setClipVolume(effective, clipId, volume)
    const clip = effective.clips.find((item) => item.id === clipId)
    if (volume > 0 && clip?.muted) {
      next = setClipMuted(next, clipId, false)
    }
    this.updateProjectLive(next)
  }

  deleteSelection(): void {
    this.#flushLiveSync()
    if (!this.#project) return
    const selection = this.#snapshot.selection
    if (!selection) return
    if (selection.type === 'clip') {
      const next = deleteClip(this.#project, selection.id)
      if (next === this.#project) return
      this.#applySelection(null)
      this.#apply(next, { sync: true })
    } else {
      const next = removeOverlay(this.#project, selection.id)
      if (next === this.#project) return
      this.#applySelection(null)
      this.#apply(next, { sync: true })
    }
  }

  updateProjectLive(next: EditorProject): void {
    if (!this.#project || next === this.#project) return
    // Reemplaza el pendiente por el estado completo actualizado y programa
    // un único flush. No crea snapshots de historial por pointermove.
    this.#pendingProject = next
    this.#scheduleLiveFlush()
  }

  previewTrimClip(clipId: string, edge: TrimEdge, delta: number): void {
    const effective = this.#effectiveProject()
    if (!effective) return
    this.updateProjectLive(trimClip(effective, clipId, edge, delta))
  }

  commitInteraction(): void {
    this.#flushLiveSync()
    if (!this.#project || !this.#history) return
    this.#history.commit(this.#project)
    this.#emit({
      canUndo: this.#history.canUndo,
      canRedo: this.#history.canRedo,
    })
    this.#updateDirty()
    if (this.#snapshot.playing) {
      void this.#player.syncPlayback()
    }
  }

  addOverlayKind(kind: EditorOverlayKind): void {
    this.#flushLiveSync()
    if (!this.#project) return
    const overlay = createOverlay(
      this.#project,
      kind,
      this.#snapshot.playhead,
    )
    const next = addOverlay(this.#project, overlay)
    this.#apply(next, { sync: false })
    this.#applySelection({ type: 'overlay', id: overlay.id })
  }

  updateOverlayLive(
    overlayId: string,
    patch: EditorOverlayPatch,
  ): void {
    const effective = this.#effectiveProject()
    if (!effective) return
    this.updateProjectLive(
      updateOverlay(effective, overlayId, patch),
    )
  }

  updateOverlayDiscrete(
    overlayId: string,
    patch: EditorOverlayPatch,
  ): void {
    this.#flushLiveSync()
    if (!this.#project) return
    this.#apply(updateOverlay(this.#project, overlayId, patch), {
      sync: false,
    })
  }

  removeSelectedOverlay(): void {
    this.#flushLiveSync()
    if (!this.#project) return
    const selection = this.#snapshot.selection
    if (selection?.type !== 'overlay') return
    this.#applySelection(null)
    this.#apply(removeOverlay(this.#project, selection.id), { sync: false })
  }

  async importVideos(files: File[]): Promise<void> {
    this.#flushLiveSync()
    if (!this.#project || this.#snapshot.importBusy) return
    this.#emit({ importBusy: true })
    try {
      for (const file of files) {
        try {
          if (!isSupportedVideoFile(file)) {
            throw new Error('Por ahora solo se pueden importar videos MP4 o WebM.')
          }
          await this.#ensureSpace(file.size)
          const opened = await probeMedia(file, { skipFrameRate: true })
          const info = opened.info
          opened.dispose()
          if (info.duration <= 0) {
            throw new Error('El video no tiene una duración utilizable.')
          }
          const assetId = createId('asset')
          const extension = videoExtensionFor(file)
          const storedName = `${assetId}.${extension}`
          await this.#deps.store.saveEditorAsset(
            this.#deps.recording.id,
            storedName,
            file,
          )
          this.#sessionAssets.set(assetId, storedName)
          const asset: EditorAsset = {
            id: assetId,
            kind: 'video',
            name: file.name || 'Video importado',
            storedName,
            extension,
            mimeType: file.type || `video/${extension}`,
            size: file.size,
            duration: info.duration,
            width: info.width,
            height: info.height,
            hasAudio: info.hasAudio,
          }
          const withAsset: EditorProject = {
            ...this.#project,
            assets: [...this.#project.assets, asset],
            updatedAt: new Date().toISOString(),
          }
          const next = addClipFromAsset(withAsset, assetId)
          this.#apply(next, { sync: true })
          this.#startWaveform(asset.id, file, asset.hasAudio, asset.duration)
          this.#notice(`“${asset.name}” se añadió a la línea de tiempo.`, 'success')
        } catch (error) {
          this.#notice(
            error instanceof Error
              ? error.message
              : 'No se pudo importar el video.',
            'error',
          )
        }
      }
    } finally {
      this.#emit({ importBusy: false })
    }
  }

  async importImage(file: File): Promise<void> {
    this.#flushLiveSync()
    if (!this.#project || this.#snapshot.importBusy) return
    this.#emit({ importBusy: true })
    try {
      if (!isSupportedImageFile(file)) {
        throw new Error('Usa una imagen PNG, JPEG o WebP.')
      }
      await this.#ensureSpace(file.size)
      const probed = await probeImage(file)
      const assetId = createId('asset')
      const extension = imageExtensionFor(file)
      const storedName = `${assetId}.${extension}`
      await this.#deps.store.saveEditorAsset(
        this.#deps.recording.id,
        storedName,
        file,
      )
      this.#sessionAssets.set(assetId, storedName)
      const asset: EditorAsset = {
        id: assetId,
        kind: 'image',
        name: file.name || 'Imagen',
        storedName,
        extension,
        mimeType: file.type || `image/${extension}`,
        size: file.size,
        duration: 0,
        width: probed.width,
        height: probed.height,
        hasAudio: false,
      }
      this.#images.set(assetId, probed.bitmap)
      const withAsset: EditorProject = {
        ...this.#project,
        assets: [...this.#project.assets, asset],
        updatedAt: new Date().toISOString(),
      }
      const overlay = createOverlay(
        withAsset,
        'image',
        this.#snapshot.playhead,
        assetId,
      )
      const next = addOverlay(withAsset, overlay)
      this.#apply(next, { sync: false })
      this.#applySelection({ type: 'overlay', id: overlay.id })
      this.#notice(`“${asset.name}” se añadió al video.`, 'success')
    } catch (error) {
      this.#notice(
        error instanceof Error
          ? error.message
          : 'No se pudo importar la imagen.',
        'error',
      )
    } finally {
      this.#emit({ importBusy: false })
    }
  }

  undo(): void {
    // Si hay una interacción aún no comprometida, cerrarla como una única
    // entrada antes de retroceder para que redo restaure su estado final.
    if (this.#pendingProject) {
      this.#flushLiveSync()
      if (this.#project) this.#history?.commit(this.#project)
    }
    const next = this.#history?.undo()
    if (!next) return
    this.#restoreProject(next)
  }

  redo(): void {
    this.#flushLiveSync()
    const next = this.#history?.redo()
    if (!next) return
    this.#restoreProject(next)
  }

  async exportNow(title?: string): Promise<void> {
    this.#flushLiveSync()
    if (!this.#project || !this.#history) return
    const phase = this.#snapshot.exportState.phase
    if (phase !== 'idle' && phase !== 'done' && phase !== 'error' && phase !== 'canceled') {
      return
    }
    const duration = projectDuration(this.#project)
    if (duration <= 0) {
      this.#notice('Añade al menos un segmento antes de exportar.', 'warning')
      return
    }

    this.#player.pause()
    this.#player.suspend()
    this.#exportAbort = new AbortController()
    this.#deps.onBusyChange?.(true)
    this.#emit({
      exportState: {
        phase: 'preparing',
        progress: 0,
        message: 'Preparando la exportación',
        error: null,
        result: null,
      },
    })

    try {
      const result = await exportEditedRecording(
        cloneProject(this.#effectiveProject() ?? this.#project),
        {
          store: this.#deps.store,
          getSourceFile: () => this.#getMediaFile('source'),
          getAssetFile: (assetId) => this.#getMediaFile(assetId),
        },
        {
          sourceRecording: this.#deps.recording,
          title,
          signal: this.#exportAbort.signal,
          onProgress: (progress, message) => {
            this.#emit({
              exportState: {
                phase: 'exporting',
                progress,
                message,
                error: null,
                result: null,
              },
            })
          },
        },
      )
      this.#emit({
        exportState: {
          phase: 'done',
          progress: 1,
          message: 'Copia editada guardada',
          error: null,
          result: result.metadata,
        },
      })
      this.#deps.onExported?.(result.metadata)
      this.#notice('Copia editada guardada en la biblioteca.', 'success')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        this.#emit({
          exportState: {
            phase: 'canceled',
            progress: 0,
            message: 'Exportación cancelada',
            error: null,
            result: null,
          },
        })
        this.#notice('Exportación cancelada. El original no cambió.', 'info')
      } else {
        const message =
          error instanceof Error
            ? error.message
            : 'No se pudo exportar la edición.'
        this.#emit({
          exportState: {
            phase: 'error',
            progress: 0,
            message: 'La exportación falló',
            error: message,
            result: null,
          },
        })
        this.#notice(message, 'error')
      }
    } finally {
      this.#exportAbort = null
      this.#deps.onBusyChange?.(false)
      this.#player.resume()
    }
  }

  cancelExport(): void {
    this.#exportAbort?.abort()
    this.#emit({
      exportState: {
        ...this.#snapshot.exportState,
        message: 'Cancelando la exportación',
      },
    })
  }

  resetExportState(): void {
    if (
      ['preparing', 'exporting', 'finalizing'].includes(
        this.#snapshot.exportState.phase,
      )
    ) {
      return
    }
    this.#emit({ exportState: { ...INITIAL_EXPORT_STATE } })
  }

  async saveNow(): Promise<boolean> {
    this.#flushLiveSync()
    if (!this.#project || this.#disposed) return false
    if (this.#snapshot.saving) return false
    const snapshotProject = cloneProject(this.#project)
    this.#emit({ saving: true })
    try {
      await this.#deps.store.saveEditorProject(
        this.#deps.recording.id,
        snapshotProject,
      )
      this.#baselineProject = snapshotProject
      this.#baselineSignature = projectSignature(snapshotProject)
      this.#emit({
        savedAt: Date.now(),
        saving: false,
      })
      this.#updateDirty()
      return true
    } catch (error) {
      this.#emit({ saving: false })
      this.#notice(
        error instanceof Error
          ? `No se pudo guardar el proyecto: ${error.message}`
          : 'No se pudo guardar el proyecto de edición.',
        'warning',
      )
      return false
    }
  }

  discardChanges(): void {
    this.#cancelPending()
    if (!this.#project || !this.#baselineProject) return
    const next = cloneProject(this.#baselineProject)
    this.#history?.reset(next)
    this.#project = next
    this.#player.setProject(next)
    this.#player.setSelection(null)
    const firstClip = next.clips[0]
    const duration = projectDuration(next)
    this.#emit({
      project: next,
      duration,
      playhead: Math.min(this.#snapshot.playhead, duration),
      selection: firstClip ? { type: 'clip', id: firstClip.id } : null,
      canUndo: false,
      canRedo: false,
      dirty: false,
    })
    this.#deps.onDirtyChange?.(false)
    void this.#cleanupUnsavedAssets()
    this.#notice('Cambios descartados.', 'info')
  }

  resetToOriginal(): void {
    this.#flushLiveSync()
    if (!this.#sourceInfo) return
    this.#player.pause()
    const baselineIsOriginal =
      this.#baselineProject !== null &&
      isOriginalProject(this.#baselineProject, this.#sourceInfo)
    const next = baselineIsOriginal
      ? cloneProject(this.#baselineProject as EditorProject)
      : createDefaultProject({
          sourceId: this.#deps.recording.id,
          title: this.#deps.recording.title,
          source: this.#sourceInfo,
        })
    this.#apply(next, { sync: false })
    const firstClip = next.clips[0]
    this.#applySelection(
      firstClip ? { type: 'clip', id: firstClip.id } : null,
    )
    this.#player.seek(0)
    this.#emit({ playhead: 0 })
    this.#notice('Edición restablecida al video original.', 'info')
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    // Dispose nunca guarda ni hace commit implícito: se descarta el pendiente.
    this.#cancelPending()
    window.removeEventListener('beforeunload', this.#beforeUnloadHandler)
    this.#exportAbort?.abort()
    this.#waveformAbort.abort()
    this.#deps.onBusyChange?.(false)
    this.#player.dispose()
    for (const bitmap of this.#images.values()) bitmap.close()
    this.#images.clear()
    void this.#cleanupUnsavedAssets()
    this.#listeners.clear()
  }

  #apply(
    next: EditorProject,
    options: { commit?: boolean; sync?: boolean } = {},
  ): void {
    if (!this.#project || next === this.#project) return
    const { commit = true, sync = false } = options
    this.#project = next
    if (commit) this.#history?.commit(next)
    this.#player.setProject(next)
    this.#player.setSelection(
      this.#snapshot.selection?.type === 'overlay'
        ? this.#snapshot.selection.id
        : null,
    )
    const duration = projectDuration(next)
    const playhead = clamp(this.#snapshot.playhead, 0, duration)
    this.#clampSelection(next)
    this.#emit({
      project: next,
      duration,
      playhead,
      canUndo: this.#history?.canUndo ?? false,
      canRedo: this.#history?.canRedo ?? false,
    })
    this.#updateDirty()
    if (sync && this.#snapshot.playing) {
      void this.#player.syncPlayback()
    }
  }

  #restoreProject(project: EditorProject): void {
    this.#cancelPending()
    this.#project = project
    this.#player.setProject(project)
    const duration = projectDuration(project)
    const playhead = clamp(this.#snapshot.playhead, 0, duration)
    this.#clampSelection(project)
    this.#emit({
      project,
      duration,
      playhead,
      canUndo: this.#history?.canUndo ?? false,
      canRedo: this.#history?.canRedo ?? false,
    })
    this.#updateDirty()
    if (this.#snapshot.playing) {
      void this.#player.syncPlayback()
    }
  }

  #applySelection(selection: EditorSelection): void {
    this.#emit({ selection })
    this.#player.setSelection(
      selection?.type === 'overlay' ? selection.id : null,
    )
  }

  #clampSelection(project: EditorProject): void {
    const selection = this.#snapshot.selection
    if (!selection) return
    const exists =
      selection.type === 'clip'
        ? project.clips.some((clip) => clip.id === selection.id)
        : project.overlays.some((overlay) => overlay.id === selection.id)
    if (!exists) this.#emit({ selection: null })
  }

  #selectedClipId(): string | null {
    const selection = this.#snapshot.selection
    if (selection?.type === 'clip') return selection.id
    const effective = this.#effectiveProject()
    if (!effective) return null
    const view = layoutTimeline(effective).find(
      (item) =>
        this.#snapshot.playhead >= item.start &&
        this.#snapshot.playhead < item.end,
    )
    return view?.clip.id ?? effective.clips[0]?.id ?? null
  }

  #updateDirty(): void {
    const project = this.#effectiveProject()
    if (!project || !this.#baselineProject) return
    if (this.#baselineSignature === null) {
      this.#baselineSignature = projectSignature(this.#baselineProject)
    }
    // Firma exacta una vez por flush, no por cada pointermove.
    const dirty =
      projectSignature(project) !== this.#baselineSignature
    if (dirty === this.#snapshot.dirty) return
    this.#emit({ dirty })
    this.#deps.onDirtyChange?.(dirty)
  }

  #startWaveform(
    mediaId: string,
    file: File,
    hasAudio: boolean,
    expectedDuration = 0,
  ): void {
    if (this.#disposed || this.#waveforms[mediaId]) return
    if (!hasAudio) {
      this.#publishWaveform(mediaId, {
        bins: new Float32Array(0),
        duration: 0,
        loading: false,
        hasAudio: false,
      })
      return
    }
    this.#publishWaveform(mediaId, {
      bins: new Float32Array(0),
      duration: 0,
      loading: true,
      hasAudio: true,
    })
    const job = {
      mediaId,
      file,
      size: file.size,
      expectedDuration,
    }
    // Prioridad: la fuente primero; después assets en orden de proyecto.
    if (mediaId === 'source') this.#waveformQueue.unshift(job)
    else this.#waveformQueue.push(job)
    this.#pumpWaveforms()
  }

  #pumpWaveforms(): void {
    while (
      this.#waveformActive < 2 &&
      this.#waveformQueue.length > 0 &&
      !this.#disposed &&
      !this.#waveformAbort.signal.aborted
    ) {
      const job = this.#waveformQueue.shift()
      if (!job) return
      this.#waveformActive += 1
      void this.#runWaveformJob(job).finally(() => {
        this.#waveformActive -= 1
        this.#pumpWaveforms()
      })
    }
  }

  async #runWaveformJob(job: {
    mediaId: string
    file: File
    size: number
    expectedDuration: number
  }): Promise<void> {
    const signal = this.#waveformAbort.signal
    if (this.#disposed || signal.aborted) return
    const { mediaId } = job
    // 1) Intenta la caché antes de decodificar.
    try {
      const cached = await readWaveformCache(
        this.#deps.store,
        this.#deps.recording.id,
        mediaId,
        { size: job.size, duration: job.expectedDuration },
      )
      if (this.#disposed || signal.aborted) return
      if (cached && !this.#waveformCacheBlocked.has(mediaId)) {
        this.#publishWaveform(mediaId, {
          bins: cached.bins,
          duration: cached.duration,
          loading: false,
          hasAudio: true,
        })
        return
      }
    } catch {
      // Un fallo de caché no bloquea el análisis.
    }
    if (this.#disposed || signal.aborted) return
    let result: { bins: Float32Array; duration: number } | null = null
    try {
      result = await computeAudioWaveform(job.file, { signal })
    } catch (error) {
      if (
        this.#disposed ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        return
      }
      this.#publishWaveform(mediaId, {
        bins: new Float32Array(0),
        duration: 0,
        loading: false,
        hasAudio: false,
      })
      return
    }
    if (this.#disposed || signal.aborted) return
    this.#publishWaveform(
      mediaId,
      result
        ? {
            bins: result.bins,
            duration: result.duration,
            loading: false,
            hasAudio: true,
          }
        : {
            bins: new Float32Array(0),
            duration: 0,
            loading: false,
            hasAudio: false,
          },
    )
    // 2) Persiste la caché en segundo plano sin bloquear la edición.
    if (result && result.bins.length > 0 && result.duration > 0) {
      const bins = result.bins
      const duration = result.duration
      const size = job.size
      const recordingId = this.#deps.recording.id
      void (async () => {
        try {
          if (this.#disposed || signal.aborted) return
          if (this.#waveformCacheBlocked.has(mediaId)) return
          if (!this.#isWaveformMediaKnown(mediaId)) return
          await writeWaveformCache(this.#deps.store, recordingId, mediaId, {
            bins,
            duration,
            mediaSize: size,
          })
        } catch {
          // Un fallo de escritura no afecta a la edición.
        }
      })()
    }
  }

  #isWaveformMediaKnown(mediaId: string): boolean {
    if (mediaId === 'source') return true
    const effective = this.#effectiveProject()
    return Boolean(effective?.assets.some((asset) => asset.id === mediaId))
  }

  #publishWaveform(mediaId: string, waveform: EditorWaveform): void {
    if (this.#disposed) return
    this.#waveforms = { ...this.#waveforms, [mediaId]: waveform }
    this.#waveformRevision += 1
    this.#emit({
      waveforms: this.#waveforms,
      waveformRevision: this.#waveformRevision,
    })
  }

  async #cleanupUnsavedAssets(): Promise<void> {
    if (this.#sessionAssets.size === 0) return
    const baselineAssets = new Set(
      this.#baselineProject?.assets.map((asset) => asset.id) ?? [],
    )
    for (const [assetId, storedName] of Array.from(
      this.#sessionAssets.entries(),
    )) {
      if (baselineAssets.has(assetId)) continue
      this.#sessionAssets.delete(assetId)
      // Evita que una escritura tardía recree la caché tras eliminarla.
      this.#waveformCacheBlocked.add(assetId)
      this.#waveformQueue = this.#waveformQueue.filter(
        (job) => job.mediaId !== assetId,
      )
      const { [assetId]: _removed, ...rest } = this.#waveforms
      void _removed
      this.#waveforms = rest
      const bitmap = this.#images.get(assetId)
      if (bitmap) {
        bitmap.close()
        this.#images.delete(assetId)
      }
      await this.#deps.store
        .deleteEditorAsset(this.#deps.recording.id, storedName)
        .catch(() => undefined)
      await this.#deps.store
        .deleteWaveform(this.#deps.recording.id, waveformSafeName(assetId))
        .catch(() => undefined)
    }
  }

  async #getMediaFile(mediaId: string): Promise<File> {
    if (mediaId === 'source') {
      if (!this.#sourceFile) {
        this.#sourceFile = await this.#deps.store.getVideoFile(
          this.#deps.recording,
        )
      }
      return this.#sourceFile
    }
    const project = this.#effectiveProject()
    const asset = project?.assets.find((item) => item.id === mediaId)
    if (!asset) throw new Error('No se encontró el medio importado.')
    return this.#deps.store.getEditorAssetFile(
      this.#deps.recording.id,
      asset.storedName,
    )
  }

  async #restoreAssets(project: EditorProject): Promise<{
    assets: EditorAsset[]
    mediaDurations: Record<string, number>
  }> {
    const assets: EditorAsset[] = []
    const mediaDurations: Record<string, number> = {}
    const rawAssets = Array.isArray(project.assets) ? project.assets : []
    for (const value of rawAssets) {
      if (
        !value ||
        typeof value !== 'object' ||
        typeof value.storedName !== 'string' ||
        (value.kind !== 'video' && value.kind !== 'image')
      ) {
        continue
      }
      const asset = value
      try {
        const file = await this.#deps.store.getEditorAssetFile(
          this.#deps.recording.id,
          asset.storedName,
        )
        if (asset.kind === 'video') {
          const opened = await probeMedia(file, { skipFrameRate: true })
          const info = opened.info
          opened.dispose()
          const next: EditorAsset = {
            ...asset,
            size: file.size,
            duration: info.duration,
            width: info.width,
            height: info.height,
            hasAudio: info.hasAudio,
            mimeType: file.type || asset.mimeType,
          }
          assets.push(next)
          mediaDurations[next.id] = next.duration
          this.#startWaveform(next.id, file, next.hasAudio, next.duration)
        } else if (asset.kind === 'image') {
          const probed = await probeImage(file)
          if (this.#disposed) {
            probed.bitmap.close()
            return { assets: [], mediaDurations: {} }
          }
          this.#images.set(asset.id, probed.bitmap)
          assets.push({
            ...asset,
            size: file.size,
            width: probed.width,
            height: probed.height,
            mimeType: file.type || asset.mimeType,
          })
        }
      } catch {
        this.#notice(
          `No se encontró el medio “${asset.name}”; se quitó de la edición.`,
          'warning',
        )
      }
    }
    return { assets, mediaDurations }
  }

  async #loadImages(project: EditorProject): Promise<void> {
    for (const asset of project.assets) {
      if (asset.kind !== 'image' || this.#images.has(asset.id)) continue
      try {
        const file = await this.#deps.store.getEditorAssetFile(
          this.#deps.recording.id,
          asset.storedName,
        )
        const bitmap = await createImageBitmap(file)
        if (this.#disposed) {
          bitmap.close()
          return
        }
        this.#images.set(asset.id, bitmap)
      } catch {
        this.#notice(
          `No se pudo cargar la imagen “${asset.name}”.`,
          'warning',
        )
      }
    }
  }

  async #ensureSpace(bytes: number): Promise<void> {
    try {
      const estimate = await navigator.storage?.estimate?.()
      if (!estimate?.quota) return
      const usage = estimate.usage ?? 0
      if (usage + bytes > estimate.quota * 0.95) {
        throw new Error(
          'No hay suficiente espacio local para importar este archivo.',
        )
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('espacio')) {
        throw error
      }
    }
  }

  #recordingFps(fallback: number): number {
    const fps = this.#deps.recording.fps || fallback || 30
    return clamp(Math.round(fps), 1, 120)
  }

  #notice(message: string, kind: NoticeKind): void {
    this.#deps.onNotice?.(message, kind)
  }

  #emit(patch: Partial<EditorSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch }
    for (const listener of this.#listeners) {
      listener(this.#snapshot)
    }
  }
}
