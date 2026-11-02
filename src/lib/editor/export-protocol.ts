import type { EditorProject } from './types'

export type ExportStartMessage = {
  type: 'start'
  project: EditorProject
  sourceFile: File
  assetFiles: Record<string, File>
  recordingId: string
  extension: 'mp4' | 'webm'
  videoCodec: string
  audioCodec: string | null
  videoBitrate: number
  audioBitrate: number
}

export type ExportMainMessage =
  | ExportStartMessage
  | { type: 'cancel' }

export type ExportWorkerMessage =
  | { type: 'ready' }
  | { type: 'progress'; progress: number; message: string }
  | {
      type: 'done'
      result: { size: number; mimeType: string | null; thumbnail: Blob | null }
    }
  | { type: 'error'; error: string }
  | { type: 'canceled' }
