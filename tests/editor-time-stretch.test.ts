import { expect, test } from 'vitest'
import {
  TimeStretchProcessor,
  resampleLinear,
  stretchChannels,
} from '../src/lib/editor/time-stretch.ts'

const SAMPLE_RATE = 48_000
const FREQUENCY = 440

function sine(seconds: number, sampleRate = SAMPLE_RATE, frequency = FREQUENCY): Float32Array {
  const frames = Math.round(seconds * sampleRate)
  const data = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) {
    data[index] = Math.sin((2 * Math.PI * frequency * index) / sampleRate)
  }
  return data
}

function zeroCrossingsPerSecond(samples: Float32Array): number {
  let crossings = 0
  let previous = samples[0] >= 0
  for (let index = 1; index < samples.length; index += 1) {
    const current = samples[index] >= 0
    if (current !== previous) crossings += 1
    previous = current
  }
  return crossings / (samples.length / SAMPLE_RATE)
}

function middle(samples: Float32Array): Float32Array {
  const start = Math.floor(samples.length * 0.25)
  const end = Math.floor(samples.length * 0.75)
  return samples.subarray(start, end)
}

test('resamples a tone to another sample rate without changing its pitch', () => {
  const input = sine(1, 44_100)
  const output = resampleLinear(input, 44_100, SAMPLE_RATE)
  expect(Math.abs(output.length - SAMPLE_RATE)).toBeLessThanOrEqual(1)
  const frequency = zeroCrossingsPerSecond(middle(output)) / 2
  expect(Math.abs(frequency - FREQUENCY)).toBeLessThan(15)
})

for (const speed of [0.5, 1.5, 2]) {
  test(`preserves pitch at ${speed}× and produces the expected duration`, () => {
    const input = sine(2)
    const output = stretchChannels([input], speed, SAMPLE_RATE)
    const expected = input.length / speed
    expect(Math.abs(output[0].length - expected)).toBeLessThan(SAMPLE_RATE * 0.12)
    const frequency = zeroCrossingsPerSecond(middle(output[0])) / 2
    expect(Math.abs(frequency - FREQUENCY)).toBeLessThan(25)
    let peak = 0
    for (const sample of output[0]) {
      expect(Number.isFinite(sample)).toBe(true)
      peak = Math.max(peak, Math.abs(sample))
    }
    expect(peak).toBeGreaterThan(0.5)
    expect(peak).toBeLessThan(2.5)
  })
}

test('streams input in chunks and emits contiguous output', () => {
  const input = sine(1)
  const processor = new TimeStretchProcessor({
    sampleRate: SAMPLE_RATE,
    channels: 1,
    speed: 1.5,
  })
  const output: number[] = []
  const chunkSize = 1024
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    processor.push([input.subarray(offset, offset + chunkSize)])
    const chunk = processor.pull(512)
    for (const value of chunk.channels[0]) output.push(value)
  }
  processor.finish()
  while (true) {
    const chunk = processor.pull(512)
    if (chunk.frames === 0) break
    for (const value of chunk.channels[0]) output.push(value)
  }
  expect(output.length).toBeGreaterThan(SAMPLE_RATE * 0.5)
  expect(output.every((value) => Number.isFinite(value))).toBe(true)
})