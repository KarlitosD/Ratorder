import type {
  EditorAsset,
  EditorClip,
  EditorOverlay,
  EditorOverlayKind,
  EditorOverlayPatch,
  EditorProject,
  EditorSourceInfo,
  TimelineClipView,
} from './types'

export const MIN_SPEED = 0.5
export const MAX_SPEED = 2
export const MAX_VOLUME = 1.5
export const SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const
export const DEFAULT_OVERLAY_DURATION = 4
export const HISTORY_LIMIT = 100

const EPSILON = 1e-6

// Los proyectos son inmutables en el modelo: cada edición crea otro objeto.
// Estas cachés asumen esa regla; no mutar un proyecto in-place.
const layoutCache = new WeakMap<EditorProject, TimelineClipView[]>()
const durationCache = new WeakMap<EditorProject, number>()

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function makeEven(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2)
}

export function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

export function minClipDuration(project: Pick<EditorProject, 'fps'>): number {
  return Math.max(0.1, 1 / Math.max(1, project.fps))
}

export function cloneProject(project: EditorProject): EditorProject {
  return structuredClone(project)
}

export function mediaDuration(project: EditorProject, mediaId: string): number {
  if (mediaId === 'source') return Math.max(0, project.source.duration)
  const asset = project.assets.find((item) => item.id === mediaId)
  return asset ? Math.max(0, asset.duration) : 0
}

export function mediaName(project: EditorProject, mediaId: string): string {
  if (mediaId === 'source') return project.title
  return project.assets.find((item) => item.id === mediaId)?.name ?? 'Medio'
}

export function layoutTimeline(project: EditorProject): TimelineClipView[] {
  const cached = layoutCache.get(project)
  if (cached) return cached
  let cursor = 0
  const assetById = new Map(project.assets.map((asset) => [asset.id, asset]))
  const views = project.clips.map((clip, index) => {
    const duration = Math.max(0, clip.sourceSpan / Math.max(MIN_SPEED, clip.speed))
    const view: TimelineClipView = {
      clip,
      index,
      start: cursor,
      end: cursor + duration,
      duration,
      mediaName: mediaName(project, clip.mediaId),
      media: assetById.get(clip.mediaId) ?? null,
    }
    cursor += duration
    return view
  })
  layoutCache.set(project, views)
  return views
}

export function projectDuration(project: EditorProject): number {
  const cached = durationCache.get(project)
  if (cached !== undefined) return cached
  // Reutiliza el layout cacheado para no recorrer los clips dos veces.
  const views = layoutTimeline(project)
  const total =
    views.length > 0 ? views[views.length - 1].end : 0
  durationCache.set(project, total)
  return total
}

