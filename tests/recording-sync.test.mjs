import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import puppeteer from 'puppeteer-core'
import { createServer } from 'vite'
import { analyzeSync } from '../scripts/av-sync-analysis.mjs'

let server, browser, origin

before(async () => {
  const executablePath = process.env.CHROMIUM_PATH ?? [
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  ].find(existsSync)
  assert.ok(executablePath, 'Install Chromium or set CHROMIUM_PATH')
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
  execFileSync('ffprobe', ['-version'], { stdio: 'ignore' })
  server = await createServer({ server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  origin = server.resolvedUrls.local[0]
  browser = await puppeteer.launch({ executablePath, headless: true, args: [
    '--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
  ] })
})

after(async () => {
  await browser?.close()
  await server?.close()
})

// Sample the browser process tree, not the test runner or ffmpeg. Processes that
// both start and exit between samples are missed; RSS double-counts shared pages.
function monitorBrowser(pid) {
  if (process.platform !== 'linux' || !pid) return null
  const ticksPerSecond = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim())
  const pageSizeKb = Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }).trim()) / 1024
  let previous = new Map()
  let previousAt = performance.now()
  let cpuSeconds = 0, measuredSeconds = 0, peakCores = 0, peakRssKb = 0
  const sample = () => {
    const processes = new Map()
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        const rss = Number(readFileSync(`/proc/${entry}/statm`, 'utf8').split(' ')[1]) * pageSizeKb
        processes.set(Number(entry), { parent: Number(fields[1]), ticks: Number(fields[11]) + Number(fields[12]), rss })
      } catch { /* A process may exit while /proc is being read. */ }
    }
    const tree = new Set([pid])
    let changed = true
    while (changed) {
      changed = false
      for (const [id, process] of processes) {
        if (!tree.has(id) && tree.has(process.parent)) { tree.add(id); changed = true }
      }
    }
    const now = performance.now(), elapsed = (now - previousAt) / 1000
    let ticks = 0, rss = 0
    const current = new Map()
    for (const id of tree) {
      const process = processes.get(id)
      if (!process) continue
      current.set(id, process.ticks)
      if (previous.has(id)) ticks += Math.max(0, process.ticks - previous.get(id))
      rss += process.rss
    }
    if (previous.size && elapsed > 0) {
      const seconds = ticks / ticksPerSecond
      cpuSeconds += seconds; measuredSeconds += elapsed
      peakCores = Math.max(peakCores, seconds / elapsed)
      peakRssKb = Math.max(peakRssKb, rss)
    }
    previous = current; previousAt = now
  }
  sample()
  const timer = setInterval(sample, 1000)
  return () => {
    clearInterval(timer)
    sample()
    return { measuredSeconds, averageCores: cpuSeconds / measuredSeconds, peakCores, peakRssMiB: peakRssKb / 1024 }
  }
}

async function recordSignals({ pause, aacWasm = false, load = false, eventCount = 4, width = 160, height = 90 }) {
  const page = await browser.newPage()
  try {
    await page.goto(origin, { waitUntil: 'networkidle0' })
    const result = await page.evaluate(async ({ pause, aacWasm, load, eventCount, width, height }) => {
      const { RecordingController } = await import('/src/lib/recording/recording-controller.ts')
      const { RecordingStore } = await import('/src/lib/storage/recording-store.ts')
      const { DEFAULT_PREFERENCES } = await import('/src/lib/recording/config.ts')
      if (aacWasm) {
        const path = '/node_modules/@mediabunny/aac-encoder/dist/bundles/mediabunny-aac-encoder.mjs'
        const { registerAacEncoder } = await import(/* @vite-ignore */ path)
        registerAacEncoder()
      }
      const canvas = document.createElement('canvas')
      canvas.width = width; canvas.height = height
      const ctx = canvas.getContext('2d')
      let white = false
      const draw = () => { ctx.fillStyle = white ? '#fff' : '#000'; ctx.fillRect(0, 0, width, height) }
      draw()
      const timer = setInterval(draw, 1000 / 30)
      // Synthetic main-thread pressure, not a CPU or encoder benchmark.
      const busyTimer = load ? setInterval(() => {
        const until = performance.now() + 12
        while (performance.now() < until) {}
      }, 50) : null
      const stream = canvas.captureStream(30)
      const audio = new AudioContext({ sampleRate: 48000 })
      const oscillator = audio.createOscillator()
      oscillator.frequency.value = 1000
      const gain = audio.createGain()
      gain.gain.value = 0
      const destination = audio.createMediaStreamDestination()
      oscillator.connect(gain).connect(destination)
      stream.addTrack(destination.stream.getAudioTracks()[0])
      navigator.mediaDevices.getDisplayMedia = async () => stream
      const store = new RecordingStore()
      const recorder = new RecordingController({ store })
      const preferences = { ...DEFAULT_PREFERENCES, microphoneId: 'off', container: aacWasm ? 'mp4' : 'webm', fps: 30 }
      const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))
      try {
        await audio.resume()
        oscillator.start()
        await recorder.selectSource(preferences)
        await recorder.start(preferences)
        if (recorder.snapshot.phase !== 'recording') throw new Error(recorder.snapshot.error ?? 'Recording failed')
        await delay(500)
        for (let i = 0; i < eventCount; i++) {
          white = true; draw(); gain.gain.setValueAtTime(0.4, audio.currentTime)
          await delay(160)
          white = false; draw(); gain.gain.setValueAtTime(0, audio.currentTime)
          await delay(350)
          if (pause && i === 1) { recorder.pause(); await delay(700); recorder.resume() }
          await delay(490)
        }
        await delay(300)
        await recorder.stop()
        const metadata = recorder.snapshot.completedRecording
        if (!metadata) throw new Error(recorder.snapshot.error ?? 'Recording failed')
        const file = await store.getVideoFile(metadata)
        const bytes = new Uint8Array(await file.arrayBuffer())
        let binary = ''
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        await store.deleteRecording(metadata.id)
        const source = stream.getTracks().map(track => {
          const { width, height, frameRate, sampleRate, channelCount } = track.getSettings()
          return { kind: track.kind, width, height, frameRate, sampleRate, channelCount }
        })
        return { base64: btoa(binary), metadata, source }
      } finally {
        clearInterval(timer)
        if (busyTimer !== null) clearInterval(busyTimer)
        recorder.dispose()
        stream.getTracks().forEach(track => track.stop())
        await audio.close()
      }
    }, { pause, aacWasm, load, eventCount, width, height })
    return { ...result, file: Buffer.from(result.base64, 'base64'), base64: undefined }
  } finally { await page.close() }
}

