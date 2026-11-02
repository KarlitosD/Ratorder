import type { Component } from 'svelte'
import type { RecordingMetadata } from '../types'

export type EditorContainer = 'mp4' | 'webm'

export type EditorAssetKind = 'video' | 'image'

export interface EditorAsset {
  id: string
  kind: EditorAssetKind
  name: string
  storedName: string
  extension: string
  mimeType: string
  size: number
  duration: number
  width: number
  height: number
  hasAudio: boolean
}

export interface EditorSourceInfo {
  duration: number
  width: number
  height: number
  fps: number
  container: EditorContainer
  hasAudio: boolean
  extension: EditorContainer
}

export interface EditorClip {
  id: string
  mediaId: string
  inPoint: number
  sourceSpan: number
  speed: number
  volume: number
  muted: boolean
}

export type EditorOverlayKind = 'rect' | 'ellipse' | 'arrow' | 'text' | 'image'

export interface EditorOverlay {
  id: string
  kind: EditorOverlayKind
  start: number
  end: number
  x: number
  y: number
  width: number
  height: number
  opacity: number
  color: string
  strokeColor?: string
  strokeWidth: number
  filled?: boolean
  radius: number
  text?: string
  fontSize?: number
  fontWeight?: number
  align?: 'left' | 'center' | 'right'
  assetId?: string
}

export interface EditorProject {
  version: 1
  sourceId: string
  title: string
  width: number
  height: number
  fps: number
  container: EditorContainer
  source: EditorSourceInfo
  assets: EditorAsset[]
  clips: EditorClip[]
  overlays: EditorOverlay[]
  createdAt: string
  updatedAt: string
}

export interface TimelineClipView {
  clip: EditorClip
  index: number
  start: number
  end: number
  duration: number
  mediaName: string
  media: EditorAsset | null
}

export interface EditorWaveform {
  bins: Float32Array
  duration: number
  loading: boolean
  hasAudio: boolean
}

export interface EditorMediaInfo {
  duration: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  startTimestamp: number
  audioStartTimestamp: number
}

export type EditorSelection =
  | { type: 'clip'; id: string }
  | { type: 'overlay'; id: string }
  | null

export type EditorExportPhase =
  | 'idle'
  | 'preparing'
  | 'exporting'
  | 'finalizing'
  | 'done'
  | 'error'
  | 'canceled'

export interface EditorExportState {
  phase: EditorExportPhase
  progress: number
  message: string
  error: string | null
  result: RecordingMetadata | null
}

export interface EditorSnapshot {
  status: 'loading' | 'ready' | 'error'
  error: string | null
  project: EditorProject | null
  playhead: number
  playing: boolean
  previewRate: number
  waveforms: Record<string, EditorWaveform>
  waveformRevision: number
  selection: EditorSelection
  zoom: number
  duration: number
  importBusy: boolean
  exportState: EditorExportState
  canUndo: boolean
  canRedo: boolean
  savedAt: number | null
  dirty: boolean
  saving: boolean
}

export type EditorContextTarget =
  | { kind: 'clip'; clipId: string; time: number }
  | { kind: 'overlay'; overlayId: string; time: number }
  | { kind: 'timeline'; time: number }
  | { kind: 'preview'; overlayId: string | null; time: number }

export interface EditorContextMenuState {
  x: number
  y: number
  target: EditorContextTarget
}

export interface EditorMenuItem {
  label: string
  icon?: Component
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  separatorBefore?: boolean
  action: () => void
}

export interface EditorOverlayPatch {
  kind?: EditorOverlayKind
  start?: number
  end?: number
  x?: number
  y?: number
  width?: number
  height?: number
  opacity?: number
  color?: string
  strokeColor?: string
  strokeWidth?: number
  filled?: boolean
  radius?: number
  text?: string
  fontSize?: number
  fontWeight?: number
  align?: 'left' | 'center' | 'right'
  assetId?: string
}
