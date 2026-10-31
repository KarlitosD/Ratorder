import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { createServer } from 'vite'

// Manual diagnostic, not a production change. Uses a temporary browser profile,
// synthetic tracks and real RecordingController/OPFS. No personal recordings.
const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const executablePath = process.env.CHROMIUM_PATH ?? '/usr/bin/chromium'
const server = await createServer({
  root: projectRoot,
  logLevel: 'silent',
  server: { host: '127.0.0.1', port: 0 },
})
let browser

try {
  await server.listen()
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  })
  const results = []
  for (const variant of ['current', 'audio-ended']) {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle0' })
    const result = await page.evaluate(async (variant) => {
      let controllerUrl = '/src/lib/recording/recording-controller.ts'
      if (variant === 'without-video-transform') {
        // Change this variable only, in memory. Production source is untouched.
        let source = await (await fetch(controllerUrl)).text()
        const transform = /transform: \{\s*width: dimensions.width,\s*height: dimensions.height,\s*fit: "contain"\s*\},?/
        if (!transform.test(source)) throw new Error('Video transform probe no longer matches the controller')
        source = source.replace(transform, '')
        source = source.replace(/from (["'])\//g, `from $1${location.origin}/`)
        controllerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
      }
      const { RecordingController } = await import(controllerUrl)
      const { RecordingStore } = await import('/src/lib/storage/recording-store.ts')
      const { OpfsStreamWriter } = await import('/src/lib/storage/opfs-stream-writer.ts')
      const { DEFAULT_PREFERENCES } = await import('/src/lib/recording/config.ts')
      const { VideoSample } = await import('/node_modules/mediabunny/dist/modules/src/index.js')

      // Copy the muxer's writes before the worker transfers their buffers. After
      // finalization, reconstruct the expected file in positional write order.
      const fileWrites = []
      const originalWrite = OpfsStreamWriter.prototype.write
      OpfsStreamWriter.prototype.write = async function (position, data) {
        const copy = data.slice()
        await originalWrite.call(this, position, data)
        fileWrites.push({ position, data: copy })
      }
      const width = 1280
      const height = 720
      const colors = [
        [0, 0, 0], [32, 32, 32], [64, 64, 64], [128, 128, 128],
        [192, 192, 192], [255, 255, 255], [255, 0, 0], [0, 255, 0],
        [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255],
        [150, 70, 30], [40, 80, 170], [80, 160, 50], [180, 80, 160],
      ]
      const pixels = new Uint8Array(width * height * 3 / 2)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const [r, g, b] = colors[Math.floor(x * colors.length / width)].map((value) => value / 255)
          const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
          pixels[y * width + x] = Math.round(16 + 219 * luminance)
          if (x % 2 === 0 && y % 2 === 0) {
            const chromaIndex = y / 2 * width / 2 + x / 2
            pixels[width * height + chromaIndex] = Math.round(128 + 112 * (b - luminance) / (1 - 0.0722))
            pixels[width * height * 5 / 4 + chromaIndex] = Math.round(128 + 112 * (r - luminance) / (1 - 0.2126))
          }
        }
      }
      function makeFrame() {
        return new VideoFrame(pixels, {
          format: 'I420', codedWidth: width, codedHeight: height,
          timestamp: Math.round(performance.now() * 1000), duration: 33333,
          colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
        })
      }
      function inspectFrame(frame, colorSpace = 'srgb') {
        const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight)
        const context = canvas.getContext('2d', { colorSpace, willReadFrequently: true })
        context.drawImage(frame, 0, 0)
        const patches = colors.map((_, index) => Array.from(context.getImageData(
          Math.floor((index + 0.5) * canvas.width / colors.length), Math.floor(canvas.height / 2),
          1, 1, { colorSpace },
        ).data).slice(0, 3))
        return { format: frame.format, colorSpace: frame.colorSpace.toJSON(), patches }
      }
      const referenceFrame = makeFrame()
      const reference = inspectFrame(referenceFrame)
      referenceFrame.close()

      // Isolate Canvas gamut conversion independently of the capture/encoder.
      const p3Canvas = new OffscreenCanvas(width, height)
      const p3Context = p3Canvas.getContext('2d', { colorSpace: 'display-p3' })
      for (let i = 0; i < colors.length; i++) {
        p3Context.fillStyle = `color(display-p3 ${colors[i].map((value) => value / 255).join(' ')})`
        p3Context.fillRect(i * width / colors.length, 0, width / colors.length, height)
      }
      const p3Frame = new VideoFrame(p3Canvas, { timestamp: 0 })
      const p3Sample = new VideoSample(p3Frame)
      const transformedP3Sample = await p3Sample.transform({ width, height, fit: 'contain' })
      const transformedP3Frame = transformedP3Sample.toVideoFrame()
      const p3 = {
        before: inspectFrame(p3Frame, 'display-p3'),
        after: inspectFrame(transformedP3Frame, 'display-p3'),
      }
      transformedP3Frame.close()
      transformedP3Sample.close()
      p3Sample.close()

      let encoderInput
      const NativeVideoEncoder = window.VideoEncoder
      window.VideoEncoder = class extends NativeVideoEncoder {
        encode(frame, options) {
          encoderInput ??= inspectFrame(frame)
          super.encode(frame, options)
        }
      }
      const videoTrack = new MediaStreamTrackGenerator({ kind: 'video' })
      const frameWriter = videoTrack.writable.getWriter()
      async function sendFrame() {
        if (videoTrack.readyState !== 'live') return
        const frame = makeFrame()
        try { await frameWriter.write(frame) } finally { frame.close() }
      }
      await sendFrame()
      const frameTimer = setInterval(() => void sendFrame().catch(() => {}), 1000 / 30)
      const context = new AudioContext({ sampleRate: 48000 })
      const audioBuffer = context.createBuffer(2, 48000, 48000)
      const frequencies = [[440, 4000, 12000, 18000], [880, 6000, 14000, 19500]]
      for (let channel = 0; channel < 2; channel++) {
        const pcm = audioBuffer.getChannelData(channel)
        for (let i = 0; i < pcm.length; i++) {
          pcm[i] = frequencies[channel].reduce((sum, hz) => sum + 0.06 * Math.sin(2 * Math.PI * hz * i / 48000), 0)
        }
      }
      const audioSource = context.createBufferSource()
      audioSource.buffer = audioBuffer
      audioSource.loop = true
      const audioDestination = context.createMediaStreamDestination()
      audioSource.connect(audioDestination)
      await context.resume()
      audioSource.start()
      const audioTrack = audioDestination.stream.getAudioTracks()[0]
      const stream = new MediaStream([videoTrack, audioTrack])
      navigator.mediaDevices.getDisplayMedia = async () => stream
      const sourceSettings = { video: videoTrack.getSettings(), audio: audioTrack.getSettings() }
      const store = new RecordingStore()
      const notices = []
      const recorder = new RecordingController({ store, onNotice: (text, kind) => notices.push({ text, kind }) })
      const preferences = { ...DEFAULT_PREFERENCES, microphoneId: 'off', quality: 'balanced', audioBitrate: 192000 }
      let audioEndedSnapshot
      let concurrentLibrary
      try {
        await recorder.selectSource(preferences)
        await recorder.start(preferences)
        if (recorder.snapshot.phase !== 'recording') throw new Error(recorder.snapshot.error)
        if (variant === 'current') {
          try {
            const otherStore = new RecordingStore()
            concurrentLibrary = await otherStore.initialize()
          } catch (error) {
            concurrentLibrary = { error: error.name, message: error.message }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
        if (variant === 'audio-ended') {
          audioTrack.stop()
          audioTrack.dispatchEvent(new Event('ended'))
          await new Promise((resolve) => setTimeout(resolve, 150))
          audioEndedSnapshot = {
            phase: recorder.snapshot.phase,
            hasAudio: recorder.snapshot.hasAudio,
            systemAudioActive: recorder.snapshot.systemAudioActive,
            trackState: audioTrack.readyState,
            notices: [...notices],
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1500))
        await recorder.stop()
        const metadata = recorder.snapshot.completedRecording
        if (!metadata) throw new Error(recorder.snapshot.error ?? 'Recording did not finish')
        const stale = { ...metadata, id: crypto.randomUUID(), status: 'recording' }
        await store.createRecording(stale)
        const recovered = await new RecordingStore().initialize()
        const staleStatus = recovered.find((entry) => entry.id === stale.id)?.status
        await store.deleteRecording(stale.id)
        const file = await store.getVideoFile(metadata)
        const video = document.createElement('video')
        video.muted = true
        const url = URL.createObjectURL(file)
        video.src = url
        await new Promise((resolve, reject) => {
          video.onloadeddata = resolve
          video.onerror = () => reject(new Error(video.error?.message))
        })
        const seek = new Promise((resolve) => { video.onseeked = resolve })
        video.currentTime = 0.5
        await seek
        const decodedFrame = new VideoFrame(video, { timestamp: 0 })
        const decoded = inspectFrame(decodedFrame)
        decodedFrame.close()
        URL.revokeObjectURL(url)
        const bytes = new Uint8Array(await file.arrayBuffer())
        const expectedSize = fileWrites.reduce(
          (size, write) => Math.max(size, write.position + write.data.length), 0,
        )
        const expectedBytes = new Uint8Array(expectedSize)
        for (const write of fileWrites) expectedBytes.set(write.data, write.position)
        async function sha256(data) {
          const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
          return Array.from(hash, (value) => value.toString(16).padStart(2, '0')).join('')
        }
        const inputHash = await sha256(expectedBytes)
        const storedHash = await sha256(bytes)
        const storageIntegrity = {
          expectedBytes: expectedSize,
          storedBytes: bytes.length,
          inputHash,
          storedHash,
          identical: inputHash === storedHash && expectedSize === bytes.length,
        }
        let binary = ''
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        await store.deleteRecording(metadata.id)
        return {
          variant, userAgent: navigator.userAgent, sourceSettings,
          reference, encoderInput, decoded, p3,
          audioEndedSnapshot, concurrentLibrary, storageIntegrity, staleStatus,
          metadata, notices, base64: btoa(binary),
        }
      } finally {
        clearInterval(frameTimer)
        recorder.dispose()
        stream.getTracks().forEach((track) => track.stop())
        await frameWriter.close().catch(() => {})
        await context.close()
      }
    }, variant)
    assert.equal(result.storageIntegrity.identical, true, 'OPFS must preserve every encoded byte')
    assert.equal(result.staleStatus, 'interrupted', 'An abandoned recording must remain recoverable')
    if (variant === 'current') {
      assert.equal(result.concurrentLibrary[0]?.status, 'recording', 'A live recording must not be marked interrupted')
      assert.deepEqual(result.encoderInput.colorSpace, result.reference.colorSpace, 'Unscaled video must preserve its color metadata')
    }
    if (variant === 'audio-ended') {
      assert.equal(result.audioEndedSnapshot.systemAudioActive, false, 'Ended audio must not remain active')
      assert.ok(result.audioEndedSnapshot.notices.some((notice) => notice.kind === 'warning'))
    }
    const file = Buffer.from(result.base64, 'base64')
    delete result.base64
    result.ffprobe = JSON.parse(execFileSync('ffprobe', [
      '-v', 'error', '-show_entries',
      'stream=index,codec_name,codec_type,pix_fmt,width,height,color_range,color_space,color_transfer,color_primaries,sample_rate,channels:packet=stream_index,pts_time,duration_time',
      '-of', 'json', '-i', 'pipe:0',
    ], { input: file, maxBuffer: 10 * 1024 * 1024 }))
    const pcmBytes = execFileSync('ffmpeg', [
      '-v', 'error', '-i', 'pipe:0', '-map', '0:a:0', '-f', 'f32le', '-ac', '2', '-ar', '48000', 'pipe:1',
    ], { input: file, maxBuffer: 10 * 1024 * 1024 })
    const pcm = new Float32Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.length / 4)
    result.audio = []
    for (let channel = 0; channel < 2; channel++) {
      const count = 48000 / 2
      const start = 48000 / 4
      let energy = 0
      for (let i = 0; i < count; i++) energy += pcm[(start + i) * 2 + channel] ** 2
      const amplitudes = {}
      for (const hz of [440, 880, 4000, 6000, 12000, 14000, 18000, 19500]) {
        let sine = 0
        let cosine = 0
        for (let i = 0; i < count; i++) {
          const sample = pcm[(start + i) * 2 + channel]
          const phase = 2 * Math.PI * hz * i / 48000
          sine += sample * Math.sin(phase)
          cosine += sample * Math.cos(phase)
        }
        amplitudes[hz] = 2 * Math.hypot(sine, cosine) / count
      }
      result.audio.push({ rms: Math.sqrt(energy / count), expectedRms: Math.sqrt(4 * 0.06 ** 2 / 2), amplitudes })
    }
    result.errors = errors
    results.push(result)
    await page.close()
  }
  console.log(JSON.stringify({ executablePath, results }, null, 2))
} finally {
  await browser?.close()
  await server.close()
}
