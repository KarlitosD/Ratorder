import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

test('reports codecs, dimensions and actual audio/video streams of a saved file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ratorder-inspect-'))
  const file = join(directory, 'sample.webm')
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=64x64:r=10:d=1',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1', '-c:v', 'libvpx', '-c:a', 'libopus', file])
    const report = JSON.parse(execFileSync(process.execPath, ['scripts/inspect-recording.mjs', file], { encoding: 'utf8' })) as {
      streams: Array<{ type: string; codec: string; width?: number; height?: number; sampleRate?: number; packets: number }>
    }
    const video = report.streams.find(stream => stream.type === 'video')!
    const audio = report.streams.find(stream => stream.type === 'audio')!
    expect(video.codec).toBe('vp8')
    expect(video.width).toBe(64)
    expect(video.height).toBe(64)
    expect(audio.codec).toBe('opus')
    expect(audio.sampleRate).toBe(48000)
    expect(video.packets > 0 && audio.packets > 0).toBe(true)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})