export function findClipIndexAt(
  project: EditorProject,
  time: number,
): number {
  const views = layoutTimeline(project)
  if (views.length === 0) return -1
  const duration = projectDuration(project)
  const safeTime = clamp(time, 0, duration)
  // Búsqueda binaria sobre `start`: último view con start - EPS <= safeTime.
  let low = 0
  let high = views.length - 1
  let candidate = 0
  while (low <= high) {
    const mid = (low + high) >> 1
    if (views[mid].start - EPSILON <= safeTime) {
      candidate = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  // Ajusta por el epsilon de borde: el corte exacto pertenece al siguiente.
  let index = candidate
  while (
    index < views.length - 1 &&
    !(safeTime >= views[index].start - EPSILON &&
      safeTime < views[index].end - EPSILON)
  ) {
    // Solo puede ocurrir en el borde entre clips contiguos.
    if (safeTime >= views[index + 1].start - EPSILON) index += 1
    else break
  }
  while (
    index > 0 &&
    safeTime < views[index].start - EPSILON
  ) {
    index -= 1
  }
  const view = views[index]
  if (
    view &&
    safeTime >= view.start - EPSILON &&
    safeTime < view.end - EPSILON
  ) {
    return index
  }
  return views.length - 1
}

export function findClipAt(
  project: EditorProject,
  time: number,
): TimelineClipView | null {
  const views = layoutTimeline(project)
  if (views.length === 0) return null
  return views[findClipIndexAt(project, time)] ?? views[views.length - 1]
}

export function sourceTimeForView(
  view: TimelineClipView,
  time: number,
): number {
  return clamp(
    view.clip.inPoint + (time - view.start) * view.clip.speed,
    view.clip.inPoint,
    view.clip.inPoint + view.clip.sourceSpan,
  )
}

export function findByClipId(
  project: EditorProject,
  clipId: string,
): TimelineClipView | null {
  return layoutTimeline(project).find((view) => view.clip.id === clipId) ?? null
}

export function visibleTicks(
  duration: number,
  _pps: number,
  tickStep: number,
  scrollLeft: number,
  width: number,
): number[] {
  const step = Math.max(0.001, tickStep)
  const first = Math.max(0, Math.floor(scrollLeft / step) * step)
  const last = Math.min(duration, scrollLeft + width)
  const values: number[] = []
  // Margen de un tick a cada lado para no recortar etiquetas en el borde.
  for (let time = first - step; time <= last + step + 1e-9; time += step) {
    if (time < -1e-9 || time > duration + 1e-6) continue
    values.push(Math.max(0, time))
  }
  return values
}

function touch(project: EditorProject, patch: Partial<EditorProject>): EditorProject {
  return {
    ...project,
    ...patch,
    updatedAt: new Date().toISOString(),
  }
}

export function createDefaultProject(options: {
  sourceId: string
  title: string
  source: EditorSourceInfo
  now?: string
}): EditorProject {
  const now = options.now ?? new Date().toISOString()
  const source = options.source
  const clips: EditorClip[] =
    source.duration > 0
      ? [
          {
            id: createId('clip'),
            mediaId: 'source',
            inPoint: 0,
            sourceSpan: source.duration,
            speed: 1,
            volume: 1,
            muted: false,
          },
        ]
      : []
  return {
    version: 1,
    sourceId: options.sourceId,
    title: options.title,
    width: makeEven(source.width),
    height: makeEven(source.height),
    fps: clamp(Math.round(source.fps || 30), 1, 120),
    container: source.container,
    source: { ...source },
    assets: [],
    clips,
    overlays: [],
    createdAt: now,
    updatedAt: now,
  }
}

export function splitAt(project: EditorProject, time: number): EditorProject {
  const view = findClipAt(project, time)
  if (!view) return project
  const min = minClipDuration(project)
  const offset = time - view.start
  const splitSource = view.clip.inPoint + offset * view.clip.speed
  const firstSpan = splitSource - view.clip.inPoint
  const secondSpan = view.clip.sourceSpan - firstSpan
  if (
    firstSpan < min * view.clip.speed ||
    secondSpan < min * view.clip.speed
  ) {
    return project
  }

  const first: EditorClip = { ...view.clip, sourceSpan: firstSpan }
  const second: EditorClip = {
    ...view.clip,
    id: createId('clip'),
    inPoint: splitSource,
    sourceSpan: secondSpan,
  }
  const clips = [...project.clips]
  clips.splice(view.index, 1, first, second)
  return touch(project, { clips })
}

export function deleteClip(project: EditorProject, clipId: string): EditorProject {
  const clips = project.clips.filter((clip) => clip.id !== clipId)
  if (clips.length === project.clips.length) return project
  return touch(project, { clips })
}

export function setClipMuted(
  project: EditorProject,
  clipId: string,
  muted: boolean,
): EditorProject {
  let changed = false
  const clips = project.clips.map((clip) => {
    if (clip.id !== clipId || clip.muted === muted) return clip
    changed = true
    return { ...clip, muted }
  })
  return changed ? touch(project, { clips }) : project
}

export function toggleMute(project: EditorProject, clipId: string): EditorProject {
  const clip = project.clips.find((item) => item.id === clipId)
  if (!clip) return project
  return setClipMuted(project, clipId, !clip.muted)
}

export function setClipVolume(
  project: EditorProject,
  clipId: string,
  volume: number,
): EditorProject {
  const nextVolume = clamp(volume, 0, MAX_VOLUME)
  let changed = false
  const clips = project.clips.map((clip) => {
    if (clip.id !== clipId || Math.abs(clip.volume - nextVolume) < EPSILON) {
      return clip
    }
    changed = true
    return { ...clip, volume: nextVolume }
  })
  return changed ? touch(project, { clips }) : project
}

export function setClipSpeed(
  project: EditorProject,
  clipId: string,
  speed: number,
): EditorProject {
  const nextSpeed = clamp(speed, MIN_SPEED, MAX_SPEED)
  let changed = false
  const clips = project.clips.map((clip) => {
    if (clip.id !== clipId || Math.abs(clip.speed - nextSpeed) < EPSILON) {
      return clip
    }
    changed = true
    return { ...clip, speed: nextSpeed }
  })
  return changed ? touch(project, { clips }) : project
}

export type TrimEdge = 'start' | 'end'

export function trimClip(
  project: EditorProject,
  clipId: string,
  edge: TrimEdge,
  timelineDelta: number,
): EditorProject {
  const view = findByClipId(project, clipId)
  if (!view || !Number.isFinite(timelineDelta)) return project
  const clip = view.clip
  const duration = mediaDuration(project, clip.mediaId)
  const minSource = minClipDuration(project) * clip.speed
  let next: EditorClip

  if (edge === 'start') {
    const sourceDelta = timelineDelta * clip.speed
    const maxIn = Math.max(0, clip.inPoint + clip.sourceSpan - minSource)
    const nextIn = clamp(clip.inPoint + sourceDelta, 0, maxIn)
    if (Math.abs(nextIn - clip.inPoint) < EPSILON) return project
    next = {
      ...clip,
      inPoint: nextIn,
      sourceSpan: Math.max(
        minSource,
        clip.sourceSpan - (nextIn - clip.inPoint),
      ),
    }
  } else {
    const maxSpan = Math.max(minSource, duration - clip.inPoint)
    const nextSpan = clamp(
      clip.sourceSpan + timelineDelta * clip.speed,
      minSource,
      maxSpan,
    )
    if (Math.abs(nextSpan - clip.sourceSpan) < EPSILON) return project
    next = { ...clip, sourceSpan: nextSpan }
  }

  const clips = project.clips.map((item) =>
    item.id === clipId ? next : item,
  )
  return touch(project, { clips })
}

export function addClipFromAsset(
  project: EditorProject,
  assetId: string,
): EditorProject {
  const asset = project.assets.find(
    (item) => item.id === assetId && item.kind === 'video',
  )
  if (!asset || asset.duration <= 0) return project
  const clip: EditorClip = {
    id: createId('clip'),
    mediaId: asset.id,
    inPoint: 0,
    sourceSpan: asset.duration,
    speed: 1,
    volume: 1,
    muted: false,
  }
  return touch(project, { clips: [...project.clips, clip] })
}

function defaultOverlay(kind: EditorOverlayKind): Omit<EditorOverlay, 'id' | 'start' | 'end'> {
  switch (kind) {
    case 'rect':
      return {
        kind,
        x: 0.12,
        y: 0.12,
        width: 0.32,
        height: 0.22,
        opacity: 0.9,
        color: '#4F7CF7',
        strokeColor: '#171A21',
        strokeWidth: 0,
        radius: 14,
      }
    case 'ellipse':
      return {
        kind,
        x: 0.14,
        y: 0.16,
        width: 0.26,
        height: 0.26,
        opacity: 0.88,
        color: '#5AD1A3',
        strokeColor: '#171A21',
        strokeWidth: 0,
        radius: 0,
      }
    case 'arrow':
      return {
        kind,
        x: 0.16,
        y: 0.22,
        width: 0.3,
        height: 0.18,
        opacity: 1,
        color: '#E5B05A',
        strokeWidth: 7,
        radius: 0,
      }
    case 'text':
      return {
        kind,
        x: 0.1,
        y: 0.1,
        width: 0.5,
        height: 0.16,
        opacity: 1,
        color: '#FFFFFF',
        strokeColor: '#171A21',
        strokeWidth: 0,
        radius: 0,
        text: 'Texto',
        fontSize: 64,
        fontWeight: 600,
        align: 'left',
      }
    case 'image':
      return {
        kind,
        x: 0.2,
        y: 0.2,
        width: 0.34,
        height: 0.34,
        opacity: 1,
        color: '#FFFFFF',
        strokeWidth: 0,
        radius: 0,
      }
  }
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

export function clampOverlay(
  overlay: EditorOverlay,
  duration: number,
): EditorOverlay {
  const safeDuration = Math.max(0, duration)
  const minSpan = Math.min(0.1, safeDuration)
  let start = clamp(
    finiteOr(overlay.start, 0),
    0,
    Math.max(0, safeDuration - minSpan),
  )
  let end = clamp(
    finiteOr(overlay.end, safeDuration),
    start + minSpan,
    safeDuration,
  )
  if (safeDuration <= 0) {
    start = 0
    end = 0
  } else if (end - start < minSpan) {
    start = Math.max(0, safeDuration - minSpan)
    end = safeDuration
  }

  const width = clamp(finiteOr(overlay.width, 0.3), 0.01, 1)
  const height = clamp(finiteOr(overlay.height, 0.2), 0.01, 1)
  return {
    ...overlay,
    start,
    end,
    width,
    height,
    x: clamp(finiteOr(overlay.x, 0), 0, Math.max(0, 1 - width)),
    y: clamp(finiteOr(overlay.y, 0), 0, Math.max(0, 1 - height)),
    opacity: clamp(finiteOr(overlay.opacity, 1), 0, 1),
    strokeWidth: Math.max(0, finiteOr(overlay.strokeWidth, 0)),
    filled: overlay.filled !== false,
    radius: Math.max(0, finiteOr(overlay.radius, 0)),
  }
}

export function createOverlay(
  project: EditorProject,
  kind: EditorOverlayKind,
  time: number,
  assetId?: string,
): EditorOverlay {
  const duration = projectDuration(project)
  const base = defaultOverlay(kind)
  if (kind === 'text') {
    base.fontSize = Math.max(16, Math.round(project.height * 0.06))
  }
  if (kind === 'rect') {
    base.radius = Math.max(4, Math.round(project.height * 0.012))
  }
  if (kind === 'arrow') {
    base.strokeWidth = Math.max(2, Math.round(project.height * 0.006))
  }
  const overlay: EditorOverlay = {
    ...base,
    id: createId('overlay'),
    start: clamp(time, 0, Math.max(0, duration - 0.1)),
    end: clamp(time + DEFAULT_OVERLAY_DURATION, 0.1, Math.max(0.1, duration)),
    ...(assetId ? { assetId } : {}),
  }
  return clampOverlay(overlay, duration)
}

export function addOverlay(
  project: EditorProject,
  overlay: EditorOverlay,
): EditorProject {
  return touch(project, {
    overlays: [...project.overlays, clampOverlay(overlay, projectDuration(project))],
  })
}

export function updateOverlay(
  project: EditorProject,
  overlayId: string,
  patch: EditorOverlayPatch,
): EditorProject {
  let changed = false
  const overlays = project.overlays.map((overlay) => {
    if (overlay.id !== overlayId) return overlay
    changed = true
    return clampOverlay(
      { ...overlay, ...patch },
      projectDuration(project),
    )
  })
  return changed ? touch(project, { overlays }) : project
}

export function removeOverlay(
  project: EditorProject,
  overlayId: string,
): EditorProject {
  const overlays = project.overlays.filter((overlay) => overlay.id !== overlayId)
  if (overlays.length === project.overlays.length) return project
  return touch(project, { overlays })
}

export function projectHasAudio(project: EditorProject): boolean {
  return project.clips.some((clip) => {
    if (clip.muted || clip.volume <= 0) return false
    if (clip.mediaId === 'source') return project.source.hasAudio
    return (
      project.assets.find((asset) => asset.id === clip.mediaId)?.hasAudio ??
      false
    )
  })
}

export interface NormalizeResult {
  project: EditorProject
  repairs: string[]
}

export function normalizeProject(
  raw: EditorProject,
  options: {
    sourceInfo: EditorSourceInfo
    mediaDurations: Record<string, number>
    availableAssets: EditorAsset[]
    now?: string
  },
): NormalizeResult {
  const repairs: string[] = []
  const source = { ...options.sourceInfo }
  const assets = options.availableAssets.map((asset) => ({ ...asset }))
  const assetIds = new Set(assets.map((asset) => asset.id))
  const durationOf = (mediaId: string): number =>
    mediaId === 'source'
      ? Math.max(0, source.duration)
      : Math.max(0, options.mediaDurations[mediaId] ?? 0)

  const clips: EditorClip[] = []
  for (const value of Array.isArray(raw.clips) ? raw.clips : []) {
    if (!value || typeof value !== 'object') {
      repairs.push('Se quitó un clip inválido.')
      continue
    }
    const clip = value as EditorClip
    const mediaTotal = durationOf(clip.mediaId)
    if (mediaTotal <= 0) {
      repairs.push('Se quitó un clip cuya fuente ya no está disponible.')
      continue
    }
    const speed = clamp(Number(clip.speed) || 1, MIN_SPEED, MAX_SPEED)
    const minSource = minClipDuration({ fps: source.fps }) * speed
    const inPoint = clamp(Number(clip.inPoint) || 0, 0, Math.max(0, mediaTotal - minSource))
    const sourceSpan = clamp(
      Number(clip.sourceSpan) || 0,
      Math.min(minSource, mediaTotal),
      Math.max(0, mediaTotal - inPoint),
    )
    if (sourceSpan <= 0) {
      repairs.push('Se quitó un clip sin duración válida.')
      continue
    }
    clips.push({
      id: typeof clip.id === 'string' && clip.id ? clip.id : createId('clip'),
      mediaId: clip.mediaId,
      inPoint,
      sourceSpan,
      speed,
      volume: clamp(finiteOr(Number(clip.volume), 1), 0, MAX_VOLUME),
      muted: Boolean(clip.muted),
    })
  }

  if (raw.clips?.length !== clips.length) {
    repairs.push('Se ajustaron clips fuera de rango.')
  }

  const duration = clips.reduce(
    (total, clip) => total + clip.sourceSpan / Math.max(MIN_SPEED, clip.speed),
    0,
  )

  const overlays: EditorOverlay[] = []
  const validKinds: EditorOverlayKind[] = ['rect', 'ellipse', 'arrow', 'text', 'image']
  for (const value of Array.isArray(raw.overlays) ? raw.overlays : []) {
    if (!value || typeof value !== 'object') {
      repairs.push('Se quitó un elemento inválido.')
      continue
    }
    const overlay = value as EditorOverlay
    if (!validKinds.includes(overlay.kind)) {
      repairs.push('Se quitó un elemento con un tipo desconocido.')
      continue
    }
    if (overlay.kind === 'image') {
      if (!overlay.assetId || !assetIds.has(overlay.assetId)) {
        repairs.push('Se quitó una imagen superpuesta que ya no existe.')
        continue
      }
    }
    overlays.push(
      clampOverlay(
        {
          ...overlay,
          id: typeof overlay.id === 'string' && overlay.id
            ? overlay.id
            : createId('overlay'),
          color: typeof overlay.color === 'string' ? overlay.color : '#FFFFFF',
          strokeColor:
            typeof overlay.strokeColor === 'string'
              ? overlay.strokeColor
              : undefined,
          opacity: Number(overlay.opacity),
          strokeWidth: Number(overlay.strokeWidth) || 0,
          radius: Number(overlay.radius) || 0,
        },
        duration,
      ),
    )
  }

  const width = makeEven(Number(raw.width) || source.width)
  const height = makeEven(Number(raw.height) || source.height)
  const fps = clamp(Math.round(Number(raw.fps) || source.fps || 30), 1, 120)
  const now = options.now ?? new Date().toISOString()

  return {
    project: {
      version: 1,
      sourceId: raw.sourceId || '',
      title: typeof raw.title === 'string' && raw.title ? raw.title : 'Edición',
      width,
      height,
      fps,
      container: raw.container === 'webm' ? 'webm' : source.container,
      source: { ...source, duration: Math.max(0, source.duration) },
      assets,
      clips,
      overlays,
      createdAt:
        typeof raw.createdAt === 'string' ? raw.createdAt : now,
      updatedAt: now,
    },
    repairs: Array.from(new Set(repairs)),
  }
}

export function parseEditorProject(raw: unknown): EditorProject | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (value.version !== 1) return null
  if (typeof value.sourceId !== 'string') return null
  if (!Array.isArray(value.clips) || !Array.isArray(value.overlays)) return null
  if (!value.source || typeof value.source !== 'object') return null
  return value as unknown as EditorProject
}

export class EditorHistory {
  #entries: EditorProject[]
  #index = 0

  constructor(initial: EditorProject) {
    this.#entries = [cloneProject(initial)]
  }

  get current(): EditorProject {
    return this.#entries[this.#index]
  }

  get canUndo(): boolean {
    return this.#index > 0
  }

  get canRedo(): boolean {
    return this.#index < this.#entries.length - 1
  }

  commit(project: EditorProject): void {
    const snapshot = cloneProject(project)
    if (JSON.stringify(snapshot) === JSON.stringify(this.#entries[this.#index])) {
      return
    }
    this.#entries = this.#entries.slice(0, this.#index + 1)
    this.#entries.push(snapshot)
    if (this.#entries.length > HISTORY_LIMIT) {
      this.#entries.shift()
    }
    this.#index = this.#entries.length - 1
  }

  undo(): EditorProject | null {
    if (!this.canUndo) return null
    this.#index -= 1
    return cloneProject(this.#entries[this.#index])
  }

  redo(): EditorProject | null {
    if (!this.canRedo) return null
    this.#index += 1
    return cloneProject(this.#entries[this.#index])
  }

  reset(project: EditorProject): void {
    this.#entries = [cloneProject(project)]
    this.#index = 0
  }
}
