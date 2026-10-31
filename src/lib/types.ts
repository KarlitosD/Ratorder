export type AppView = 'record' | 'library'

export type ContainerFormat = 'mp4' | 'webm'

export type QualityPreset = 'balanced' | 'high' | 'maximum'

export type RecordingFileStatus =
  | 'recording'
  | 'completed'
  | 'interrupted'
  | 'recovered'
  | 'error'

export interface RecordingPreferences {
  microphoneId: string
  systemAudio: boolean
  quality: QualityPreset
  fps: 30 | 60
  container: ContainerFormat
  fragmentDuration: number
  audioBitrate: number
}

export interface RecordingMetadata {
  version: 1
  id: string
  title: string
  createdAt: string
  updatedAt: string
  startedAtEpochMs: number
  durationMs: number
  size: number
  width: number
  height: number
  fps: number
  container: ContainerFormat
  extension: ContainerFormat
  mimeType: string | null
  status: RecordingFileStatus
  hasAudio: boolean
  hasMicrophone: boolean
  hasSystemAudio: boolean
  audioCodec: string | null
  videoCodec: string | null
  sourceLabel: string
  thumbnail: string | null
  note?: string
}

export interface CaptureSourceInfo {
  label: string
  width: number
  height: number
  fps: number
  hasSystemAudio: boolean
  displaySurface: string | null
  trackLabel: string
}

export type RecorderPhase =
  | 'idle'
  | 'preparing'
  | 'recording'
  | 'paused'
  | 'finalizing'
  | 'completed'
  | 'error'

export interface RecorderSnapshot {
  phase: RecorderPhase
  source: CaptureSourceInfo | null
  previewStream: MediaStream | null
  elapsedMs: number
  bytesWritten: number
  hasAudio: boolean
  microphoneActive: boolean
  systemAudioActive: boolean
  microphoneMuted: boolean
  error: string | null
  completedRecording: RecordingMetadata | null
  activeRecordingId: string | null
  outputWidth: number | null
  outputHeight: number | null
}

export interface StorageSummary {
  used: number
  quota: number
}

export interface BrowserCapabilities {
  displayCapture: boolean
  opfs: boolean
  webCodecs: boolean
  fileSystemAccess: boolean
  shareSupported: boolean
}
