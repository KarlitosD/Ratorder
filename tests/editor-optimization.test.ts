import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  createDefaultProject,
  findClipAt,
  findClipIndexAt,
  layoutTimeline,
  projectDuration,
  splitAt,
  visibleTicks,
} from '../src/lib/editor/model.ts'
import { drawIntervalFor } from '../src/lib/editor/player.ts'
import {
  decodeWaveformCache,
  encodeWaveformCache,
} from '../src/lib/editor/waveform-cache.ts'

function makeProject() {
  return createDefaultProject({
    sourceId: 'rec-1',
    title: 'Demo',
    source: {
      duration: 10,
      width: 1280,
      height: 720,
      fps: 30,
      container: 'mp4',
      hasAudio: true,
      extension: 'mp4',
    },
    now: '2026-11-01T00:00:00.000Z',
  })
}

test('layout and duration are memoized per project instance', () => {
  const project = makeProject()
  assert.equal(layoutTimeline(project), layoutTimeline(project))
  assert.equal(projectDuration(project), 10)
  const split = splitAt(project, 4)
  assert.notEqual(layoutTimeline(split), layoutTimeline(project))
  assert.equal(projectDuration(split), 10)
})

test('binary search preserves findClipAt edge semantics', () => {
  const project = splitAt(makeProject(), 4)
  assert.equal(findClipIndexAt(project, -5), 0)
  assert.equal(findClipAt(project, -5)?.clip.id, project.clips[0].id)
  // Exact cut belongs to the next clip.
  assert.equal(findClipIndexAt(project, 4), 1)
  assert.equal(findClipAt(project, 4)?.clip.id, project.clips[1].id)
  // End of project returns the last clip.
  const duration = projectDuration(project)
  assert.equal(findClipAt(project, duration)?.clip.id, project.clips[1].id)
  assert.equal(
    findClipAt(project, duration + 100)?.clip.id,
    project.clips[1].id,
  )
})

test('visibleTicks depends on the viewport, not the duration', () => {
  const all = visibleTicks(3600, 240, 1, 0, 1_000_000)
  const windowed = visibleTicks(3600, 240, 1, 1800, 800)
  assert.ok(all.length > 3000)
  assert.ok(windowed.length < 1000)
  assert.ok(windowed.every((tick) => tick >= 1798 && tick <= 2602))
})

test('draw interval follows fps and preview rate without losing remainder', () => {
  assert.ok(Math.abs(drawIntervalFor(30, 1) - 1000 / 30) < 1e-9)
  assert.ok(Math.abs(drawIntervalFor(30, 0.25) - 1000 / 7.5) < 1e-9)
  assert.ok(Math.abs(drawIntervalFor(30, 2) - 1000 / 30) < 1e-9)
})

test('waveform cache round-trips and rejects mismatches', () => {
  const bins = new Float32Array([0.1, 0.2, 0.3])
  const payload = encodeWaveformCache({ mediaSize: 12345, duration: 10, bins })
  const decoded = decodeWaveformCache(payload.buffer as ArrayBuffer, {
    expectedSize: 12345,
    expectedDuration: 10,
  })
  assert.ok(decoded)
  assert.equal(decoded!.bins.length, 3)
  for (let index = 0; index < 3; index += 1) {
    assert.ok(Math.abs(decoded!.bins[index]! - bins[index]!) < 1e-6)
  }
  assert.equal(
    decodeWaveformCache(payload.buffer as ArrayBuffer, { expectedSize: 1 }),
    null,
  )
  assert.equal(
    decodeWaveformCache(payload.buffer as ArrayBuffer, {
      expectedSize: 12345,
      expectedDuration: 20,
    }),
    null,
  )
  const truncated = payload.slice(0, 10)
  assert.equal(
    decodeWaveformCache(
      truncated.buffer.slice(
        truncated.byteOffset,
        truncated.byteOffset + truncated.byteLength,
      ) as ArrayBuffer,
    ),
    null,
  )
})
