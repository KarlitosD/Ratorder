import { TimeStretchProcessor, resampleLinear } from './time-stretch'
import type { EditorClip } from './types'

export interface DecodedAudioFrame {
  channels: Float32Array[]
  sampleRate: number
  timestamp: number
}

export interface AudioFrameChunk {
  channels: Float32Array[]
  frames: number
}

interface ChunkAccumulator {
  buffer: Float32Array[]
  filled: number
  chunkFrames: number
  channels: number
}

function createAccumulator(
  chunkFrames: number,
  channels: number,
): ChunkAccumulator {
  return {
    buffer: Array.from(
      { length: channels },
      () => new Float32Array(chunkFrames),
    ),
    filled: 0,
    chunkFrames,
    channels,
  }
}

function buildChunk(state: ChunkAccumulator): AudioFrameChunk {
  const channels = state.buffer.map((channel) =>
    channel.slice(0, state.filled),
  )
  return { channels, frames: state.filled }
}

function pushFrames(
  state: ChunkAccumulator,
  source: Float32Array[],
  offset: number,
  count: number,
): AudioFrameChunk[] {
  const completed: AudioFrameChunk[] = []
  while (count > 0) {
    const take = Math.min(count, state.chunkFrames - state.filled)
    for (let channel = 0; channel < state.channels; channel += 1) {
      const data =
        source[Math.min(channel, source.length - 1)] ??
        new Float32Array(offset + take)
      state.buffer[channel].set(
        data.subarray(offset, offset + take),
        state.filled,
      )
    }
    state.filled += take
    offset += take
    count -= take
    if (state.filled >= state.chunkFrames) {
      completed.push(buildChunk(state))
      state.filled = 0
    }
  }
  return completed
}

function flushChunk(state: ChunkAccumulator): AudioFrameChunk | null {
  if (state.filled <= 0) return null
  const chunk = buildChunk(state)
  state.filled = 0
  return chunk
}

function resampleChannels(
  channels: Float32Array[],
  fromRate: number,
  toRate: number,
): Float32Array[] {
  if (fromRate === toRate) return channels
  return channels.map((channel) => resampleLinear(channel, fromRate, toRate))
}

function trimChannels(
  channels: Float32Array[],
  start: number,
  end: number,
): Float32Array[] {
  return channels.map((channel) =>
    channel.subarray(
      Math.min(Math.max(0, start), channel.length),
      Math.min(Math.max(0, end), channel.length),
    ),
  )
}

export interface FrameSourceOptions {
  signal?: AbortSignal
  yieldBetweenBlocks?: () => Promise<void> | void
}

async function* silentFrameChunks(
  desiredFrames: number,
  channels: number,
  chunkFrames: number,
  options: FrameSourceOptions = {},
): AsyncGenerator<AudioFrameChunk> {
  let remaining = desiredFrames
  const silence = new Float32Array(chunkFrames)
  while (remaining > 0) {
    options.signal?.throwIfAborted?.()
    const frames = Math.min(remaining, chunkFrames)
    if (frames < chunkFrames) {
      yield {
        channels: Array.from(
          { length: channels },
          () => new Float32Array(frames),
        ),
        frames,
      }
    } else {
      // Reutiliza el mismo bloque de silencio emitiendo copias por chunk.
      yield {
        channels: Array.from({ length: channels }, () => silence.slice()),
        frames,
      }
    }
    remaining -= frames
    if (options.yieldBetweenBlocks) await options.yieldBetweenBlocks()
  }
}

