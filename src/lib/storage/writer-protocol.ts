export interface OpenWriterRequest {
  id: number
  type: 'open'
  recordingId: string
  extension: 'mp4' | 'webm'
}

export interface WriteChunkRequest {
  id: number
  type: 'write'
  position: number
  buffer: ArrayBuffer
  byteOffset: number
  byteLength: number
}

export interface FlushWriterRequest {
  id: number
  type: 'flush'
}

export interface CloseWriterRequest {
  id: number
  type: 'close'
  removeFile?: boolean
}

export interface AbortWriterRequest {
  id: number
  type: 'abort'
}

export type WriterRequest =
  | OpenWriterRequest
  | WriteChunkRequest
  | FlushWriterRequest
  | CloseWriterRequest
  | AbortWriterRequest

export type WriterRequestPayload =
  | Omit<OpenWriterRequest, 'id'>
  | Omit<WriteChunkRequest, 'id'>
  | Omit<FlushWriterRequest, 'id'>
  | Omit<CloseWriterRequest, 'id'>
  | Omit<AbortWriterRequest, 'id'>

export type WriterSuccess = {
  id: number
  ok: true
  result?: { size?: number }
}

export type WriterFailure = {
  id: number
  ok: false
  error: string
}

export type WriterFatalError = {
  type: 'fatal'
  error: string
}

export type WriterResponse = WriterSuccess | WriterFailure | WriterFatalError
