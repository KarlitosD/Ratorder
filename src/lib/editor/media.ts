import {
  ALL_FORMATS,
  AudioSampleSink,
  BlobSource,
  CanvasSink,
  Input,
  type InputAudioTrack,
  type InputVideoTrack,
} from 'mediabunny'
import { trackResource } from '../diagnostics/resources'
import type { EditorMediaInfo } from './types'

export interface CanvasSinkRequest {
  width?: number
  height?: number
  fit?: 'fill' | 'contain' | 'cover'
}

export interface OpenedMedia {
  input: Input
  videoTrack: InputVideoTrack
  audioTrack: InputAudioTrack | null
  info: EditorMediaInfo
  createSink(request?: CanvasSinkRequest): CanvasSink
  dispose(): void
}

export const SUPPORTED_VIDEO_EXTENSIONS = ['mp4', 'webm'] as const
export const SUPPORTED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'] as const

export function extensionFromName(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name)
  return match ? match[1].toLowerCase() : ''
}

export function isSupportedVideoFile(file: File): boolean {
  const extension = extensionFromName(file.name)
  if (SUPPORTED_VIDEO_EXTENSIONS.includes(extension as 'mp4' | 'webm')) {
    return true
  }
  return file.type === 'video/mp4' || file.type === 'video/webm'
}

export function isSupportedImageFile(file: File): boolean {
  const extension = extensionFromName(file.name)
  if (
    SUPPORTED_IMAGE_EXTENSIONS.includes(
      extension as 'png' | 'jpg' | 'jpeg' | 'webp',
    )
  ) {
    return true
  }
  return file.type === 'image/png' || file.type === 'image/jpeg' || file.type === 'image/webp'
}

export function videoExtensionFor(file: File): 'mp4' | 'webm' {
  return extensionFromName(file.name) === 'webm' || file.type === 'video/webm'
    ? 'webm'
    : 'mp4'
}

export function imageExtensionFor(file: File): string {
  const extension = extensionFromName(file.name)
  if (SUPPORTED_IMAGE_EXTENSIONS.includes(extension as 'png')) {
    return extension === 'jpeg' ? 'jpg' : extension
  }
  if (file.type === 'image/png') return 'png'
  if (file.type === 'image/webp') return 'webp'
  return 'jpg'
}

export async function probeMedia(
  file: Blob,
  options: { skipFrameRate?: boolean } = {},
): Promise<OpenedMedia> {
  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  })
  const release = trackResource('editorInput')
  let disposed = false

  try {
    const videoTrack = await input.getPrimaryVideoTrack()
    if (!videoTrack) {
      throw new Error('El archivo no contiene una pista de video compatible.')
    }
    if (!(await videoTrack.canDecode())) {
      throw new Error('Este navegador no puede decodificar el video de este archivo.')
    }

    let audioTrack = await input.getPrimaryAudioTrack()
    if (audioTrack && !(await audioTrack.canDecode())) {
      audioTrack = null
    }

    const videoStart = await videoTrack.getFirstTimestamp()
    const videoEnd = await videoTrack.computeDuration()
    const videoDuration = Math.max(0, videoEnd - videoStart)
    const audioStart = audioTrack ? await audioTrack.getFirstTimestamp() : videoStart
    const audioEnd = audioTrack ? await audioTrack.computeDuration() : videoStart
    const audioDuration = audioTrack ? Math.max(0, audioEnd - audioStart) : 0
    // El export usa project.fps y los assets no necesitan fps: omitir el
    // sondeo de 128 paquetes cuando el llamante no lo necesita.
    const frameRate = options.skipFrameRate
      ? null
      : await videoTrack
          .computeFrameRateMetrics({ targetPacketCount: 128 })
          .catch(() => null)

    const info: EditorMediaInfo = {
      duration: Math.max(videoDuration, audioDuration),
      width: Math.max(2, Math.round(videoTrack.displayWidth)),
      height: Math.max(2, Math.round(videoTrack.displayHeight)),
      fps: Math.max(1, Math.round(frameRate?.bestGuessFrameRate || 30)),
      hasAudio: Boolean(audioTrack),
      startTimestamp: Number.isFinite(videoStart) ? videoStart : 0,
      audioStartTimestamp: Number.isFinite(audioStart) ? audioStart : 0,
    }

    const opened: OpenedMedia = {
      input,
      videoTrack,
      audioTrack,
      info,
      createSink(request = {}) {
        return new CanvasSink(videoTrack, {
          alpha: false,
          poolSize: 2,
          fit: 'contain',
          ...request,
        })
      },
      dispose() {
        if (disposed) return
        disposed = true
        input.dispose()
        release()
      },
    }
    return opened
  } catch (error) {
    input.dispose()
    release()
    throw error
  }
}

