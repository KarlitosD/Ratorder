import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyzeSync } from '../scripts/av-sync-analysis.mjs'

function signals(offsetSamples = 0) {
  const fps = 20, rate = 1000
  const video = new Uint8Array(100)
  const audio = new Float32Array(5000)
  for (const second of [1, 2, 3, 4]) {
    video.fill(255, second * fps, second * fps + 2)
    audio.fill(0.5, second * rate + offsetSamples, second * rate + offsetSamples + 100)
  }
  return { video, audio, fps, rate }
}

test('measures initial offset and drift from corresponding flashes and pulses', () => {
  const result = analyzeSync(signals(100))
  assert.equal(result.events.length, 4)
  assert.ok(Math.abs(result.initialOffsetMs - 100) < 1)
  assert.ok(Math.abs(result.driftMs) < 1)
})

test('rejects incomplete events rather than reporting false synchronization', () => {
  const input = signals()
  input.audio.fill(0, 3000, 3100)
  assert.throws(() => analyzeSync(input), /event/i)
})

test('detects changing offset instead of confusing it with initial latency', () => {
  const input = signals(50)
  input.audio.fill(0, 4050, 4150)
  input.audio.fill(0.5, 4200, 4300)
  const result = analyzeSync(input)
  assert.ok(Math.abs(result.initialOffsetMs - 50) < 1)
  assert.ok(Math.abs(result.driftMs - 150) < 1)
})

test('accounts for different stream start timestamps', () => {
  const result = analyzeSync({ ...signals(), videoStart: 0.2, audioStart: 0.3 })
  assert.ok(Math.abs(result.initialOffsetMs - 100) < 1)
  assert.ok(Math.abs(result.driftMs) < 1)
})
