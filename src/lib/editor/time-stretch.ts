const WINDOW_SECONDS = 0.04
const SEARCH_SECONDS = 0.01
const CORRELATION_STEP = 4

export interface TimeStretchOptions {
  sampleRate: number
  channels: number
  speed: number
}

export interface StretchedChunk {
  channels: Float32Array[]
  frames: number
}

function hannWindow(frames: number): Float32Array {
  const window = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / frames)
  }
  return window
}

export function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || input.length === 0) return input
  const frames = Math.max(1, Math.round((input.length * toRate) / fromRate))
  const output = new Float32Array(frames)
  const ratio = fromRate / toRate
  for (let index = 0; index < frames; index += 1) {
    const position = index * ratio
    const left = Math.floor(position)
    const right = Math.min(input.length - 1, left + 1)
    const fraction = position - left
    output[index] = input[left] * (1 - fraction) + input[right] * fraction
  }
  return output
}

export class TimeStretchProcessor {
  #sampleRate: number
  #channels: number
  #speed: number
  #windowFrames: number
  #hopFrames: number
  #searchFrames: number
  #hopIn: number
  #window: Float32Array
  #buffer: Float32Array[]
  #bufferStart = 0
  #bufferLength = 0
  #accum: Float32Array[]
  #previousStart = -1
  #outputChunks: Float32Array[][] = []
  #outputHead = 0
  #readOffset = 0
  #finished = false
  #blocks = 0
  #midCache = new Float32Array(0)
  #midCacheLength = -1