export async function probeImage(
  file: Blob,
): Promise<{ width: number; height: number; bitmap: ImageBitmap }> {
  const bitmap = await createImageBitmap(file)
  return { width: bitmap.width, height: bitmap.height, bitmap }
}

export interface AudioWaveformData {
  bins: Float32Array
  duration: number
}

export async function computeAudioWaveform(
  file: Blob,
  options: { signal?: AbortSignal } = {},
): Promise<AudioWaveformData | null> {
  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  })
  const release = trackResource('editorInput')
  const abort = () => input.dispose()
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track || !(await track.canDecode())) return null
    const audioStart = await track.getFirstTimestamp()
    const audioEnd = await track.computeDuration()
    const duration = Math.max(0, audioEnd - audioStart)
    if (duration <= 0) return null

    const binCount = Math.max(
      256,
      Math.min(20_000, Math.ceil(duration * 16)),
    )
    const sums = new Float64Array(binCount)
    const counts = new Uint32Array(binCount)
    const stride = Math.max(
      1,
      Math.floor((duration * 48_000) / (binCount * 256)),
    )
    // Lee samples PCM directamente y mide bins RMS sin pasar por AudioBuffer.
    const sink = new AudioSampleSink(track)
    // Buffers planos reutilizables por canal para evitar asignar por sample.
    let planeBuffers: Float32Array[] = []
    let planeCapacity = 0

    for await (const sample of sink.samples(audioStart, audioEnd)) {
      try {
        if (options.signal?.aborted) {
          throw new DOMException('Análisis de audio cancelado.', 'AbortError')
        }
        const channels = sample.numberOfChannels
        const frames = sample.numberOfFrames
        if (frames <= 0 || channels <= 0) continue
        if (planeCapacity < frames) {
          planeCapacity = frames
          planeBuffers = Array.from(
            { length: Math.max(channels, planeBuffers.length) },
            () => new Float32Array(planeCapacity),
          )
          while (planeBuffers.length < channels) {
            planeBuffers.push(new Float32Array(planeCapacity))
          }
        }
        while (planeBuffers.length < channels) {
          planeBuffers.push(new Float32Array(Math.max(1, planeCapacity)))
        }
        for (let channel = 0; channel < channels; channel += 1) {
          sample.copyTo(planeBuffers[channel], {
            planeIndex: channel,
            format: 'f32-planar',
          })
        }
        const sampleRate = sample.sampleRate
        const relativeStart = Math.max(0, sample.timestamp - audioStart)
        const step = Math.max(1, Math.round(stride * (sampleRate / 48_000)))
        for (let index = 0; index < frames; index += step) {
          const time = relativeStart + index / sampleRate
          if (time >= duration) break
          const bin = Math.min(
            binCount - 1,
            Math.max(0, Math.floor((time / duration) * binCount)),
          )
          let energy = 0
          for (let channel = 0; channel < channels; channel += 1) {
            const value = planeBuffers[channel][index] ?? 0
            energy += value * value
          }
          sums[bin] += energy / channels
          counts[bin] += 1
        }
      } finally {
        sample.close()
      }
    }

    const bins = new Float32Array(binCount)
    for (let index = 0; index < binCount; index += 1) {
      bins[index] =
        counts[index] > 0
          ? Math.sqrt(sums[index] / counts[index])
          : 0
    }
    return { bins, duration }
  } finally {
    options.signal?.removeEventListener('abort', abort)
    input.dispose()
    release()
  }
}