async function* constantSpeedFrameChunks(
  frames: AsyncIterable<DecodedAudioFrame>,
  clip: EditorClip,
  audioStart: number,
  desiredFrames: number,
  sampleRate: number,
  channels: number,
  chunkFrames: number,
  options: FrameSourceOptions = {},
): AsyncGenerator<AudioFrameChunk> {
  const state = createAccumulator(chunkFrames, channels)
  let written = 0
  for await (const decoded of frames) {
    options.signal?.throwIfAborted?.()
    if (written >= desiredFrames) break
    const relativeSeconds = decoded.timestamp - audioStart - clip.inPoint
    const bufferStart = Math.round(relativeSeconds * sampleRate)
    let data = resampleChannels(
      decoded.channels.slice(0, channels).map((channel, index) => {
        void index
        return channel
      }),
      decoded.sampleRate,
      sampleRate,
    )
    // Normaliza a `channels` canales.
    while (data.length < channels) data = [...data, data[data.length - 1]]
    data = data.slice(0, channels)
    let dataStart = 0
    let dataEnd = data[0]?.length ?? 0
    if (bufferStart < 0) {
      const skip = Math.min(dataEnd, -bufferStart)
      dataStart += skip
    }
    if (bufferStart + dataEnd > desiredFrames) {
      dataEnd = Math.max(dataStart, desiredFrames - bufferStart)
    }
    if (dataEnd <= dataStart) continue
    const targetStart = Math.max(written, bufferStart)
    if (targetStart > written) {
      const silence = targetStart - written
      const silenceSource = Array.from(
        { length: channels },
        () => new Float32Array(silence),
      )
      for (const chunk of pushFrames(state, silenceSource, 0, silence)) {
        yield chunk
      }
      written = targetStart
    }
    const skip = Math.max(0, written - bufferStart)
    const offset = dataStart + skip
    const available = dataEnd - dataStart - skip
    if (available <= 0) continue
    const trimmed = trimChannels(data, offset, offset + available)
    const count = Math.min(available, desiredFrames - written)
    for (const chunk of pushFrames(state, trimmed, 0, count)) {
      yield chunk
    }
    written += count
    if (options.yieldBetweenBlocks) await options.yieldBetweenBlocks()
  }
  if (written < desiredFrames) {
    const silenceSource = Array.from(
      { length: channels },
      () => new Float32Array(desiredFrames - written),
    )
    for (const chunk of pushFrames(
      state,
      silenceSource,
      0,
      desiredFrames - written,
    )) {
      yield chunk
    }
    written = desiredFrames
  }
  const tail = flushChunk(state)
  if (tail) yield tail
}

async function* stretchedFrameChunks(
  frames: AsyncIterable<DecodedAudioFrame>,
  clip: EditorClip,
  audioStart: number,
  desiredFrames: number,
  sampleRate: number,
  channels: number,
  chunkFrames: number,
  options: FrameSourceOptions = {},
): AsyncGenerator<AudioFrameChunk> {
  const processor = new TimeStretchProcessor({
    sampleRate,
    channels,
    speed: clip.speed,
  })
  const state = createAccumulator(chunkFrames, channels)
  const sourceFrames = Math.max(1, Math.round(clip.sourceSpan * sampleRate))
  let fed = 0
  let written = 0

  const pullIntoChunks = function* (): Generator<AudioFrameChunk> {
    while (written < desiredFrames) {
      const want = Math.min(chunkFrames - state.filled, desiredFrames - written)
      if (want <= 0) break
      const chunk = processor.pull(want)
      if (chunk.frames <= 0) break
      for (const audio of pushFrames(state, chunk.channels, 0, chunk.frames)) {
        yield audio
      }
      written += chunk.frames
    }
  }

  for await (const decoded of frames) {
    options.signal?.throwIfAborted?.()
    if (fed >= sourceFrames) break
    const relativeSeconds = decoded.timestamp - audioStart - clip.inPoint
    const bufferStart = Math.round(relativeSeconds * sampleRate)
    let data = resampleChannels(
      decoded.channels.slice(0, channels),
      decoded.sampleRate,
      sampleRate,
    )
    while (data.length < channels) data = [...data, data[data.length - 1]]
    data = data.slice(0, channels)
    let dataStart = 0
    let dataEnd = data[0]?.length ?? 0
    if (bufferStart < 0) {
      dataStart += Math.min(dataEnd, -bufferStart)
    }
    if (bufferStart + dataEnd > sourceFrames) {
      dataEnd = Math.max(dataStart, sourceFrames - bufferStart)
    }
    if (dataEnd <= dataStart) continue
    const targetStart = Math.max(fed, bufferStart)
    if (targetStart > fed) {
      // Rellena huecos con silencio en bloques acotados para no reservar
      // memoria proporcional al hueco.
      let missing = targetStart - fed
      const zeroBlock = Math.max(1024, chunkFrames)
      while (missing > 0) {
        options.signal?.throwIfAborted?.()
        const take = Math.min(missing, zeroBlock)
        processor.push([
          new Float32Array(take),
          new Float32Array(take),
        ].slice(0, channels))
        fed += take
        missing -= take
      }
    }
    const skip = Math.max(0, fed - bufferStart)
    const offset = dataStart + skip
    const available = dataEnd - dataStart - skip
    if (available <= 0) continue
    // Alimenta WSOLA por bloques para ceder al event loop y poder cancelar.
    const feedBlock = Math.max(4096, chunkFrames)
    let fedOffset = offset
    let remaining = available
    while (remaining > 0) {
      options.signal?.throwIfAborted?.()
      const take = Math.min(remaining, feedBlock)
      processor.push(trimChannels(data, fedOffset, fedOffset + take))
      fed += take
      fedOffset += take
      remaining -= take
      yield* pullIntoChunks()
      if (options.yieldBetweenBlocks) await options.yieldBetweenBlocks()
    }
    yield* pullIntoChunks()
  }
  processor.finish()
  yield* pullIntoChunks()
  if (written < desiredFrames) {
    const missing = desiredFrames - written
    const silenceSource = Array.from(
      { length: channels },
      () => new Float32Array(Math.min(missing, chunkFrames)),
    )
    let remaining = missing
    while (remaining > 0) {
      options.signal?.throwIfAborted?.()
      const take = Math.min(remaining, chunkFrames)
      for (const chunk of pushFrames(state, silenceSource, 0, take)) {
        yield chunk
      }
      remaining -= take
      if (options.yieldBetweenBlocks) await options.yieldBetweenBlocks()
    }
    written = desiredFrames
  }
  const tail = flushChunk(state)
  if (tail) yield tail
}