  constructor(options: TimeStretchOptions) {
    const rate = Math.max(8000, Math.round(options.sampleRate))
    this.#sampleRate = rate
    this.#channels = Math.max(1, Math.round(options.channels))
    this.#speed = Math.min(2, Math.max(0.5, options.speed))
    this.#windowFrames = Math.max(128, Math.round(rate * WINDOW_SECONDS / 2) * 2)
    this.#hopFrames = this.#windowFrames / 2
    this.#searchFrames = Math.max(16, Math.round(rate * SEARCH_SECONDS))
    this.#hopIn = this.#hopFrames * this.#speed
    this.#window = hannWindow(this.#windowFrames)
    this.#buffer = Array.from(
      { length: this.#channels },
      () => new Float32Array(this.#windowFrames * 4),
    )
    this.#accum = Array.from(
      { length: this.#channels },
      () => new Float32Array(this.#windowFrames),
    )
  }

  get channelCount(): number {
    return this.#channels
  }

  get outputFramesProduced(): number {
    return this.#blocks * this.#hopFrames
  }

  push(channels: Float32Array[]): void {
    const frames = channels[0]?.length ?? 0
    if (frames === 0) return
    this.#ensureCapacity(frames)
    for (let channel = 0; channel < this.#channels; channel += 1) {
      const source =
        channels[Math.min(channel, channels.length - 1)] ??
        new Float32Array(frames)
      this.#buffer[channel].set(
        source.subarray(0, frames),
        this.#bufferLength,
      )
    }
    this.#bufferLength += frames
    this.#midCacheLength = -1
  }

  finish(): void {
    this.#finished = true
    this.#processAvailable()
  }

  pull(frames: number): StretchedChunk {
    this.#processAvailable()
    const output = Array.from(
      { length: this.#channels },
      () => new Float32Array(frames),
    )
    let written = 0
    while (written < frames && this.#outputHead < this.#outputChunks.length) {
      const chunk = this.#outputChunks[this.#outputHead]
      const available = chunk[0].length - this.#readOffset
      const take = Math.min(available, frames - written)
      for (let channel = 0; channel < this.#channels; channel += 1) {
        output[channel].set(
          chunk[channel].subarray(this.#readOffset, this.#readOffset + take),
          written,
        )
      }
      written += take
      if (take === available) {
        this.#outputHead += 1
        this.#readOffset = 0
      } else {
        this.#readOffset += take
      }
    }
    // Compacta la cola de vez en cuando para no retener chunks consumidos.
    if (this.#outputHead > 64 && this.#outputHead >= this.#outputChunks.length / 2) {
      this.#outputChunks.splice(0, this.#outputHead)
      this.#outputHead = 0
    }
    return {
      channels: output.map((channel) => channel.subarray(0, written)),
      frames: written,
    }
  }

  #expectedStart(): number {
    // Use the nominal analysis grid, not the previous search result. Otherwise
    // small search offsets accumulate and change the clip's duration.
    return Math.max(
      0,
      Math.round(this.#blocks * this.#hopFrames * this.#speed),
    )
  }

  #effectiveSearch(): number {
    // The window must always advance; otherwise a periodic signal can make
    // WSOLA repeat the same input window forever.
    return Math.max(
      1,
      Math.min(this.#searchFrames, Math.floor(this.#hopIn) - 1),
    )
  }

  #bufferEnd(): number {
    return this.#bufferStart + this.#bufferLength
  }

  #ensureCapacity(extra: number): void {
    const required = this.#bufferLength + extra
    const current = this.#buffer[0].length
    if (required <= current) return
    let capacity = current
    while (capacity < required) capacity *= 2
    this.#buffer = this.#buffer.map((channel) => {
      const next = new Float32Array(capacity)
      next.set(channel.subarray(0, this.#bufferLength))
      return next
    })
  }

  #trim(): void {
    const expected = this.#expectedStart()
    const search = this.#effectiveSearch()
    const keepFrom = Math.max(
      0,
      Math.floor(
        expected - search - this.#windowFrames,
      ),
    )
    const remove = keepFrom - this.#bufferStart
    if (remove <= 0) return
    for (const channel of this.#buffer) {
      channel.copyWithin(0, remove, this.#bufferLength)
    }
    this.#bufferStart += remove
    this.#bufferLength -= remove
    this.#midCacheLength = -1
  }

  #processAvailable(): void {
    this.#trim()
    let guard = 0
    while (guard < 10000) {
      guard += 1
      const expected = this.#expectedStart()
      const search = this.#effectiveSearch()
      const low = Math.max(
        this.#bufferStart,
        Math.floor(expected - search),
        this.#previousStart >= 0 ? this.#previousStart + 1 : 0,
      )
      const high = Math.min(
        Math.floor(expected + search),
        this.#finished
          ? this.#bufferEnd() - 1
          : this.#bufferEnd() - this.#windowFrames,
      )
      if (high < low) break

      const candidate =
        this.#previousStart < 0
          ? Math.max(low, Math.min(high, Math.round(expected)))
          : this.#findCandidate(low, high)
      if (candidate < 0) break

      this.#renderWindow(candidate)
      this.#previousStart = candidate
      this.#blocks += 1

      if (this.#finished && this.#expectedStart() >= this.#bufferEnd()) {
        break
      }
    }
  }

