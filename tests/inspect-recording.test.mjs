import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('reports codecs, dimensions and actual audio/video streams of a saved file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ratorder-inspect-'))
  const file = join(directory, 'sample.webm')
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=64x64:r=10:d=1',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1', '-c:v', 'libvpx', '-c:a', 'libopus', file])
    const report = JSON.parse(execFileSync(process.execPath, ['scripts/inspect-recording.mjs', file], { encoding: 'utf8' }))
    const video = report.streams.find(stream => stream.type === 'video')
    const audio = report.streams.find(stream => stream.type === 'audio')
    assert.equal(video.codec, 'vp8')
    assert.equal(video.width, 64)
    assert.equal(video.height, 64)
    assert.equal(audio.codec, 'opus')
    assert.equal(audio.sampleRate, 48000)
    assert.ok(video.packets > 0 && audio.packets > 0)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
