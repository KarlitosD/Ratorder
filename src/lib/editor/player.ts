import {
  createDiagnosticUrl,
  revokeDiagnosticUrl,
  trackResource,
} from '../diagnostics/resources'
import { renderFrame } from './compositor'
import {
  findClipAt,
  findClipIndexAt,
  layoutTimeline,
  MAX_VOLUME,
  projectDuration,
  sourceTimeForView,
} from './model'
import type {
  EditorClip,
  EditorProject,
  TimelineClipView,
} from './types'

interface PreviewMedia {
  mediaId: string
  element: HTMLVideoElement
  url: string
  ready: Promise<void>
  source?: MediaElementAudioSourceNode
  gain?: GainNode
}

interface PlayerDependencies {
  getFile: (mediaId: string) => Promise<File>
  getImages: () => Map<string, ImageBitmap>
  onTimeChange?: (time: number, playing: boolean) => void
  onPlayingChange?: (playing: boolean) => void
  onError?: (message: string) => void
}

const SEEK_TIMEOUT_MS = 1600
const DRIFT_TOLERANCE = 0.25
const MAX_LOADED_MEDIA = 3

function clipsAffectPlayback(
  previous: EditorProject | null,
  next: EditorProject,
): boolean {
  if (!previous) return true
  if (previous.clips.length !== next.clips.length) return true
  if (previous.source.duration !== next.source.duration) return true
  for (let index = 0; index < next.clips.length; index += 1) {
    const a = previous.clips[index]
    const b = next.clips[index]
    if (!a || !b) return true
    if (
      a.id !== b.id ||
      a.mediaId !== b.mediaId ||
      a.inPoint !== b.inPoint ||
      a.sourceSpan !== b.sourceSpan ||
      a.speed !== b.speed
    ) {
      return true
    }
  }
  return false
}

function preparedStillValid(
  prepared: { clipId: string; mediaId: string } | null,
  project: EditorProject,
): boolean {
  if (!prepared) return false
  const view = layoutTimeline(project).find(
    (item) => item.clip.id === prepared.clipId,
  )
  return Boolean(view && view.clip.mediaId === prepared.mediaId)
}

