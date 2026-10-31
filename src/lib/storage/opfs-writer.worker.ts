/// <reference lib="webworker" />

import type { WriterRequest, WriterResponse } from './writer-protocol'

let accessHandle: FileSystemSyncAccessHandle | null = null
let size = 0
let dirty = false
let flushTimer: ReturnType<typeof setInterval> | null = null
let failed = false

const scope = self as DedicatedWorkerGlobalScope

function post(message: WriterResponse, transfer: Transferable[] = []) {
  scope.postMessage(message, transfer)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function reportFatal(error: unknown) {
  if (failed) return
  failed = true
  stopFlushTimer()
  post({ type: 'fatal', error: errorMessage(error) })
}

async function flushHandle(): Promise<number> {
  if (!accessHandle) return size
  if (dirty) {
    dirty = false
    await accessHandle.flush()
  }
  return accessHandle.getSize()
}

function startFlushTimer() {
  stopFlushTimer()
  flushTimer = setInterval(() => {
    if (!dirty || !accessHandle) return
    void flushHandle().catch(reportFatal)
  }, 1000)
}

function stopFlushTimer() {
  if (flushTimer !== null) {
    clearInterval(flushTimer)
    flushTimer = null
  }
}

async function openWriter(
  recordingId: string,
  extension: 'mp4' | 'webm',
): Promise<number> {
  if (accessHandle) {
    accessHandle.close()
    accessHandle = null
  }

  const root = await navigator.storage.getDirectory()
  const recordings = await root.getDirectoryHandle('recordings', {
    create: true,
  })
  const directory = await recordings.getDirectoryHandle(recordingId, {
    create: true,
  })
  const fileHandle = await directory.getFileHandle(`video.${extension}`, {
    create: true,
  })
  accessHandle = await fileHandle.createSyncAccessHandle()
  accessHandle.truncate(0)
  size = 0
  dirty = false
  failed = false
  startFlushTimer()
  return size
}

async function handleRequest(message: WriterRequest): Promise<void> {
  switch (message.type) {
    case 'open': {
      const openedSize = await openWriter(message.recordingId, message.extension)
      post({ id: message.id, ok: true, result: { size: openedSize } })
      break
    }

    case 'write': {
      if (!accessHandle) throw new Error('El archivo de grabación no está abierto.')
      if (failed) throw new Error('La escritura anterior falló.')
      const view = new Uint8Array(
        message.buffer,
        message.byteOffset,
        message.byteLength,
      )
      const written = accessHandle.write(view, { at: message.position })
      if (written !== view.byteLength) {
        throw new Error(
          `Escritura incompleta en disco (${written}/${view.byteLength} bytes).`,
        )
      }
      size = Math.max(size, message.position + written)
      dirty = true
      post({ id: message.id, ok: true, result: { size } })
      break
    }

    case 'flush': {
      const flushedSize = await flushHandle()
      post({ id: message.id, ok: true, result: { size: flushedSize } })
      break
    }

    case 'close': {
      stopFlushTimer()
      if (accessHandle) {
        const finalSize = await flushHandle()
        accessHandle.close()
        accessHandle = null
        post({ id: message.id, ok: true, result: { size: finalSize } })
      } else {
        post({ id: message.id, ok: true, result: { size } })
      }
      break
    }

    case 'abort': {
      stopFlushTimer()
      if (accessHandle) {
        try {
          await accessHandle.flush()
        } catch {
          // The file handle may already be unusable; closing is best-effort.
        }
        accessHandle.close()
        accessHandle = null
      }
      post({ id: message.id, ok: true, result: { size } })
      break
    }
  }
}

scope.addEventListener('message', (event: MessageEvent<WriterRequest>) => {
  void handleRequest(event.data).catch((error: unknown) => {
    post({ id: event.data.id, ok: false, error: errorMessage(error) })
  })
})

scope.addEventListener('error', (event) => {
  reportFatal(event.error ?? event.message)
})

scope.addEventListener('unhandledrejection', (event) => {
  reportFatal(event.reason)
})
