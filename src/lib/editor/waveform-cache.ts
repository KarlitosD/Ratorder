import type { RecordingStore } from '../storage/recording-store'

export const WAVEFORM_CACHE_VERSION = 1
const MAGIC = 'RTWF'
const HEADER_BYTES = 28
const MIN_BINS = 1
const MAX_BINS = 20_000

export function waveformSafeName(mediaId: string): string {
  const safe = mediaId.replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 64) || 'media'
  return `${safe}.bin`
}

export function encodeWaveformCache(options: {
  mediaSize: number
  duration: number
  bins: Float32Array
}): Uint8Array {
  const { mediaSize, duration, bins } = options
  const buffer = new ArrayBuffer(HEADER_BYTES + bins.length * 4)
  const view = new DataView(buffer)
  view.setUint8(0, MAGIC.charCodeAt(0))
  view.setUint8(1, MAGIC.charCodeAt(1))
  view.setUint8(2, MAGIC.charCodeAt(2))
  view.setUint8(3, MAGIC.charCodeAt(3))
  view.setUint32(4, WAVEFORM_CACHE_VERSION, true)
  view.setFloat64(8, mediaSize, true)
  view.setFloat64(16, duration, true)
  view.setUint32(24, bins.length, true)
  new Float32Array(buffer, HEADER_BYTES, bins.length).set(bins)
  return new Uint8Array(buffer)
}

export interface DecodedWaveformCache {
  bins: Float32Array
  duration: number
  mediaSize: number
}

export function decodeWaveformCache(
  data: ArrayBuffer,
  options: { expectedSize?: number; expectedDuration?: number } = {},
): DecodedWaveformCache | null {
  if (data.byteLength < HEADER_BYTES) return null
  const view = new DataView(data)
  if (
    view.getUint8(0) !== MAGIC.charCodeAt(0) ||
    view.getUint8(1) !== MAGIC.charCodeAt(1) ||
    view.getUint8(2) !== MAGIC.charCodeAt(2) ||
    view.getUint8(3) !== MAGIC.charCodeAt(3)
  ) {
    return null
  }
  const version = view.getUint32(4, true)
  if (version !== WAVEFORM_CACHE_VERSION) return null
  const mediaSize = view.getFloat64(8, true)
  const duration = view.getFloat64(16, true)
  const binCount = view.getUint32(24, true)
  if (
    !Number.isFinite(mediaSize) ||
    !Number.isFinite(duration) ||
    !Number.isInteger(binCount) ||
    binCount < MIN_BINS ||
    binCount > MAX_BINS
  ) {
    return null
  }
  if (duration <= 0 || !Number.isFinite(duration)) return null
  if (data.byteLength !== HEADER_BYTES + binCount * 4) return null
  if (
    options.expectedSize !== undefined &&
    Math.abs(mediaSize - options.expectedSize) > 0
  ) {
    return null
  }
  if (options.expectedDuration !== undefined) {
    const expected = options.expectedDuration
    if (!Number.isFinite(expected) || expected <= 0) return null
    const tolerance = Math.max(0.05, Math.abs(expected) * 0.01)
    if (Math.abs(duration - expected) > tolerance) return null
  }
  const bins = new Float32Array(binCount)
  bins.set(new Float32Array(data, HEADER_BYTES, binCount))
  for (let index = 0; index < bins.length; index += 1) {
    const value = bins[index]
    if (!Number.isFinite(value) || value < 0) return null
  }
  return { bins, duration, mediaSize }
}

export async function readWaveformCache(
  store: RecordingStore,
  recordingId: string,
  mediaId: string,
  expected: { size: number; duration: number },
): Promise<DecodedWaveformCache | null> {
  try {
    const bytes = await store.getWaveformBytes(
      recordingId,
      waveformSafeName(mediaId),
    )
    if (!bytes) return null
    // Copia a un ArrayBuffer exacto para DataView/Float32Array.
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    return decodeWaveformCache(copy.buffer as ArrayBuffer, {
      expectedSize: expected.size,
      expectedDuration: expected.duration,
    })
  } catch {
    return null
  }
}

export async function writeWaveformCache(
  store: RecordingStore,
  recordingId: string,
  mediaId: string,
  data: { bins: Float32Array; duration: number; mediaSize: number },
): Promise<void> {
  const payload = encodeWaveformCache(data)
  await store.saveWaveformBytes(
    recordingId,
    waveformSafeName(mediaId),
    payload,
  )
}