  #findCandidate(low: number, high: number): number {
    const templateStart = this.#previousStart + this.#hopFrames
    const templateOffset = templateStart - this.#bufferStart
    if (
      templateOffset < 0 ||
      templateOffset + this.#hopFrames > this.#bufferLength
    ) {
      return Math.max(low, Math.min(high, Math.round(this.#expectedStart())))
    }

    const mid = this.#midChannel()
    const template = mid.subarray(
      templateOffset,
      templateOffset + this.#hopFrames,
    )
    const expected = this.#expectedStart()
    const search = this.#effectiveSearch()
    // Energía de la plantilla precalculada una vez: no cambia por candidato.
    let templateEnergy = 0
    for (let index = 0; index < template.length; index += 2) {
      const value = template[index]
      templateEnergy += value * value
    }
    const invSearch = search > 0 ? 1 / search : 1

    let best = -1
    let bestScore = -Infinity
    const searchStep = Math.max(1, CORRELATION_STEP)
    // Bucle sin closures ni llamadas por candidato: correlación inline.
    for (let candidate = low; candidate <= high; candidate += searchStep) {
      const offset = candidate - this.#bufferStart
      let score: number
      if (offset < 0 || offset + template.length > this.#bufferLength) {
        score = -Infinity
      } else {
        let dot = 0
        let energy = 0
        for (let index = 0; index < template.length; index += 2) {
          const value = mid[offset + index]
          dot += value * template[index]
          energy += value * value
        }
        if (energy <= 1e-9 || templateEnergy <= 1e-9) {
          score = 0
        } else {
          score = dot / Math.sqrt(energy * templateEnergy)
        }
        // Las señales periódicas hacen que muchos candidatos parezcan igual
        // de buenos; preferir el más cercano al salto esperado evita que
        // WSOLA se adelante y acorte el clip.
        score -= (Math.abs(candidate - expected) * invSearch) * 0.02
      }
      if (score > bestScore) {
        bestScore = score
        best = candidate
      }
    }
    const refineLow = Math.max(low, best - searchStep)
    const refineHigh = Math.min(high, best + searchStep)
    for (let candidate = refineLow; candidate <= refineHigh; candidate += 1) {
      const offset = candidate - this.#bufferStart
      let score: number
      if (offset < 0 || offset + template.length > this.#bufferLength) {
        score = -Infinity
      } else {
        let dot = 0
        let energy = 0
        for (let index = 0; index < template.length; index += 2) {
          const value = mid[offset + index]
          dot += value * template[index]
          energy += value * value
        }
        if (energy <= 1e-9 || templateEnergy <= 1e-9) {
          score = 0
        } else {
          score = dot / Math.sqrt(energy * templateEnergy)
        }
        score -= (Math.abs(candidate - expected) * invSearch) * 0.02
      }
      if (score > bestScore) {
        bestScore = score
        best = candidate
      }
    }
    return best >= 0
      ? best
      : Math.max(low, Math.min(high, Math.round(expected)))
  }

  #midChannel(): Float32Array {
    if (this.#channels === 1) return this.#buffer[0]
    if (this.#midCacheLength === this.#bufferLength && this.#midCache.length >= this.#bufferLength) {
      return this.#midCache.subarray(0, this.#bufferLength) as Float32Array
    }
    if (this.#midCache.length < this.#bufferLength) {
      this.#midCache = new Float32Array(Math.max(1024, this.#bufferLength))
    }
    const mid = this.#midCache
    const left = this.#buffer[0]
    const right = this.#buffer[1] ?? left
    for (let index = 0; index < this.#bufferLength; index += 1) {
      mid[index] = (left[index] + right[index]) / 2
    }
    this.#midCacheLength = this.#bufferLength
    return mid.subarray(0, this.#bufferLength) as Float32Array
  }

  #renderWindow(candidate: number): void {
    const offset = candidate - this.#bufferStart
    const frames = this.#windowFrames
    const hop = this.#hopFrames
    for (let channel = 0; channel < this.#channels; channel += 1) {
      const source = this.#buffer[channel]
      const accum = this.#accum[channel]
      const window = this.#window
      for (let index = 0; index < frames; index += 1) {
        const sourceIndex = offset + index
        const sample =
          sourceIndex >= 0 && sourceIndex < this.#bufferLength
            ? source[sourceIndex]
            : 0
        accum[index] += sample * window[index]
      }
    }
    const chunk = this.#accum.map((channel) => channel.slice(0, hop))
    this.#outputChunks.push(chunk)
    for (const channel of this.#accum) {
      channel.copyWithin(0, hop)
      channel.fill(0, frames - hop)
    }
  }
}

export function stretchChannels(
  input: Float32Array[],
  speed: number,
  sampleRate: number,
): Float32Array[] {
  const channels = input.length
  if (Math.abs(speed - 1) < 1e-4) return input
  const processor = new TimeStretchProcessor({ sampleRate, channels, speed })
  processor.push(input)
  processor.finish()
  const desired = Math.max(
    1,
    Math.round(input[0].length / Math.max(0.5, speed)),
  )
  const output = Array.from(
    { length: channels },
    () => new Float32Array(desired),
  )
  let written = 0
  while (written < desired) {
    const chunk = processor.pull(desired - written)
    if (chunk.frames === 0) break
    for (let channel = 0; channel < channels; channel += 1) {
      output[channel].set(chunk.channels[channel], written)
    }
    written += chunk.frames
  }
  return output.map((channel) => channel.subarray(0, written))
}
