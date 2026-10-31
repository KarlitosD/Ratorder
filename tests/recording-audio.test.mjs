import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { after, before, test } from 'node:test'
import puppeteer from 'puppeteer-core'
import { createServer } from 'vite'

// Capture and its timestamp jitter are synthetic. The real controller encodes
// the stream, writes it to OPFS, and exports it through RecordingStore.
const toneFrequency = 1000
const recordingDurationMs = 3000
const decodedSampleRate = 48000
let server
let browser
let origin

before(async () => {
  const executablePath = process.env.CHROMIUM_PATH ?? [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].find(existsSync)
  assert.ok(executablePath, 'Install Chromium or set CHROMIUM_PATH')
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })

  server = await createServer({ server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  origin = server.resolvedUrls.local[0]
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
    ],
  })
})

after(async () => {
  await browser?.close()
  await server?.close()
})

async function recordTone(container, trackSettings = null, expectedFormat = null) {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))

  try {
    await page.goto(origin, { waitUntil: 'networkidle0' })
    const result = await page.evaluate(async (options) => {
      const { RecordingController } = await import('/src/lib/recording/recording-controller.ts')
      const { RecordingStore } = await import('/src/lib/storage/recording-store.ts')
      const { DEFAULT_PREFERENCES } = await import('/src/lib/recording/config.ts')

      // Replay bounded timestamp jitter at the browser API boundary instead of
      // depending on host scheduling. PCM stays continuous, but resampling it by
      // these timestamps creates gaps/overlaps even at an unchanged sample rate.
      const NativeProcessor = window.MediaStreamTrackProcessor
      window.MediaStreamTrackProcessor = class {
        constructor(options) {
          const processor = new NativeProcessor(options)
          if (options.track.kind !== 'audio') return processor
          let firstTimestamp
          let framesSeen = 0
          let blockIndex = 0
          const jitter = [0, -250, -500, -750, -500, -250]
          this.readable = processor.readable.pipeThrough(new TransformStream({
            transform(data, controller) {
              firstTimestamp ??= data.timestamp
              const { numberOfFrames, numberOfChannels, sampleRate } = data
              const pcm = new Float32Array(numberOfFrames * numberOfChannels)
              for (let channel = 0; channel < numberOfChannels; channel++) {
                const plane = pcm.subarray(channel * numberOfFrames, (channel + 1) * numberOfFrames)
                data.copyTo(plane, { planeIndex: channel, format: 'f32-planar' })
              }
              const timestamp = firstTimestamp + Math.round(framesSeen / sampleRate * 1e6)
                + jitter[blockIndex++ % jitter.length]
              const sample = new AudioData({
                format: 'f32-planar', data: pcm, timestamp,
                numberOfFrames, numberOfChannels, sampleRate,
              })
              framesSeen += numberOfFrames
              data.close()
              controller.enqueue(sample)
            },
          }))
        }
      }

      const context = new AudioContext({ sampleRate: 48000 })
      const canvas = document.createElement('canvas')
      canvas.width = 320
      canvas.height = 240
      const drawing = canvas.getContext('2d')
      const drawTimer = setInterval(() => drawing.fillRect(0, 0, 320, 240), 30)

      const oscillator = context.createOscillator()
      oscillator.frequency.value = options.toneFrequency
      const gain = context.createGain()
      gain.gain.value = 0.2
      const systemAudio = context.createMediaStreamDestination()
      oscillator.connect(gain).connect(systemAudio)
      const capture = canvas.captureStream(30)
      capture.addTrack(systemAudio.stream.getAudioTracks()[0])
      const audioTrack = capture.getAudioTracks()[0]
      const isConfigSupported = AudioEncoder.isConfigSupported.bind(AudioEncoder)
      let checkedFormat = false
      AudioEncoder.isConfigSupported = async (config) => {
        if (options.expectedFormat && !checkedFormat) {
          checkedFormat = true
          if (config.sampleRate !== options.expectedFormat.sampleRate ||
              config.numberOfChannels !== options.expectedFormat.numberOfChannels) {
            return { supported: false, config }
          }
        }
        return isConfigSupported(config)
      }
      if (options.trackSettings) {
        const getSettings = audioTrack.getSettings.bind(audioTrack)
        audioTrack.getSettings = () => ({ ...getSettings(), ...options.trackSettings })
      }

      navigator.mediaDevices.getDisplayMedia = async () => capture
      navigator.mediaDevices.getUserMedia = async () => {
        throw new Error('Microphone must remain disabled in this regression')
      }

      const store = new RecordingStore()
      const recorder = new RecordingController({ store })
      const preferences = {
        ...DEFAULT_PREFERENCES,
        microphoneId: 'off',
        quality: 'balanced',
        audioBitrate: 192000,
        container: options.container,
      }

      try {
        await context.resume()
        oscillator.start()
        await recorder.selectSource(preferences)
        await recorder.start(preferences)
        if (recorder.snapshot.phase !== 'recording') {
          throw new Error(recorder.snapshot.error ?? 'Recording did not start')
        }
        await new Promise((resolve) => setTimeout(resolve, options.recordingDurationMs))
        await recorder.stop()
        const metadata = recorder.snapshot.completedRecording
        if (!metadata) throw new Error(recorder.snapshot.error ?? 'Recording did not finish')

        const file = await store.getVideoFile(metadata)
        const bytes = new Uint8Array(await file.arrayBuffer())
        let binary = ''
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        }
        await store.deleteRecording(metadata.id)
        return { base64: btoa(binary), metadata }
      } finally {
        clearInterval(drawTimer)
        recorder.dispose()
        capture.getTracks().forEach((track) => track.stop())
        await context.close()
      }
    }, { container, toneFrequency, recordingDurationMs, trackSettings, expectedFormat })

    assert.deepEqual(errors, [], 'No browser errors during recording')
    return { file: Buffer.from(result.base64, 'base64'), metadata: result.metadata }
  } finally {
    await page.close()
  }
}