function applyGainToChunk(chunk: AudioFrameChunk, gain: number): void {
  if (gain === 1) return
  for (const channel of chunk.channels) {
    for (let index = 0; index < channel.length; index += 1) {
      channel[index] *= gain
    }
  }
}

export interface ClipAudioFramesRequest {
  clip: EditorClip
  audioStart: number
  hasAudio: boolean
  startFrame: number
  endFrame: number
  sampleRate: number
  channels: number
  chunkFrames: number
  signal?: AbortSignal
  readFrames: () => AsyncIterable<DecodedAudioFrame>
  yieldBetweenBlocks?: () => Promise<void> | void
}

export async function* clipAudioFrames(
  request: ClipAudioFramesRequest,
): AsyncGenerator<AudioFrameChunk> {
  const desiredFrames = Math.max(0, request.endFrame - request.startFrame)
  if (desiredFrames <= 0) return
  const gain = request.clip.muted
    ? 0
    : Math.min(1.5, Math.max(0, request.clip.volume ?? 1))
  if (gain <= 0 || !request.hasAudio) {
    yield* silentFrameChunks(
      desiredFrames,
      request.channels,
      request.chunkFrames,
      { signal: request.signal, yieldBetweenBlocks: request.yieldBetweenBlocks },
    )
    return
  }
  const options: FrameSourceOptions = {
    signal: request.signal,
    yieldBetweenBlocks: request.yieldBetweenBlocks,
  }
  const source =
    Math.abs(request.clip.speed - 1) < 1e-4
      ? constantSpeedFrameChunks(
          request.readFrames(),
          request.clip,
          request.audioStart,
          desiredFrames,
          request.sampleRate,
          request.channels,
          request.chunkFrames,
          options,
        )
      : stretchedFrameChunks(
          request.readFrames(),
          request.clip,
          request.audioStart,
          desiredFrames,
          request.sampleRate,
          request.channels,
          request.chunkFrames,
          options,
        )
  for await (const chunk of source) {
    applyGainToChunk(chunk, gain)
    yield chunk
  }
}