export class EditorPlayer {
  #deps: PlayerDependencies
  #project: EditorProject | null = null
  #cachedDuration = 0
  #canvas: HTMLCanvasElement | null = null
  #ctx: CanvasRenderingContext2D | null = null
  #media = new Map<string, PreviewMedia>()
  #lru: string[] = []
  #pendingMedia = new Map<string, Promise<PreviewMedia>>()
  #generation = 0
  #activeMediaId: string | null = null
  #activeClipId: string | null = null
  #activeSourceEnd = 0
  #prepared: {
    clipId: string
    mediaId: string
    element: HTMLVideoElement
  } | null = null
  #preparingClipId: string | null = null
  #pendingClipId: string | null = null
  #time = 0
  #playing = false
  #anchor = 0
  #playbackRate = 1
  #raf = 0
  #lastPublish = 0
  #lastDriftCheck = 0
  #seekToken = 0
  #selectedOverlayId: string | null = null
  #audioContext: AudioContext | null = null
  #releaseAudioContext: (() => void) | null = null
  #disposed = false
  // Scheduler de composición: presupuesto por fps del proyecto y coalescing
  // de invalidaciones explícitas para no duplicar composiciones del mismo
  // estado en el mismo frame.
  #explicitRaf = 0
  #explicitPending = false
  #lastFrameWall = 0
  #drawCarry = 0
  #lastAudioKey: string | null = null
  #lastRateKey: string | null = null

  constructor(deps: PlayerDependencies) {
    this.#deps = deps
  }

  get time(): number {
    return this.#time
  }

  get playing(): boolean {
    return this.#playing
  }

  get duration(): number {
    return this.#cachedDuration
  }

  attach(canvas: HTMLCanvasElement): void {
    this.#canvas = canvas
    this.#ctx = canvas.getContext('2d')
    this.#resizeCanvas()
    this.#invalidate()
  }

  detach(): void {
    if (this.#explicitRaf) {
      cancelAnimationFrame(this.#explicitRaf)
      this.#explicitRaf = 0
    }
    this.#explicitPending = false
    this.#canvas = null
    this.#ctx = null
  }

  setSelection(overlayId: string | null): void {
    if (this.#selectedOverlayId === overlayId) return
    this.#selectedOverlayId = overlayId
    if (!this.#playing) this.#invalidate()
  }

  setProject(project: EditorProject): void {
    const previous = this.#project
    const previousDuration = this.#cachedDuration
    const previousSize = this.#previewSize()
    const playbackChanged = clipsAffectPlayback(previous, project)
    this.#project = project
    this.#cachedDuration = projectDuration(project)
    if (!playbackChanged) {
      // Solo cambiaron overlays u otros metadatos: conserva la preparación
      // del próximo clip y no reancla el reloj de reproducción.
      if (!preparedStillValid(this.#prepared, project)) {
        this.#prepared = null
      }
      if (
        this.#preparingClipId &&
        !layoutTimeline(project).some(
          (view) => view.clip.id === this.#preparingClipId,
        )
      ) {
        this.#preparingClipId = null
      }
    } else {
      this.#prepared = null
      this.#preparingClipId = null
      this.#pendingClipId = null
      this.#lastAudioKey = null
      this.#lastRateKey = null
    }
    const duration = this.#cachedDuration
    this.#time = Math.min(this.#time, duration)
    if (
      previousSize.width !== this.#previewSize().width ||
      previousSize.height !== this.#previewSize().height
    ) {
      this.#resizeCanvas()
    }
    if (this.#playing && duration <= 0) {
      this.pause()
    } else if (this.#playing && playbackChanged) {
      this.#anchor =
        performance.now() -
        (this.#time * 1000) / Math.max(0.25, this.#playbackRate)
      if (this.#activeClipId) {
        const active = project.clips.find(
          (clip) => clip.id === this.#activeClipId,
        )
        if (active) {
          this.#activeSourceEnd = active.inPoint + active.sourceSpan
        } else {
          this.#activeClipId = null
        }
      }
    }
    if (previousDuration !== duration && this.#time > duration) {
      this.#time = duration
    }
    const activeView = findClipAt(project, this.#time)
    const activeMedia = activeView
      ? this.#media.get(activeView.clip.mediaId)
      : null
    if (activeMedia && activeView) {
      this.#applyClipAudioIfChanged(activeMedia, activeView.clip)
    }
    this.#invalidate()
    this.#publish(performance.now(), true)
  }

  seek(time: number): void {
    if (!this.#project) return
    this.#time = Math.min(Math.max(0, time), this.#cachedDuration)
    this.#prepared = null
    this.#preparingClipId = null
    this.#pendingClipId = null
    if (this.#playing) {
      this.#anchor =
        performance.now() -
        (this.#time * 1000) / Math.max(0.25, this.#playbackRate)
    }
    this.#drawCarry = 0
    this.#invalidate(true)
    this.#publish(performance.now(), true)
    void this.#syncPlayback(true)
  }

  setPlaybackRate(rate: number): void {
    const next = Math.min(2, Math.max(0.25, rate))
    if (Math.abs(next - this.#playbackRate) < 1e-4) return
    if (this.#playing) {
      this.#time = this.#currentTime()
      this.#playbackRate = next
      this.#anchor =
        performance.now() - (this.#time * 1000) / this.#playbackRate
    } else {
      this.#playbackRate = next
    }
    this.#drawCarry = 0
    const project = this.#project
    const view = project ? findClipAt(project, this.#time) : null
    const media = view ? this.#media.get(view.clip.mediaId) : null
    if (view && media) {
      this.#applyRateIfChanged(media, view.clip)
    }
  }

  async play(): Promise<void> {
    if (!this.#project || this.#disposed) return
    const duration = this.#cachedDuration
    if (duration <= 0) return
    if (this.#time >= duration - 1e-4) this.#time = 0
    this.#playing = true
    this.#anchor =
      performance.now() -
      (this.#time * 1000) / Math.max(0.25, this.#playbackRate)
    if (this.#audioContext?.state === 'suspended') {
      await this.#audioContext.resume().catch(() => undefined)
    }
    this.#deps.onPlayingChange?.(true)
    await this.#syncPlayback(true)
    if (!this.#playing) return
    this.#startLoop()
    this.#publish(performance.now(), true)
  }

  pause(): void {
    this.#prepared = null
    this.#preparingClipId = null
    this.#pendingClipId = null
    if (!this.#playing) {
      this.#invalidate()
      return
    }
    this.#time = this.#currentTime()
    this.#playing = false
    this.#stopLoop()
    for (const media of this.#media.values()) {
      media.element.pause()
    }
    this.#invalidate(true)
    this.#publish(performance.now(), true)
    this.#deps.onPlayingChange?.(false)
  }

  async toggle(): Promise<void> {
    if (this.#playing) {
      this.pause()
    } else {
      await this.play()
    }
  }

  async syncPlayback(): Promise<void> {
    await this.#syncPlayback(true)
  }

  redraw(): void {
    this.#invalidate()
  }

  /** Dibuja de inmediato; uso interno y en tests que requieren el frame ya. */
  redrawNow(): void {
    this.#drawNow()
  }

  suspend(): void {
    this.#generation += 1
    this.pause()
    for (const media of this.#media.values()) {
      this.#releaseMedia(media)
    }
    this.#media.clear()
    this.#lru = []
    this.#pendingMedia.clear()
    this.#activeMediaId = null
    this.#activeClipId = null
    this.#activeSourceEnd = 0
    this.#prepared = null
    this.#preparingClipId = null
    this.#pendingClipId = null
    this.#lastAudioKey = null
    this.#lastRateKey = null
  }

  resume(): void {
    this.#invalidate()
    void this.#syncPlayback(true)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#generation += 1
    this.suspend()
    this.#disposed = true
    this.detach()
    this.#project = null
    void this.#audioContext?.close().catch(() => undefined)
    this.#audioContext = null
    this.#releaseAudioContext?.()
    this.#releaseAudioContext = null
  }

  #previewSize(): { width: number; height: number } {
    if (!this.#project) return { width: 1280, height: 720 }
    const longEdge = Math.max(this.#project.width, this.#project.height)
    const scale = longEdge > 1280 ? 1280 / longEdge : 1
    return {
      width: Math.max(2, Math.round(this.#project.width * scale)),
      height: Math.max(2, Math.round(this.#project.height * scale)),
    }
  }

  #resizeCanvas(): void {
    if (!this.#canvas) return
    const size = this.#previewSize()
    if (this.#canvas.width !== size.width) this.#canvas.width = size.width
    if (this.#canvas.height !== size.height) this.#canvas.height = size.height
    this.#ctx = this.#canvas.getContext('2d')
  }

  #currentTime(): number {
    if (!this.#playing) return this.#time
    const duration = this.#cachedDuration
    return Math.min(
      duration,
      ((performance.now() - this.#anchor) / 1000) * this.#playbackRate,
    )
  }

  #drawIntervalMs(): number {
    const fps = Math.max(1, Math.min(120, this.#project?.fps ?? 30))
    const target = fps * Math.min(1, this.#playbackRate)
    return 1000 / Math.max(1, target)
  }

  #invalidate(immediate = false): void {
    if (!this.#playing) {
      // Pausado: una edición/selección debe verse pronto, pero las
      // invalidaciones coincidentes del mismo frame se coalescen.
      if (immediate) {
        if (this.#explicitRaf) {
          cancelAnimationFrame(this.#explicitRaf)
          this.#explicitRaf = 0
        }
        this.#explicitPending = false
        this.#drawNow()
        return
      }
      if (this.#explicitRaf) return
      this.#explicitRaf = requestAnimationFrame(() => {
        this.#explicitRaf = 0
        this.#drawNow()
      })
      return
    }
    // Reproduciendo: el bucle aplica el presupuesto; marcar explícito para
    // no esperar al próximo intervalo si hubo edición/selección.
    this.#explicitPending = true
  }

  #drawNow(): void {
    if (!this.#ctx || !this.#canvas || !this.#project) return
    const project = this.#project
    const view = findClipAt(project, this.#time)
    const media = view ? this.#media.get(view.clip.mediaId) : null
    const element = media?.element
    renderFrame({
      ctx: this.#ctx,
      width: this.#canvas.width,
      height: this.#canvas.height,
      project,
      duration: this.#cachedDuration,
      time: this.#time,
      overlays: project.overlays,
      images: this.#deps.getImages(),
      frame:
        element && element.videoWidth > 0
          ? {
              image: element,
              width: element.videoWidth,
              height: element.videoHeight,
            }
          : null,
      selectedOverlayId: this.#selectedOverlayId,
      showSelection: true,
    })
  }

  #startLoop(): void {
    this.#stopLoop()
    this.#lastDriftCheck = performance.now()
    this.#lastFrameWall = performance.now()
    this.#drawCarry = 0
    this.#explicitPending = true
    const frame = (now: number) => {
      if (!this.#playing) return
      const duration = this.#cachedDuration
      const time = Math.min(
        duration,
        ((now - this.#anchor) / 1000) * this.#playbackRate,
      )
      this.#time = time
      const project = this.#project
      if (!project) return
      if (time >= duration - 1e-4) {
        this.#time = duration
        this.#drawNow()
        this.#publish(now, true)
        this.pause()
        return
      }

      const view = findClipAt(project, time)
      if (view) {
        const media = this.#media.get(view.clip.mediaId)
        if (media) {
          this.#applyClipAudioIfChanged(media, view.clip)
          this.#applyRateIfChanged(media, view.clip)
          if (view.clip.id !== this.#activeClipId) {
            const continuous =
              this.#activeMediaId === view.clip.mediaId &&
              Math.abs(view.clip.inPoint - this.#activeSourceEnd) < 0.05
            if (continuous) {
              this.#promoteContinuous(view, media)
            } else if (this.#pendingClipId !== view.clip.id) {
              this.#pendingClipId = view.clip.id
              void this.#syncPlayback(true)
            }
          } else if (now - this.#lastDriftCheck > 500) {
            this.#lastDriftCheck = now
            const expected = sourceTimeForView(view, time)
            if (Math.abs(media.element.currentTime - expected) > DRIFT_TOLERANCE) {
              void this.#seekElement(media.element, expected)
            }
          }
        } else if (this.#pendingClipId !== view.clip.id) {
          this.#pendingClipId = view.clip.id
          void this.#syncPlayback(true)
        }
        this.#maybePrepareNext(project, time, view)
      }

      // Presupuesto de dibujo: cadencia del proyecto reducida al reproducir
      // lento, con acumulador que conserva el resto. Sin ráfagas de
      // recuperación: como máximo un redraw por frame del monitor.
      const interval = this.#drawIntervalMs()
      const elapsed = Math.max(0, now - this.#lastFrameWall)
      this.#lastFrameWall = now
      this.#drawCarry = Math.min(this.#drawCarry + elapsed, interval * 3)
      if (this.#explicitPending || this.#drawCarry >= interval) {
        this.#explicitPending = false
        this.#drawCarry = this.#drawCarry >= interval
          ? Math.min(this.#drawCarry - interval, interval)
          : 0
        this.#drawNow()
      }
      this.#publish(now, false)
      this.#raf = requestAnimationFrame(frame)
    }
    this.#raf = requestAnimationFrame(frame)
  }

  #stopLoop(): void {
    if (this.#raf) {
      cancelAnimationFrame(this.#raf)
      this.#raf = 0
    }
  }

  #publish(now: number, force: boolean): void {
    if (!force && now - this.#lastPublish < 100) return
    this.#lastPublish = now
    this.#deps.onTimeChange?.(this.#time, this.#playing)
  }

  async #syncPlayback(forceSeek: boolean): Promise<void> {
    const project = this.#project
    if (!project || this.#disposed) return
    const view = findClipAt(project, this.#time)
    if (!view) {
      this.#pauseOthers(null)
      this.#activeMediaId = null
      this.#activeClipId = null
      this.#activeSourceEnd = 0
      this.#prepared = null
      this.#preparingClipId = null
      this.#pendingClipId = null
      return
    }

    let media: PreviewMedia
    try {
      media = await this.#ensureMedia(view.clip.mediaId)
    } catch (error) {
      this.#pendingClipId = null
      this.#deps.onError?.(
        error instanceof Error
          ? error.message
          : 'No se pudo abrir el medio de esta edición.',
      )
      this.pause()
      return
    }

    if (this.#disposed || this.#project !== project) return
    this.#pauseOthers(media.mediaId)
    this.#activeMediaId = media.mediaId
    this.#activeClipId = view.clip.id
    this.#activeSourceEnd = view.clip.inPoint + view.clip.sourceSpan

    const element = media.element
    this.#applyClipAudioIfChanged(media, view.clip)
    this.#applyRateIfChanged(media, view.clip)
    ;(element as HTMLVideoElement & { preservesPitch?: boolean }).preservesPitch = true

    const preparedMatch =
      this.#playing &&
      this.#prepared?.clipId === view.clip.id &&
      this.#prepared.mediaId === media.mediaId
    const expected = sourceTimeForView(view, this.#time)
    const distance = Math.abs(element.currentTime - expected)
    if (forceSeek && distance > (preparedMatch ? 0.15 : 0.04)) {
      await this.#seekElement(element, expected)
    }
    if (this.#prepared?.clipId === view.clip.id) {
      this.#prepared = null
    }
    if (this.#preparingClipId === view.clip.id) {
      this.#preparingClipId = null
    }
    this.#pendingClipId = null

    if (this.#playing && !this.#disposed) {
      try {
        await element.play()
      } catch {
        this.pause()
        this.#deps.onError?.(
          'El navegador no permitió reproducir el audio del editor.',
        )
      }
    }
    this.#invalidate()
  }

  #promoteContinuous(view: TimelineClipView, media: PreviewMedia): void {
    this.#activeMediaId = media.mediaId
    this.#activeClipId = view.clip.id
    this.#activeSourceEnd = view.clip.inPoint + view.clip.sourceSpan
    this.#pendingClipId = null
    const element = media.element
    this.#applyClipAudioIfChanged(media, view.clip)
    this.#applyRateIfChanged(media, view.clip)
    ;(element as HTMLVideoElement & { preservesPitch?: boolean }).preservesPitch = true
    if (this.#playing && element.paused && !element.ended) {
      void element.play().catch(() => {
        this.pause()
        this.#deps.onError?.(
          'El navegador no permitió reproducir el audio del editor.',
        )
      })
    }
  }

  #maybePrepareNext(
    project: EditorProject,
    time: number,
    current: TimelineClipView,
  ): void {
    if (!this.#playing || current.end - time > 0.8) return
    const views = layoutTimeline(project)
    const next = views[current.index + 1]
    if (!next || next.clip.mediaId === current.clip.mediaId) return
    if (
      this.#prepared?.clipId === next.clip.id ||
      this.#preparingClipId === next.clip.id
    ) {
      return
    }
    // Un único slot de precarga; si todos los slots están protegidos se
    // aplaza en vez de expulsar el activo o el destino de un seek.
    const protectedIds = new Set(
      [this.#activeMediaId, this.#prepared?.mediaId, this.#pendingClipId
        ? layoutTimeline(project).find((view) => view.clip.id === this.#pendingClipId)?.clip.mediaId
        : null,
      ].filter((id): id is string => Boolean(id)),
    )
    const loadedCount = this.#media.size
    if (loadedCount >= MAX_LOADED_MEDIA && !this.#media.has(next.clip.mediaId)) {
      const evictable = this.#lru.find((id) => !protectedIds.has(id))
      if (!evictable) return
    }
    this.#preparingClipId = next.clip.id
    void this.#prepareClip(next)
  }

  async #prepareClip(view: TimelineClipView): Promise<void> {
    const clipId = view.clip.id
    try {
      const media = await this.#ensureMedia(view.clip.mediaId)
      if (
        this.#disposed ||
        !this.#playing ||
        this.#time >= view.start - 0.02
      ) {
        return
      }
      media.element.pause()
      if (media.gain) media.gain.gain.value = 0
      media.element.muted = true
      await this.#seekElement(
        media.element,
        sourceTimeForView(view, view.start),
        false,
      )
      if (
        this.#disposed ||
        !this.#playing ||
        this.#time >= view.start - 0.02
      ) {
        return
      }
      this.#prepared = {
        clipId,
        mediaId: media.mediaId,
        element: media.element,
      }
    } catch {
      // The regular sync path will load and seek at the cut if preparing fails.
    } finally {
      if (this.#preparingClipId === clipId) {
        this.#preparingClipId = null
      }
    }
  }

  #audioKey(clip: EditorClip): string {
    return `${clip.id}|${clip.muted ? 1 : 0}|${Math.min(MAX_VOLUME, Math.max(0, clip.volume ?? 1)).toFixed(3)}`
  }

  #rateKey(clip: EditorClip): string {
    return `${clip.id}|${clip.speed}|${this.#playbackRate}`
  }

  #applyClipAudioIfChanged(media: PreviewMedia, clip: EditorClip): void {
    const key = this.#audioKey(clip)
    if (key === this.#lastAudioKey && media.mediaId === this.#activeMediaId) return
    this.#applyClipAudio(media, clip)
    this.#lastAudioKey = key
  }

  #applyRateIfChanged(media: PreviewMedia, clip: EditorClip): void {
    const key = this.#rateKey(clip)
    if (key === this.#lastRateKey && media.mediaId === this.#activeMediaId) return
    media.element.playbackRate = clip.speed * this.#playbackRate
    this.#lastRateKey = key
  }

  #applyClipAudio(media: PreviewMedia, clip: EditorClip): void {
    const volume = Math.min(MAX_VOLUME, Math.max(0, clip.volume ?? 1))
    const gain = clip.muted ? 0 : volume
    if (media.gain) {
      media.element.volume = 1
      media.element.muted = false
      media.gain.gain.value = gain
      return
    }
    media.element.volume = Math.min(1, volume)
    media.element.muted = clip.muted || volume <= 0
  }

  #pauseOthers(exceptMediaId: string | null): void {
    for (const [mediaId, media] of this.#media) {
      if (mediaId === exceptMediaId) continue
      media.element.pause()
      if (media.gain) {
        media.gain.gain.value = 0
        media.element.muted = false
      } else {
        media.element.muted = true
      }
    }
  }

  #touchMedia(mediaId: string): void {
    this.#lru = this.#lru.filter((id) => id !== mediaId)
    this.#lru.push(mediaId)
  }

  #protectedMediaIds(): Set<string> {
    const ids = new Set<string>()
    if (this.#activeMediaId) ids.add(this.#activeMediaId)
    if (this.#prepared) ids.add(this.#prepared.mediaId)
    if (this.#preparingClipId && this.#project) {
      const view = layoutTimeline(this.#project).find(
        (item) => item.clip.id === this.#preparingClipId,
      )
      if (view) ids.add(view.clip.mediaId)
    }
    if (this.#pendingClipId && this.#project) {
      const view = layoutTimeline(this.#project).find(
        (item) => item.clip.id === this.#pendingClipId,
      )
      if (view) ids.add(view.clip.mediaId)
    }
    return ids
  }

  #evictIfNeeded(): void {
    while (this.#media.size >= MAX_LOADED_MEDIA) {
      const protectedIds = this.#protectedMediaIds()
      const candidate = this.#lru.find((id) => !protectedIds.has(id))
      if (!candidate) return
      const media = this.#media.get(candidate)
      if (media) this.#releaseMedia(media)
      this.#media.delete(candidate)
      this.#lru = this.#lru.filter((id) => id !== candidate)
    }
  }

  #releaseMedia(media: PreviewMedia): void {
    try {
      media.element.pause()
    } catch { /* noop */ }
    media.source?.disconnect()
    media.gain?.disconnect()
    media.element.removeAttribute('src')
    try {
      media.element.load()
    } catch { /* noop */ }
    revokeDiagnosticUrl(media.url)
    media.element.remove()
  }

  async #ensureMedia(mediaId: string): Promise<PreviewMedia> {
    const existing = this.#media.get(mediaId)
    if (existing) {
      this.#touchMedia(mediaId)
      await existing.ready
      return existing
    }
    const pending = this.#pendingMedia.get(mediaId)
    if (pending) return pending

    const generation = this.#generation
    const task = (async (): Promise<PreviewMedia> => {
      const file = await this.#deps.getFile(mediaId)
      if (this.#disposed || generation !== this.#generation) {
        throw new DOMException('Carga cancelada.', 'AbortError')
      }
      const element = document.createElement('video')
      element.preload = 'auto'
      element.playsInline = true
      element.muted = true
      element.tabIndex = -1
      element.setAttribute('aria-hidden', 'true')
      element.style.cssText =
        'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1;'
      const url = createDiagnosticUrl(file, 'editorUrl')
      element.src = url
      document.body.appendChild(element)

      let resolveReady!: () => void
      let rejectReady!: (error: Error) => void
      let timeout = 0
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      })
      const onLoaded = () => {
        window.clearTimeout(timeout)
        element.removeEventListener('error', onError)
        resolveReady()
      }
      const onError = () => {
        window.clearTimeout(timeout)
        element.removeEventListener('loadeddata', onLoaded)
        rejectReady(
          new Error(
            'No se pudo cargar este video en el editor. Comprueba que el navegador pueda reproducirlo.',
          ),
        )
      }
      element.addEventListener('loadeddata', onLoaded, { once: true })
      element.addEventListener('error', onError, { once: true })
      timeout = window.setTimeout(() => {
        if (element.readyState >= 2) onLoaded()
        else onError()
      }, 5000)
      element.load()

      let source: MediaElementAudioSourceNode | undefined
      let gain: GainNode | undefined
      const audioContext = this.#ensureAudioContext()
      if (audioContext) {
        try {
          source = audioContext.createMediaElementSource(element)
          gain = audioContext.createGain()
          gain.gain.value = 0
          source.connect(gain)
          gain.connect(audioContext.destination)
        } catch {
          source?.disconnect()
          gain?.disconnect()
          source = undefined
          gain = undefined
        }
      }

      const media: PreviewMedia = { mediaId, element, url, ready, source, gain }
      try {
        await ready
      } catch (error) {
        source?.disconnect()
        gain?.disconnect()
        element.remove()
        revokeDiagnosticUrl(url)
        throw error
      }
      if (this.#disposed || generation !== this.#generation) {
        this.#releaseMedia(media)
        throw new DOMException('Carga cancelada.', 'AbortError')
      }
      this.#evictIfNeeded()
      // Si al volver todos los slots están protegidos y este medio no lo
      // está, no se expulsa a nadie: se usa sin retenerlo en el mapa.
      const protectedIds = this.#protectedMediaIds()
      if (this.#media.size >= MAX_LOADED_MEDIA && !protectedIds.has(mediaId)) {
        return media
      }
      this.#media.set(mediaId, media)
      this.#touchMedia(mediaId)
      return media
    })()

    this.#pendingMedia.set(mediaId, task)
    try {
      return await task
    } finally {
      this.#pendingMedia.delete(mediaId)
    }
  }

  #ensureAudioContext(): AudioContext | null {
    if (this.#audioContext) return this.#audioContext
    const release = trackResource('audioContext')
    try {
      this.#audioContext = new AudioContext()
      this.#releaseAudioContext = release
      return this.#audioContext
    } catch {
      release()
      return null
    }
  }

  async #seekElement(
    element: HTMLVideoElement,
    time: number,
    redraw = true,
  ): Promise<void> {
    if (!Number.isFinite(time)) return
    const token = redraw ? ++this.#seekToken : this.#seekToken
    const target = Number.isFinite(element.duration)
      ? Math.min(Math.max(0, time), Math.max(0, element.duration - 0.001))
      : Math.max(0, time)
    if (Math.abs(element.currentTime - target) < 0.001) return

    await new Promise<void>((resolve) => {
      let settled = false
      let timeout = 0
      const finish = () => {
        if (settled) return
        settled = true
        window.clearTimeout(timeout)
        element.removeEventListener('seeked', finish)
        element.removeEventListener('error', finish)
        resolve()
      }
      element.addEventListener('seeked', finish, { once: true })
      element.addEventListener('error', finish, { once: true })
      timeout = window.setTimeout(finish, SEEK_TIMEOUT_MS)
      try {
        element.currentTime = target
      } catch {
        finish()
      }
    })

    if (redraw && token === this.#seekToken) {
      this.#invalidate(true)
    }
  }
}

// Re-export para tests de presupuesto de dibujo.
export function drawIntervalFor(fps: number, playbackRate: number): number {
  const target = Math.max(1, Math.min(120, fps)) * Math.min(1, playbackRate)
  return 1000 / Math.max(1, target)
}

export { findClipIndexAt }
