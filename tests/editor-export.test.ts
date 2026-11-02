import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import puppeteer from 'puppeteer-core'
import { createServer } from 'vite'

// Synthetic recordings, real controller, real OPFS, real editor export.
const SAMPLE_RATE = 48_000

let server: any
let browser: any
let origin: any

beforeAll(async () => {
  const executablePath = process.env.CHROMIUM_PATH ?? [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].find(existsSync)
  assert.ok(executablePath, 'Install Chromium or set CHROMIUM_PATH')
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
  execFileSync('ffprobe', ['-version'], { stdio: 'ignore' })

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

afterAll(async () => {
  await browser?.close()
  await server?.close()
})

function decodeAudio(filePath) {
  const bytes = execFileSync(
    'ffmpeg',
    [
      '-v', 'error', '-i', filePath, '-map', '0:a:0',
      '-f', 'f32le', '-ac', '1', '-ar', String(SAMPLE_RATE), 'pipe:1',
    ],
    { maxBuffer: 50 * 1024 * 1024 },
  )
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)
}

function rms(samples, startSeconds, endSeconds) {
  const start = Math.max(0, Math.round(startSeconds * SAMPLE_RATE))
  const end = Math.min(samples.length, Math.round(endSeconds * SAMPLE_RATE))
  let energy = 0
  for (let index = start; index < end; index += 1) {
    energy += samples[index] * samples[index]
  }
  return Math.sqrt(energy / Math.max(1, end - start))
}

function frequency(samples, startSeconds, endSeconds) {
  const start = Math.max(0, Math.round(startSeconds * SAMPLE_RATE))
  const end = Math.min(samples.length, Math.round(endSeconds * SAMPLE_RATE))
  let crossings = 0
  let positive = samples[start] >= 0
  for (let index = start + 1; index < end; index += 1) {
    const current = samples[index] >= 0
    if (current !== positive) crossings += 1
    positive = current
  }
  return crossings / (2 * Math.max(1e-6, (end - start) / SAMPLE_RATE))
}

function framePixel(filePath, seconds, x, y, width, height) {
  const bytes = execFileSync(
    'ffmpeg',
    [
      '-v', 'error', '-i', filePath, '-ss', String(seconds),
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  )
  const offset = (Math.round(y) * width + Math.round(x)) * 3
  return [bytes[offset], bytes[offset + 1], bytes[offset + 2]]
}

test('exports combined, trimmed, muted and accelerated clips with overlays', { timeout: 120000 }, async () => {
  const page = await browser.newPage()
  const pageErrors = []
  const tempDirectory = mkdtempSync(join(tmpdir(), 'ratorder-editor-'))
  const outputPath = join(tempDirectory, 'combined.mp4')
  page.on('pageerror', (error) => pageErrors.push(error.message))

  try {
    await page.goto(origin, { waitUntil: 'networkidle0' })
    const result = await page.evaluate(async () => {
    const load = (p: any) => (0, eval)(`import(${JSON.stringify(p)})`); 
      const { RecordingController } = await load('/src/lib/recording/recording-controller.ts')
      const { RecordingStore } = await load('/src/lib/storage/recording-store.ts')
      const { DEFAULT_PREFERENCES } = await load('/src/lib/recording/config.ts')
      const {
        addClipFromAsset,
        addOverlay,
        createDefaultProject,
        createOverlay,
        parseEditorProject,
        projectDuration,
        setClipSpeed,
        setClipVolume,
        splitAt,
        toggleMute,
      } = await load('/src/lib/editor/model.ts')
      const { exportEditedRecording } = await load('/src/lib/editor/export.ts')

      const store = new RecordingStore()

      async function record({ color, tone, durationMs }) {
        const canvas = document.createElement('canvas')
        canvas.width = 320
        canvas.height = 240
        const context = canvas.getContext('2d')
        context.fillStyle = color
        const drawTimer = setInterval(() => {
          context.fillRect(0, 0, canvas.width, canvas.height)
        }, 30)
        const audioContext = new AudioContext({ sampleRate: 48000 })
        const oscillator = audioContext.createOscillator()
        oscillator.frequency.value = tone
        const gain = audioContext.createGain()
        gain.gain.value = 0.2
        const destination = audioContext.createMediaStreamDestination()
        oscillator.connect(gain).connect(destination)
        const capture = canvas.captureStream(30)
        capture.addTrack(destination.stream.getAudioTracks()[0])
        navigator.mediaDevices.getDisplayMedia = async () => capture
        navigator.mediaDevices.getUserMedia = async () => {
          throw new Error('microphone disabled')
        }
        const recorder = new RecordingController({ store })
        const preferences = {
          ...DEFAULT_PREFERENCES,
          microphoneId: 'off',
          quality: 'balanced',
          container: 'mp4',
          fps: 30,
          systemAudio: true,
        }
        try {
          await audioContext.resume()
          oscillator.start()
          await recorder.selectSource(preferences)
          await recorder.start(preferences)
          if (recorder.snapshot.phase !== 'recording') {
            throw new Error(recorder.snapshot.error ?? 'recording did not start')
          }
          await new Promise((resolve) => setTimeout(resolve, durationMs))
          await recorder.stop()
          const metadata = recorder.snapshot.completedRecording
          if (!metadata) throw new Error(recorder.snapshot.error ?? 'recording did not finish')
          return metadata
        } finally {
          clearInterval(drawTimer)
          recorder.dispose()
          capture.getTracks().forEach((track) => track.stop())
          await audioContext.close()
        }
      }

      const source = await record({ color: '#8c3a1f', tone: 1000, durationMs: 3000 })
      const imported = await record({ color: '#1f8c4e', tone: 1500, durationMs: 1200 })

      const sourceInfo = {
        duration: source.durationMs / 1000,
        width: source.width,
        height: source.height,
        fps: source.fps || 30,
        container: 'mp4',
        hasAudio: true,
        extension: 'mp4',
      }

      let project = createDefaultProject({
        sourceId: source.id,
        title: 'Proyecto de prueba',
        source: sourceInfo,
      })
      project = splitAt(project, 1)
      project = splitAt(project, 2)
      project = toggleMute(project, project.clips[1].id)
      project = setClipSpeed(project, project.clips[2].id, 2)
      project = setClipVolume(project, project.clips[0].id, 1.5)
      project = setClipVolume(project, project.clips[2].id, 0.5)
      project = addOverlay(project, {
        ...createOverlay(project, 'rect', 0.1),
        start: 0.1,
        end: 0.9,
        x: 0.1,
        y: 0.1,
        width: 0.5,
        height: 0.5,
        color: '#FF0000',
        opacity: 1,
        radius: 0,
        strokeWidth: 0,
      })

      const imageCanvas = document.createElement('canvas')
      imageCanvas.width = 120
      imageCanvas.height = 80
      const imageContext = imageCanvas.getContext('2d')
      imageContext.fillStyle = '#FF00FF'
      imageContext.fillRect(0, 0, 120, 80)
      const imageBlob = await new Promise((resolve) =>
        imageCanvas.toBlob((blob) => resolve(blob), 'image/png'),
      )
      if (!imageBlob) throw new Error('image blob failed')
      const imageId = crypto.randomUUID()
      const imageStoredName = `${imageId}.png`
      await store.saveEditorAsset(source.id, imageStoredName, imageBlob)
      const imageAsset = {
        id: imageId,
        kind: 'image',
        name: 'marca.png',
        storedName: imageStoredName,
        extension: 'png',
        mimeType: 'image/png',
        size: (imageBlob as any).size,
        duration: 0,
        width: 120,
        height: 80,
        hasAudio: false,
      }
      project = { ...project, assets: [...project.assets, imageAsset] }
      project = addOverlay(project, {
        ...createOverlay(project, 'image', 0.1, imageId),
        start: 0.1,
        end: 0.9,
        x: 0.66,
        y: 0.05,
        width: 0.28,
        height: 0.28,
        opacity: 1,
      })

      const importedFile = await store.getVideoFile(imported)
      const assetId = crypto.randomUUID()
      const storedName = `${assetId}.mp4`
      await store.saveEditorAsset(source.id, storedName, importedFile)
      const asset = {
        id: assetId,
        kind: 'video',
        name: 'segundo.mp4',
        storedName,
        extension: 'mp4',
        mimeType: 'video/mp4',
        size: (importedFile as any).size,
        duration: imported.durationMs / 1000,
        width: imported.width,
        height: imported.height,
        hasAudio: true,
      }
      project = { ...project, assets: [...project.assets, asset] }
      project = addClipFromAsset(project, assetId)

      await store.saveEditorProject(source.id, project)
      const loaded = parseEditorProject(await store.getEditorProject(source.id))
      if (!loaded) throw new Error('project did not persist')
      const assetFile = await store.getEditorAssetFile(source.id, storedName)

      const progress = []
      const exported = await exportEditedRecording(
        project,
        {
          store,
          getSourceFile: () => store.getVideoFile(source),
          getAssetFile: async (requestedId) => {
            if (requestedId === assetId) {
              return store.getEditorAssetFile(source.id, storedName)
            }
            if (requestedId === imageId) {
              return store.getEditorAssetFile(source.id, imageStoredName)
            }
            throw new Error('unexpected asset')
          },
        },
        {
          sourceRecording: source,
          title: 'Prueba combinada',
          onProgress: (value) => progress.push(value),
        },
      )

      const file = await store.getVideoFile(exported.metadata)
      const bytes = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
      }

      const output = {
        base64: btoa(binary),
        exported: exported.metadata,
        sourceId: source.id,
        importedId: imported.id,
        projectDuration: projectDuration(project),
        progress,
        persistedClips: loaded.clips.length,
        persistedOverlays: loaded.overlays.length,
        persistedAssetSize: (assetFile as any).size,
        thumbnailExists: Boolean(exported.metadata.thumbnail),
      }

      await store.deleteRecording(exported.metadata.id)
      await store.deleteRecording(source.id)
      await store.deleteRecording(imported.id)
      return output
    })

    assert.deepEqual(pageErrors, [])
    assert.equal(result.exported.status, 'completed')
    assert.equal(result.exported.width, 320)
    assert.equal(result.exported.height, 240)
    assert.equal(result.exported.fps, 30)
    assert.equal(result.exported.hasAudio, true)
    assert.equal(result.exported.editedFrom, result.sourceId)
    assert.equal(result.exported.title, 'Prueba combinada')
    assert.equal(result.persistedClips, 4)
    assert.equal(result.persistedOverlays, 2)
    assert.ok(result.persistedAssetSize > 0)
    assert.equal(result.thumbnailExists, true)
    assert.ok(Math.abs(result.projectDuration - 3.7) < 0.01)
    assert.equal(result.progress.at(-1), 1)
    for (let index = 1; index < result.progress.length; index += 1) {
      assert.ok(
        result.progress[index] >= result.progress[index - 1],
        `progress went backwards: ${result.progress}`,
      )
    }

    const file = Buffer.from(result.base64, 'base64')
    writeFileSync(outputPath, file)
    const info = JSON.parse(
      execFileSync(
        'ffprobe',
        [
          '-v', 'error', '-show_entries',
          'format=duration:stream=codec_name,codec_type,width,height,sample_rate,channels',
          '-of', 'json', outputPath,
        ],
        { encoding: 'utf8' },
      ),
    )
    const format = Number(info.format.duration)
    assert.ok(Math.abs(format - 3.7) < 0.2, `duration=${format}`)
    assert.ok(info.streams.some((stream) => stream.codec_type === 'video'))
    assert.ok(info.streams.some((stream) => stream.codec_type === 'audio'))
    const video = info.streams.find((stream) => stream.codec_type === 'video')
    assert.equal(video.width, 320)
    assert.equal(video.height, 240)

    const samples = decodeAudio(outputPath)
    const firstRms = rms(samples, 0.15, 0.75)
    const acceleratedRms = rms(samples, 2.1, 2.4)
    const importedRms = rms(samples, 2.8, 3.6)
    assert.ok(firstRms > 0.1, 'first clip should have tone')
    assert.ok(rms(samples, 1.15, 1.85) < 0.01, 'muted clip should be silent')
    assert.ok(
      acceleratedRms > 0.08 && acceleratedRms < 0.13,
      `accelerated clip should be attenuated: rms=${acceleratedRms}`,
    )
    assert.ok(importedRms > 0.1, 'imported clip should have tone')
    assert.ok(
      Math.abs(acceleratedRms / importedRms - 0.5) < 0.12,
      `attenuated ratio=${acceleratedRms / importedRms}`,
    )
    assert.ok(
      Math.abs(firstRms / importedRms - 1.5) < 0.18,
      `boosted ratio=${firstRms / importedRms}`,
    )
    assert.ok(
      Math.abs(frequency(samples, 0.15, 0.75) - 1000) < 80,
      `first tone=${frequency(samples, 0.15, 0.75)}`,
    )
    assert.ok(
      Math.abs(frequency(samples, 2.1, 2.4) - 1000) < 100,
      `accelerated tone=${frequency(samples, 2.1, 2.4)}`,
    )
    assert.ok(
      Math.abs(frequency(samples, 2.8, 3.6) - 1500) < 100,
      `imported tone=${frequency(samples, 2.8, 3.6)}`,
    )

    const overlayPixel = framePixel(outputPath, 0.5, 160, 120, 320, 240)
    assert.ok(
      overlayPixel[0] > 200 && overlayPixel[1] < 80 && overlayPixel[2] < 80,
      `overlay pixel=${overlayPixel}`,
    )
    const importedPixel = framePixel(outputPath, 3.0, 160, 120, 320, 240)
    assert.ok(
      importedPixel[1] > 90 && importedPixel[0] < 100 && importedPixel[2] < 110,
      `imported pixel=${importedPixel}`,
    )
    const imagePixel = framePixel(outputPath, 0.5, 250, 45, 320, 240)
    assert.ok(
      imagePixel[0] > 180 && imagePixel[2] > 180 && imagePixel[1] < 90,
      `image overlay pixel=${imagePixel}`,
    )
  } finally {
    await page.close()
    rmSync(tempDirectory, { recursive: true, force: true })
  }
})

test('exports a WebM edit with VP9/Opus and a text overlay', { timeout: 120000 }, async () => {
  const page = await browser.newPage()
  const pageErrors = []
  const tempDirectory = mkdtempSync(join(tmpdir(), 'ratorder-editor-webm-'))
  const outputPath = join(tempDirectory, 'edited.webm')
  page.on('pageerror', (error) => pageErrors.push(error.message))

  try {
    await page.goto(origin, { waitUntil: 'networkidle0' })
    const result = await page.evaluate(async () => {
    const load = (p: any) => (0, eval)(`import(${JSON.stringify(p)})`); 
      const { RecordingController } = await load('/src/lib/recording/recording-controller.ts')
      const { RecordingStore } = await load('/src/lib/storage/recording-store.ts')
      const { DEFAULT_PREFERENCES } = await load('/src/lib/recording/config.ts')
      const {
        addOverlay,
        createDefaultProject,
        createOverlay,
      } = await load('/src/lib/editor/model.ts')
      const { exportEditedRecording } = await load('/src/lib/editor/export.ts')

      const store = new RecordingStore()
      const canvas = document.createElement('canvas')
      canvas.width = 320
      canvas.height = 240
      const context = canvas.getContext('2d')
      const drawTimer = setInterval(() => {
        context.fillStyle = '#224488'
        context.fillRect(0, 0, 320, 240)
      }, 30)
      const audioContext = new AudioContext({ sampleRate: 48000 })
      const oscillator = audioContext.createOscillator()
      oscillator.frequency.value = 440
      const gain = audioContext.createGain()
      gain.gain.value = 0.2
      const destination = audioContext.createMediaStreamDestination()
      oscillator.connect(gain).connect(destination)
      const capture = canvas.captureStream(30)
      capture.addTrack(destination.stream.getAudioTracks()[0])
      navigator.mediaDevices.getDisplayMedia = async () => capture
      navigator.mediaDevices.getUserMedia = async () => {
        throw new Error('microphone disabled')
      }
      const recorder = new RecordingController({ store })
      const preferences = {
        ...DEFAULT_PREFERENCES,
        microphoneId: 'off',
        quality: 'balanced',
        container: 'webm',
        fps: 30,
        systemAudio: true,
      }
      let metadata
      try {
        await audioContext.resume()
        oscillator.start()
        await recorder.selectSource(preferences)
        await recorder.start(preferences)
        await new Promise((resolve) => setTimeout(resolve, 1200))
        await recorder.stop()
        metadata = recorder.snapshot.completedRecording
        if (!metadata) throw new Error(recorder.snapshot.error ?? 'recording failed')
      } finally {
        clearInterval(drawTimer)
        recorder.dispose()
        capture.getTracks().forEach((track) => track.stop())
        await audioContext.close()
      }

      let project = createDefaultProject({
        sourceId: metadata.id,
        title: 'Prueba WebM',
        source: {
          duration: metadata.durationMs / 1000,
          width: metadata.width,
          height: metadata.height,
          fps: metadata.fps || 30,
          container: 'webm',
          hasAudio: true,
          extension: 'webm',
        },
      })
      project = addOverlay(project, createOverlay(project, 'text', 0.1))
      const exported = await exportEditedRecording(
        project,
        {
          store,
          getSourceFile: () => store.getVideoFile(metadata),
          getAssetFile: async () => {
            throw new Error('no assets')
          },
        },
        { sourceRecording: metadata, title: 'WebM editado' },
      )
      const file = await store.getVideoFile(exported.metadata)
      const bytes = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
      }
      const output = {
        base64: btoa(binary),
        metadata: exported.metadata,
        sourceId: metadata.id,
      }
      await store.deleteRecording(exported.metadata.id)
      await store.deleteRecording(metadata.id)
      return output
    })

    assert.deepEqual(pageErrors, [])
    assert.equal(result.metadata.status, 'completed')
    assert.equal(result.metadata.container, 'webm')
    assert.equal(result.metadata.extension, 'webm')
    assert.match(result.metadata.mimeType ?? '', /video\/webm/)
    assert.equal(result.metadata.editedFrom, result.sourceId)

    writeFileSync(outputPath, Buffer.from(result.base64, 'base64'))
    const info = JSON.parse(
      execFileSync(
        'ffprobe',
        [
          '-v', 'error', '-show_entries',
          'format=duration:stream=codec_name,codec_type,width,height',
          '-of', 'json', outputPath,
        ],
        { encoding: 'utf8' },
      ),
    )
    const video = info.streams.find((stream) => stream.codec_type === 'video')
    const audio = info.streams.find((stream) => stream.codec_type === 'audio')
    assert.ok(['vp9', 'av1', 'vp8'].includes(video.codec_name), video.codec_name)
    assert.equal(audio.codec_name, 'opus')
    assert.equal(video.width, 320)
    assert.equal(video.height, 240)
    assert.ok(Math.abs(Number(info.format.duration) - 1.2) < 0.2)
  } finally {
    await page.close()
    rmSync(tempDirectory, { recursive: true, force: true })
  }
})
