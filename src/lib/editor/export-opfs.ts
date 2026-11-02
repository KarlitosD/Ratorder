/// <reference lib="webworker" />

import type { StreamTargetChunk } from 'mediabunny'

export class ExportOpfsWriter {
  readonly recordingId: string
  readonly extension: 'mp4' | 'webm'

  #handle: FileSystemSyncAccessHandle | null = null
  #size = 0
  #closed = false

  constructor(recordingId: string, extension: 'mp4' | 'webm') {
    this.recordingId = recordingId
    this.extension = extension
  }

  async open(): Promise<void> {
    const root = await navigator.storage.getDirectory()
    const recordings = await root.getDirectoryHandle('recordings', {
      create: true,
    })
    const directory = await recordings.getDirectoryHandle(this.recordingId, {
      create: true,
    })
    const fileHandle = await directory.getFileHandle(
      `video.${this.extension}`,
      { create: true },
    )
    this.#handle = await fileHandle.createSyncAccessHandle()
    this.#handle.truncate(0)
    this.#size = 0
  }

  get size(): number {
    return this.#size
  }

  createWritable(): WritableStream<StreamTargetChunk> {
    return new WritableStream<StreamTargetChunk>({
      write: (chunk) => {
        this.#assertOpen()
        const data = chunk.data
        const position = chunk.position
        const written = this.#handle!.write(data, { at: position })
        if (written !== data.byteLength) {
          throw new Error(
            `Escritura incompleta en disco (${written}/${data.byteLength} bytes).`,
          )
        }
        // El muxer puede reescribir posiciones anteriores: el tamaño es el
        // máximo alcanzado, no la suma de bytes.
        this.#size = Math.max(this.#size, position + written)
      },
      close: () => {
        this.#flush()
      },
      abort: () => {
        // El controlador decide el cleanup; el abort del stream no cierra.
      },
    })
  }

  flush(): number {
    this.#flush()
    return this.#size
  }

  close(): number {
    if (this.#closed) return this.#size
    try {
      this.#flush()
    } finally {
      this.#closed = true
      this.#handle?.close()
      this.#handle = null
    }
    return this.#size
  }

  abort(): void {
    if (this.#closed) return
    this.#closed = true
    try {
      this.#handle?.flush()
    } catch {
      // Best-effort: el handle puede estar inutilizable.
    } finally {
      this.#handle?.close()
      this.#handle = null
    }
  }

  #flush(): void {
    this.#assertOpen()
    this.#handle!.flush()
    this.#size = Math.max(this.#size, this.#handle!.getSize())
  }

  #assertOpen(): void {
    if (!this.#handle || this.#closed) {
      throw new Error('El archivo de exportación no está abierto.')
    }
  }
}
