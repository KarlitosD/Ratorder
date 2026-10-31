import type { RecordingMetadata } from '../types'
import { isRecordingActive } from './recording-lock'

const ROOT_DIRECTORY = 'recordings'
const METADATA_FILE = 'metadata.json'
const THUMBNAIL_FILE = 'thumbnail.webp'

function isDirectoryHandle(
  handle: FileSystemHandle,
): handle is FileSystemDirectoryHandle {
  return handle.kind === 'directory'
}

function fileExistsMessage(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'NotFoundError' || error.name === 'TypeMismatchError')
  )
}

function createTitle(date: Date): string {
  return new Intl.DateTimeFormat('es-ES', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export class RecordingStore {
  #root: Promise<FileSystemDirectoryHandle> | null = null
  #metadataQueues = new Map<string, Promise<void>>()

  async initialize(): Promise<RecordingMetadata[]> {
    await this.#getRecordingsDirectory()
    return this.listRecordings()
  }

  async listRecordings(excludeRecordingId?: string): Promise<RecordingMetadata[]> {
    const directory = await this.#getRecordingsDirectory()
    const recordings: RecordingMetadata[] = []

    for await (const [name, handle] of directory.entries()) {
      if (!isDirectoryHandle(handle)) continue
      if (name === excludeRecordingId) continue
      const recording = await this.#readRecording(name, handle)
      if (recording) recordings.push(recording)
    }

    return recordings.sort(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt),
    )
  }

  async createRecording(metadata: RecordingMetadata): Promise<void> {
    const directory = await this.#getRecordingsDirectory()
    const folder = await directory.getDirectoryHandle(metadata.id, {
      create: true,
    })
    const fileHandle = await folder.getFileHandle(METADATA_FILE, {
      create: true,
    })
    await this.#writeJson(fileHandle, metadata)
  }

  async saveMetadata(metadata: RecordingMetadata): Promise<void> {
    const nextMetadata: RecordingMetadata = {
      ...metadata,
      updatedAt: new Date().toISOString(),
      size: Math.max(0, metadata.size),
    }
    const previous = this.#metadataQueues.get(metadata.id) ?? Promise.resolve()
    const write = previous
      .catch(() => undefined)
      .then(() => this.#writeMetadataFile(nextMetadata))
    this.#metadataQueues.set(metadata.id, write)

    try {
      await write
    } finally {
      if (this.#metadataQueues.get(metadata.id) === write) {
        this.#metadataQueues.delete(metadata.id)
      }
    }
  }

  async saveThumbnail(recordingId: string, blob: Blob): Promise<string> {
    const directory = await this.#getRecordingsDirectory()
    const folder = await directory.getDirectoryHandle(recordingId, {
      create: true,
    })
    const fileHandle = await folder.getFileHandle(THUMBNAIL_FILE, {
      create: true,
    })
    const writable = await fileHandle.createWritable()
    try {
      await writable.write(blob)
    } finally {
      await writable.close()
    }
    return THUMBNAIL_FILE
  }

  async getVideoFile(
    recording: Pick<RecordingMetadata, 'id' | 'extension'>,
  ): Promise<File> {
    const directory = await this.#getRecordingsDirectory()
    const folder = await directory.getDirectoryHandle(recording.id)
    const fileHandle = await folder.getFileHandle(
      `video.${recording.extension}`,
    )
    return fileHandle.getFile()
  }

  async getThumbnailFile(recordingId: string): Promise<File | null> {
    const directory = await this.#getRecordingsDirectory()
    try {
      const folder = await directory.getDirectoryHandle(recordingId)
      const fileHandle = await folder.getFileHandle(THUMBNAIL_FILE)
      return await fileHandle.getFile()
    } catch (error) {
      if (fileExistsMessage(error)) return null
      throw error
    }
  }

  async deleteRecording(recordingId: string): Promise<void> {
    const directory = await this.#getRecordingsDirectory()
    await directory.removeEntry(recordingId, { recursive: true })
  }

  async #getRecordingsDirectory(): Promise<FileSystemDirectoryHandle> {
    if (!this.#root) {
      this.#root = (async () => {
        if (typeof navigator.storage?.getDirectory !== 'function') {
          throw new Error(
            'Este navegador no ofrece almacenamiento local persistente (OPFS).',
          )
        }
        const root = await navigator.storage.getDirectory()
        return root.getDirectoryHandle(ROOT_DIRECTORY, { create: true })
      })()
    }
    return this.#root
  }

  async #readRecording(
    folderName: string,
    folder: FileSystemDirectoryHandle,
  ): Promise<RecordingMetadata | null> {
    let metadata: RecordingMetadata | null = null
    try {
      const metadataHandle = await folder.getFileHandle(METADATA_FILE)
      const file = await metadataHandle.getFile()
      metadata = this.#parseMetadata(await file.text(), folderName)
    } catch (error) {
      if (!fileExistsMessage(error)) {
        console.warn(`No se pudo leer metadata de ${folderName}.`, error)
      }
    }

    const extension = metadata?.extension ?? (await this.#detectExtension(folder))
    if (!extension) return metadata

    const videoFile = await this.#getFileIfExists(
      folder,
      `video.${extension}`,
    )
    const thumbnailFile = await this.#getFileIfExists(folder, THUMBNAIL_FILE)
    if (!metadata) {
      if (!videoFile) return null
      metadata = this.#createFallbackMetadata(
        folderName,
        extension,
        videoFile,
        Boolean(thumbnailFile),
      )
    }

    const now = new Date().toISOString()
    let changed = false

    if (metadata.status === 'recording' && await isRecordingActive(folderName)) {
      return metadata
    }

    if (metadata.status === 'recording') {
      metadata.status = 'interrupted'
      metadata.updatedAt = now
      metadata.note =
        'La sesión no se cerró correctamente. Se conserva el contenido escrito hasta la interrupción.'
      changed = true
    }

    if (videoFile && metadata.size !== videoFile.size) {
      metadata.size = videoFile.size
      changed = true
    }

    const thumbnail = thumbnailFile ? THUMBNAIL_FILE : null
    if (metadata.thumbnail !== thumbnail) {
      metadata.thumbnail = thumbnail
      changed = true
    }

    if (changed) {
      await this.saveMetadata(metadata).catch((error) => {
        console.warn(`No se pudo actualizar metadata de ${folderName}.`, error)
      })
    }

    return metadata
  }

  #parseMetadata(
    raw: string,
    fallbackId: string,
  ): RecordingMetadata | null {
    try {
      const value = JSON.parse(raw) as Record<string, unknown>
      if (!value || typeof value !== 'object') return null
      const extension = value.extension === 'webm' ? 'webm' : 'mp4'
      const container = value.container === 'webm' ? 'webm' : 'mp4'
      const status = ['recording', 'completed', 'interrupted', 'recovered', 'error'].includes(
        String(value.status),
      )
        ? (value.status as RecordingMetadata['status'])
        : 'interrupted'
      const createdAt = stringOr(value.createdAt, new Date().toISOString())
      const startedAtEpochMs = numberOr(
        value.startedAtEpochMs,
        Date.parse(createdAt) || Date.now(),
      )

      return {
        version: 1,
        id: stringOr(value.id, fallbackId),
        title: stringOr(value.title, createTitle(new Date(createdAt))),
        createdAt,
        updatedAt: stringOr(value.updatedAt, createdAt),
        startedAtEpochMs,
        durationMs: Math.max(0, numberOr(value.durationMs, 0)),
        size: Math.max(0, numberOr(value.size, 0)),
        width: Math.max(0, numberOr(value.width, 0)),
        height: Math.max(0, numberOr(value.height, 0)),
        fps: Math.max(0, numberOr(value.fps, 0)),
        container,
        extension,
        mimeType:
          typeof value.mimeType === 'string' ? value.mimeType : null,
        status,
        hasAudio: booleanOr(value.hasAudio, false),
        hasMicrophone: booleanOr(value.hasMicrophone, false),
        hasSystemAudio: booleanOr(value.hasSystemAudio, false),
        audioCodec:
          typeof value.audioCodec === 'string' ? value.audioCodec : null,
        videoCodec:
          typeof value.videoCodec === 'string' ? value.videoCodec : null,
        sourceLabel: stringOr(value.sourceLabel, 'Captura de pantalla'),
        thumbnail:
          typeof value.thumbnail === 'string' ? value.thumbnail : null,
        note: typeof value.note === 'string' ? value.note : undefined,
      }
    } catch {
      return null
    }
  }

  #createFallbackMetadata(
    folderId: string,
    extension: 'mp4' | 'webm',
    file: File,
    hasThumbnail: boolean,
  ): RecordingMetadata {
    const date = new Date(file.lastModified || Date.now())
    return {
      version: 1,
      id: folderId,
      title: createTitle(date),
      createdAt: date.toISOString(),
      updatedAt: new Date().toISOString(),
      startedAtEpochMs: date.getTime(),
      durationMs: 0,
      size: file.size,
      width: 0,
      height: 0,
      fps: 0,
      container: extension,
      extension,
      mimeType: null,
      status: 'interrupted',
      hasAudio: false,
      hasMicrophone: false,
      hasSystemAudio: false,
      audioCodec: null,
      videoCodec: null,
      sourceLabel: 'Captura de pantalla',
      thumbnail: hasThumbnail ? THUMBNAIL_FILE : null,
      note: 'No se encontró el archivo de metadata. La grabación se puede exportar, pero puede estar incompleta.',
    }
  }

  async #detectExtension(
    folder: FileSystemDirectoryHandle,
  ): Promise<'mp4' | 'webm' | null> {
    if (await this.#getFileIfExists(folder, 'video.mp4')) return 'mp4'
    if (await this.#getFileIfExists(folder, 'video.webm')) return 'webm'
    return null
  }

  async #getFileIfExists(
    folder: FileSystemDirectoryHandle,
    name: string,
  ): Promise<File | null> {
    try {
      const handle = await folder.getFileHandle(name)
      return await handle.getFile()
    } catch (error) {
      if (fileExistsMessage(error)) return null
      throw error
    }
  }

  async #writeMetadataFile(metadata: RecordingMetadata): Promise<void> {
    const directory = await this.#getRecordingsDirectory()
    const folder = await directory.getDirectoryHandle(metadata.id, {
      create: true,
    })
    const fileHandle = await folder.getFileHandle(METADATA_FILE, {
      create: true,
    })
    await this.#writeJson(fileHandle, metadata)
  }

  async #writeJson(
    fileHandle: FileSystemFileHandle,
    value: RecordingMetadata,
  ): Promise<void> {
    const writable = await fileHandle.createWritable()
    try {
      await writable.write(JSON.stringify(value, null, 2))
      await writable.close()
    } catch (error) {
      await writable.abort().catch(() => undefined)
      throw error
    }
  }
}
