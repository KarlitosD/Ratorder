import type { StreamTargetChunk } from 'mediabunny'
import type {
  WriterRequest,
  WriterRequestPayload,
  WriterResponse,
  WriterSuccess,
} from './writer-protocol'

interface PendingRequest {
  resolve: (message: WriterSuccess) => void
  reject: (error: Error) => void
}

export class OpfsStreamWriter {
  readonly recordingId: string
  readonly extension: 'mp4' | 'webm'

  #worker: Worker
  #pending = new Map<number, PendingRequest>()
  #nextRequestId = 1
  #bytesWritten = 0
  #fatalError: Error | null = null
  #closed = false
  #onFatal: ((error: Error) => void) | undefined
  #ready: Promise<void>

  private constructor(
    recordingId: string,
    extension: 'mp4' | 'webm',
    onFatal?: (error: Error) => void,
  ) {
    this.recordingId = recordingId
    this.extension = extension
    this.#onFatal = onFatal
    this.#worker = new Worker(
      new URL('./opfs-writer.worker.ts', import.meta.url),
      { type: 'module' },
    )
    this.#worker.addEventListener('message', this.#handleMessage)
    this.#worker.addEventListener('error', this.#handleWorkerError)
    this.#ready = this.#request({
      type: 'open',
      recordingId,
      extension,
    }).then((response) => {
      this.#bytesWritten = response.result?.size ?? 0
    })
  }

  static async open(
    recordingId: string,
    extension: 'mp4' | 'webm',
    onFatal?: (error: Error) => void,
  ): Promise<OpfsStreamWriter> {
    const writer = new OpfsStreamWriter(recordingId, extension, onFatal)
    await writer.#ready
    return writer
  }

  get bytesWritten(): number {
    return this.#bytesWritten
  }

  createWritable(): WritableStream<StreamTargetChunk> {
    return new WritableStream<StreamTargetChunk>({
      write: async (chunk) => {
        await this.write(chunk.position, chunk.data)
      },
      close: async () => {
        await this.flush()
      },
      abort: async () => {
        // The controller owns cleanup via abort(); nothing to do here.
      },
    })
  }

  async write(position: number, data: Uint8Array<ArrayBuffer>): Promise<void> {
    this.#assertUsable()
    let buffer = data.buffer
    let byteOffset = data.byteOffset
    let byteLength = data.byteLength

    if (byteOffset !== 0 || byteLength !== buffer.byteLength) {
      const copy = data.slice()
      buffer = copy.buffer
      byteOffset = copy.byteOffset
      byteLength = copy.byteLength
    }

    const response = await this.#request(
      {
        type: 'write',
        position,
        buffer,
        byteOffset,
        byteLength,
      },
      [buffer],
    )
    this.#bytesWritten = Math.max(
      this.#bytesWritten,
      response.result?.size ?? position + byteLength,
    )
  }

  async flush(): Promise<number> {
    this.#assertUsable()
    const response = await this.#request({ type: 'flush' })
    const size = response.result?.size ?? this.#bytesWritten
    this.#bytesWritten = Math.max(this.#bytesWritten, size)
    return this.#bytesWritten
  }

  async close(): Promise<number> {
    if (this.#closed) return this.#bytesWritten
    this.#closed = true
    if (this.#fatalError) {
      this.#worker.terminate()
      return this.#bytesWritten
    }
    try {
      const response = await this.#request({ type: 'close' })
      this.#bytesWritten = Math.max(
        this.#bytesWritten,
        response.result?.size ?? this.#bytesWritten,
      )
      return this.#bytesWritten
    } finally {
      this.#worker.terminate()
    }
  }

  async abort(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    try {
      if (!this.#fatalError) {
        await this.#request({ type: 'abort' })
      }
    } catch {
      // Preserve whatever bytes reached the disk.
    } finally {
      this.#worker.terminate()
    }
  }

  #handleMessage = (event: MessageEvent<WriterResponse>) => {
    const message = event.data
    if ('type' in message && message.type === 'fatal') {
      this.#fail(new Error(message.error))
      return
    }

    if (!('id' in message)) return
    const pending = this.#pending.get(message.id)
    if (!pending) return
    this.#pending.delete(message.id)

    if (message.ok) {
      pending.resolve(message)
    } else {
      pending.reject(new Error(message.error))
    }
  }

  #handleWorkerError = (event: ErrorEvent) => {
    this.#fail(new Error(event.message || 'El worker de escritura se detuvo.'))
  }

  #fail(error: Error) {
    if (this.#fatalError) return
    this.#fatalError = error
    for (const pending of this.#pending.values()) {
      pending.reject(error)
    }
    this.#pending.clear()
    this.#onFatal?.(error)
  }

  #assertUsable() {
    if (this.#fatalError) throw this.#fatalError
    if (this.#closed) throw new Error('El archivo de grabación ya está cerrado.')
  }

  #request(
    request: WriterRequestPayload,
    transfer: Transferable[] = [],
  ): Promise<WriterSuccess> {
    if (this.#fatalError) return Promise.reject(this.#fatalError)
    const id = this.#nextRequestId++
    return new Promise<WriterSuccess>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#worker.postMessage({ ...request, id } satisfies WriterRequest, transfer)
    })
  }
}