test('requests unprocessed display audio so tab sound is not downmixed', { timeout: 15000 }, async () => {
  const page = await browser.newPage()
  try {
    await page.goto(origin, { waitUntil: 'networkidle0' })
    const audio = await page.evaluate(async () => {
      const { RecordingController } = await import('/src/lib/recording/recording-controller.ts')
      const { DEFAULT_PREFERENCES } = await import('/src/lib/recording/config.ts')

      let requestedAudio = null
      navigator.mediaDevices.getDisplayMedia = async (options) => {
        requestedAudio = options.audio
        const canvas = document.createElement('canvas')
        canvas.width = 32
        canvas.height = 32
        return canvas.captureStream(30)
      }

      const recorder = new RecordingController({ store: {} })
      try {
        await recorder.selectSource({
          ...DEFAULT_PREFERENCES,
          microphoneId: 'off',
          systemAudio: true,
        })
      } finally {
        recorder.dispose()
      }
      return requestedAudio
    })

    assert.deepEqual(audio, {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    })
  } finally {
    await page.close()
  }
})

test('probes audio codec support with the captured track format', { timeout: 30000 }, async () => {
  const { metadata } = await recordTone('webm', { sampleRate: 44100, channelCount: 1 },
    { sampleRate: 44100, numberOfChannels: 1 })
  assert.equal(metadata.hasAudio, true)
})

test('uses an explicit estimate when capture format is unavailable', { timeout: 30000 }, async () => {
  const { metadata } = await recordTone('webm', { sampleRate: undefined, channelCount: undefined },
    { sampleRate: 48000, numberOfChannels: 2 })
  assert.equal(metadata.hasAudio, true)
})

function analyzeTone(file) {
  const bytes = execFileSync('ffmpeg', [
    '-v', 'error', '-i', 'pipe:0', '-map', '0:a:0',
    '-f', 'f32le', '-ac', '1', '-ar', String(decodedSampleRate), 'pipe:1',
  ], { input: file, maxBuffer: 10 * 1024 * 1024 })
  const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)
  const windowSize = decodedSampleRate / 100
  const edgeMargin = decodedSampleRate / 2
  let badWindows = 0
  let totalWindows = 0

  // Examine every 10 ms, omitting startup/shutdown transients. Projection onto
  // the known tone catches discontinuities that codec/duration checks miss.
  const lastWindowStart = samples.length - edgeMargin - windowSize
  for (let start = edgeMargin; start < lastWindowStart; start += windowSize) {
    let energy = 0
    let sine = 0
    let cosine = 0
    for (let i = 0; i < windowSize; i++) {
      const sample = samples[start + i]
      const phase = 2 * Math.PI * toneFrequency * i / decodedSampleRate
      energy += sample * sample
      sine += sample * Math.sin(phase)
      cosine += sample * Math.cos(phase)
    }
    const toneEnergy = 2 * (sine * sine + cosine * cosine) / windowSize
    const snr = 10 * Math.log10(toneEnergy / Math.max(1e-12, energy - toneEnergy))
    const rms = Math.sqrt(energy / windowSize)
    if (!Number.isFinite(snr) || rms < 0.04 || snr < 20) badWindows++
    totalWindows++
  }

  return { badWindows, totalWindows, durationMs: samples.length / decodedSampleRate * 1000 }
}

for (const container of ['mp4', 'webm']) {
  const name = `retains clean system audio in ${container} with the microphone off`
  test(name, { timeout: 30000 }, async () => {
    const { file, metadata } = await recordTone(container)
    assert.equal(metadata.hasSystemAudio, true)
    assert.equal(metadata.hasMicrophone, false)
    const metrics = analyzeTone(file)
    assert.ok(metrics.totalWindows >= 150, JSON.stringify(metrics))
    assert.ok(Math.abs(metrics.durationMs - recordingDurationMs) < 250, JSON.stringify(metrics))
    assert.equal(metrics.badWindows, 0, JSON.stringify(metrics))
  })
}