function inspect(file) {
  const directory = mkdtempSync(join(tmpdir(), 'ratorder-sync-'))
  const path = join(directory, 'capture')
  let inspected = false
  try {
    // ffprobe may close stdin after reading headers, causing EPIPE for large files.
    writeFileSync(path, file)
    const streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
      'stream=codec_type,codec_name,start_time,sample_rate,channels,width,height,r_frame_rate', '-of', 'json', path],
    { maxBuffer: 4 * 1024 * 1024 })).streams
    const videoStream = streams.find(stream => stream.codec_type === 'video')
    const audioStream = streams.find(stream => stream.codec_type === 'audio')
    assert.ok(videoStream && audioStream, JSON.stringify(streams))
    const video = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:v:0',
      '-vf', 'setpts=PTS-STARTPTS,fps=30,scale=1:1,format=gray', '-f', 'rawvideo', 'pipe:1'],
    { maxBuffer: 4 * 1024 * 1024 })
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:a:0',
      '-af', 'asetpts=PTS-STARTPTS', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'],
    { maxBuffer: 128 * 1024 * 1024 })
    const audio = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4)
    const sync = analyzeSync({ video, audio, fps: 30, rate: 48000,
      videoStart: Number(videoStream.start_time ?? 0), audioStart: Number(audioStream.start_time ?? 0) })
    inspected = true
    return { streams, sync }
  } finally {
    if (inspected || process.env.AAC_KEEP_FAILED !== '1') rmSync(directory, { recursive: true, force: true })
    else console.error(`Synthetic capture retained for inspection: ${path}`)
  }
}

for (const { label, pause, load } of [
  { label: 'during capture', pause: false, load: false },
  { label: 'across pause and resume', pause: true, load: false },
  { label: 'under synthetic main-thread load', pause: false, load: true },
]) {
  test(`measures A/V offset and drift ${label}`, { timeout: 30000 }, async (t) => {
    const { file, metadata, source } = await recordSignals({ pause, load })
    const { streams, sync } = inspect(file)
    t.diagnostic(JSON.stringify({ source, metadata: { videoCodec: metadata.videoCodec, audioCodec: metadata.audioCodec,
      width: metadata.width, height: metadata.height, fps: metadata.fps, durationMs: metadata.durationMs }, streams, sync }))
    assert.equal(sync.events.length, 4)
    assert.ok(Math.abs(sync.initialOffsetMs) < 200, JSON.stringify(sync))
    assert.ok(Math.abs(sync.driftMs) < 200, JSON.stringify(sync))
    assert.ok(sync.events.every(event => Math.abs(event.offsetMs) < 200), JSON.stringify(sync))
  })
}

test('evaluates experimental AAC WASM during capture', {
  timeout: 180000,
  skip: process.env.AAC_WASM_BENCH !== '1' && 'Install @mediabunny/aac-encoder and set AAC_WASM_BENCH=1',
}, async (t) => {
  const eventCount = Number(process.env.AAC_WASM_EVENTS ?? 12)
  const width = Number(process.env.AAC_WASM_WIDTH ?? 160)
  const height = Number(process.env.AAC_WASM_HEIGHT ?? 90)
  assert.ok(Number.isInteger(eventCount) && eventCount >= 2 && eventCount <= 120)
  assert.ok(Number.isInteger(width) && width >= 2 && width <= 3840 && Number.isInteger(height) && height >= 2 && height <= 2160)
  const finishMonitoring = monitorBrowser(browser.process()?.pid)
  let recording, browserLoad
  try {
    recording = await recordSignals({ pause: true, aacWasm: true, load: true, eventCount, width, height })
  } finally {
    browserLoad = finishMonitoring?.() ?? null
  }
  const { file, metadata, source } = recording
  t.diagnostic(JSON.stringify({ source, metadata: { videoCodec: metadata.videoCodec, audioCodec: metadata.audioCodec,
    durationMs: metadata.durationMs }, browserLoad }))
  const { streams, sync } = inspect(file)
  t.diagnostic(JSON.stringify({ streams, sync }))
  assert.equal(metadata.audioCodec, 'aac')
  assert.equal(streams.find(stream => stream.codec_type === 'audio').codec_name, 'aac')
  assert.equal(sync.events.length, eventCount)
  assert.ok(Math.abs(sync.initialOffsetMs) < 200, JSON.stringify(sync))
  assert.ok(Math.abs(sync.driftMs) < 200, JSON.stringify(sync))
  assert.ok(sync.events.every(event => Math.abs(event.offsetMs) < 200), JSON.stringify(sync))
})
