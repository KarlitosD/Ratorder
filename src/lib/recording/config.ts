import type {
  BrowserCapabilities,
  ContainerFormat,
  QualityPreset,
  RecordingPreferences,
} from '../types'

export interface QualityPresetDefinition {
  label: string
  shortLabel: string
  description: string
  maxLongEdge: number
  bitrateAtThirtyFps: number
}

export const QUALITY_PRESETS: Record<QualityPreset, QualityPresetDefinition> = {
  balanced: {
    label: 'Equilibrada',
    shortLabel: '720p',
    description: 'Archivos más ligeros para sesiones largas.',
    maxLongEdge: 1280,
    bitrateAtThirtyFps: 4_000_000,
  },
  high: {
    label: 'Alta',
    shortLabel: '1080p',
    description: 'El mejor equilibrio entre nitidez y tamaño.',
    maxLongEdge: 1920,
    bitrateAtThirtyFps: 8_000_000,
  },
  maximum: {
    label: 'Máxima',
    shortLabel: '1440p',
    description: 'Más detalle para pantallas de alta resolución.',
    maxLongEdge: 2560,
    bitrateAtThirtyFps: 16_000_000,
  },
}

export const DEFAULT_PREFERENCES: RecordingPreferences = {
  microphoneId: 'default',
  systemAudio: true,
  quality: 'high',
  fps: 30,
  container: 'mp4',
  fragmentDuration: 2,
  audioBitrate: 128_000,
}

export function loadPreferences(): RecordingPreferences {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_PREFERENCES }

  try {
    const raw = localStorage.getItem('ratorder.preferences')
    if (!raw) return { ...DEFAULT_PREFERENCES }
    const stored = JSON.parse(raw) as Partial<RecordingPreferences>
    const quality: QualityPreset =
      stored.quality === 'balanced' ||
      stored.quality === 'high' ||
      stored.quality === 'maximum'
        ? stored.quality
        : DEFAULT_PREFERENCES.quality
    const container: ContainerFormat =
      stored.container === 'webm' ? 'webm' : 'mp4'
    const fps = stored.fps === 60 ? 60 : 30
    const fragmentDuration = [2, 4, 8].includes(Number(stored.fragmentDuration))
      ? Number(stored.fragmentDuration)
      : DEFAULT_PREFERENCES.fragmentDuration
    const audioBitrate = [96_000, 128_000, 192_000].includes(
      Number(stored.audioBitrate),
    )
      ? Number(stored.audioBitrate)
      : DEFAULT_PREFERENCES.audioBitrate

    return {
      microphoneId:
        typeof stored.microphoneId === 'string'
          ? stored.microphoneId
          : DEFAULT_PREFERENCES.microphoneId,
      systemAudio:
        typeof stored.systemAudio === 'boolean'
          ? stored.systemAudio
          : DEFAULT_PREFERENCES.systemAudio,
      quality,
      fps,
      container,
      fragmentDuration,
      audioBitrate,
    }
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
}

export function savePreferences(preferences: RecordingPreferences): void {
  try {
    localStorage.setItem('ratorder.preferences', JSON.stringify(preferences))
  } catch {
    // Preferences are a convenience; recording must still work without storage.
  }
}

export function computeOutputDimensions(
  sourceWidth: number,
  sourceHeight: number,
  preset: QualityPreset,
): { width: number; height: number } {
  const safeWidth = Math.max(2, sourceWidth || 1920)
  const safeHeight = Math.max(2, sourceHeight || 1080)
  const maxLongEdge = QUALITY_PRESETS[preset].maxLongEdge
  const longEdge = Math.max(safeWidth, safeHeight)

  if (longEdge <= maxLongEdge) {
    return {
      width: makeEven(safeWidth),
      height: makeEven(safeHeight),
    }
  }

  const ratio = maxLongEdge / longEdge
  return {
    width: makeEven(safeWidth * ratio),
    height: makeEven(safeHeight * ratio),
  }
}

export function computeVideoBitrate(
  preset: QualityPreset,
  fps: number,
): number {
  return Math.round(
    QUALITY_PRESETS[preset].bitrateAtThirtyFps * (fps === 60 ? 1.6 : 1),
  )
}

export function inferQualityPreset(
  width: number,
  height: number,
): QualityPreset {
  const longEdge = Math.max(width || 0, height || 0)
  if (longEdge <= QUALITY_PRESETS.balanced.maxLongEdge) return 'balanced'
  if (longEdge <= QUALITY_PRESETS.high.maxLongEdge) return 'high'
  return 'maximum'
}

function makeEven(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2)
}

export function getBrowserCapabilities(): BrowserCapabilities {
  if (typeof window === 'undefined') {
    return {
      displayCapture: false,
      opfs: false,
      webCodecs: false,
      fileSystemAccess: false,
      shareSupported: false,
    }
  }

  return {
    displayCapture:
      typeof navigator.mediaDevices?.getDisplayMedia === 'function',
    opfs: typeof navigator.storage?.getDirectory === 'function',
    webCodecs:
      typeof window.VideoEncoder === 'function' &&
      typeof window.AudioEncoder === 'function',
    fileSystemAccess:
      'showSaveFilePicker' in window &&
      typeof window.showSaveFilePicker === 'function',
    shareSupported: typeof navigator.share === 'function',
  }
}
