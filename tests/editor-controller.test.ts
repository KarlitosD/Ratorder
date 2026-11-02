import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import puppeteer from 'puppeteer-core'
import { createServer } from 'vite'

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

test('restores a saved edit, keeps history and reopens the project', { timeout: 90000 }, async () => {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))

  try {
    await page.goto(origin, { waitUntil: 'networkidle0' })
    const result = await page.evaluate(async () => {
    const load = (p: any) => (0, eval)(`import(${JSON.stringify(p)})`); 
      const { RecordingController } = await load('/src/lib/recording/recording-controller.ts')
      const { RecordingStore } = await load('/src/lib/storage/recording-store.ts')
      const { DEFAULT_PREFERENCES } = await load('/src/lib/recording/config.ts')
      const { EditorController } = await load('/src/lib/editor/controller.ts')
      const {
        addOverlay,
        createDefaultProject,
        createOverlay,
        splitAt,
      } = await load('/src/lib/editor/model.ts')

      const store = new RecordingStore()
      const canvas = document.createElement('canvas')
      canvas.width = 320
      canvas.height = 240
      const context = canvas.getContext('2d')
      context.fillStyle = '#335577'
      const drawTimer = setInterval(() => {
        context.fillRect(0, 0, 320, 240)
      }, 30)
      const audioContext = new AudioContext({ sampleRate: 48000 })
      const oscillator = audioContext.createOscillator()
      oscillator.frequency.value = 440
      const gain = audioContext.createGain()
      gain.gain.value = 0.1
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
      let metadata
      try {
        await audioContext.resume()
        oscillator.start()
        await recorder.selectSource(preferences)
        await recorder.start(preferences)
        await new Promise((resolve) => setTimeout(resolve, 1600))
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
        title: 'Proyecto persistente',
        source: {
          duration: metadata.durationMs / 1000,
          width: metadata.width,
          height: metadata.height,
          fps: metadata.fps || 30,
          container: 'mp4',
          hasAudio: metadata.hasAudio,
          extension: 'mp4',
        },
      })
      project = splitAt(project, 0.6)
      project = addOverlay(project, createOverlay(project, 'text', 0.2))

      const imageCanvas = document.createElement('canvas')
      imageCanvas.width = 64
      imageCanvas.height = 48
      const imageContext = imageCanvas.getContext('2d')
      imageContext.fillStyle = '#FF8800'
      imageContext.fillRect(0, 0, 64, 48)
      const imageBlob = await new Promise((resolve) =>
        imageCanvas.toBlob((blob) => resolve(blob), 'image/png'),
      )
      if (!imageBlob) throw new Error('image blob failed')
      const imageId = crypto.randomUUID()
      const imageStoredName = `${imageId}.png`
      await store.saveEditorAsset(metadata.id, imageStoredName, imageBlob)
      const imageAsset = {
        id: imageId,
        kind: 'image',
        name: 'prueba.png',
        storedName: imageStoredName,
        extension: 'png',
        mimeType: 'image/png',
        size: (imageBlob as any).size,
        duration: 0,
        width: 64,
        height: 48,
        hasAudio: false,
      }
      project = { ...project, assets: [imageAsset] }
      project = addOverlay(
        project,
        createOverlay(project, 'image', 0.1, imageId),
      )
      await store.saveEditorProject(metadata.id, project)

      const first = new EditorController({ store, recording: metadata })
      await first.initialize()
      const restored = {
        status: first.snapshot.status,
        clips: first.snapshot.project?.clips.length,
        overlays: first.snapshot.project?.overlays.length,
        assets: first.snapshot.project?.assets.length,
        selection: first.snapshot.selection?.type,
        dirty: first.snapshot.dirty,
      }

      const extraCanvas = document.createElement('canvas')
      extraCanvas.width = 32
      extraCanvas.height = 32
      const extraContext = extraCanvas.getContext('2d')
      extraContext.fillStyle = '#33CC44'
      extraContext.fillRect(0, 0, 32, 32)
      const extraBlob = await new Promise((resolve) =>
        extraCanvas.toBlob((blob) => resolve(blob), 'image/png'),
      )
      await first.importImage(
        new File([extraBlob as any], 'extra.png', { type: 'image/png' }),
      )
      const importedAsset = first.snapshot.project?.assets.find(
        (asset) => asset.id !== imageId,
      )
      const importedStoredName = importedAsset?.storedName
      first.discardChanges()
      await new Promise((resolve) => setTimeout(resolve, 200))
      let importedDeleted = false
      if (importedStoredName) {
        try {
          await store.getEditorAssetFile(metadata.id, importedStoredName)
        } catch {
          importedDeleted = true
        }
      }
      let baselineAssetExists = false
      try {
        await store.getEditorAssetFile(metadata.id, imageStoredName)
        baselineAssetExists = true
      } catch {
        baselineAssetExists = false
      }

      first.seek(0.3)
      first.splitAtPlayhead()
      const afterSplit = first.snapshot.project?.clips.length
      const dirtyAfterSplit = first.snapshot.dirty
      const onDiskAfterSplit = await store.getEditorProject(metadata.id)
      first.undo()
      const afterUndo = first.snapshot.project?.clips.length
      const dirtyAfterUndo = first.snapshot.dirty
      first.redo()
      const afterRedo = first.snapshot.project?.clips.length
      first.discardChanges()
      const afterDiscard = first.snapshot.project?.clips.length
      const dirtyAfterDiscard = first.snapshot.dirty
      first.splitAtPlayhead()
      await first.saveNow()
      const dirtyAfterSave = first.snapshot.dirty
      const onDiskAfterSave = await store.getEditorProject(metadata.id)
      first.resetToOriginal()
      const reset = {
        clips: first.snapshot.project?.clips.length,
        overlays: first.snapshot.project?.overlays.length,
        assets: first.snapshot.project?.assets.length,
        dirty: first.snapshot.dirty,
      }
      first.undo()
      const afterResetUndo = first.snapshot.project?.clips.length
      await first.saveNow()
      first.dispose()
      await new Promise((resolve) => setTimeout(resolve, 200))

      const second = new EditorController({ store, recording: metadata })
      await second.initialize()
      await second.saveNow()
      const reopened = {
        status: second.snapshot.status,
        clips: second.snapshot.project?.clips.length,
        overlays: second.snapshot.project?.overlays.length,
        assets: second.snapshot.project?.assets.length,
        saved: second.snapshot.savedAt !== null,
        dirty: second.snapshot.dirty,
      }
      second.dispose()
      await new Promise((resolve) => setTimeout(resolve, 200))
      await store.deleteRecording(metadata.id)
      return {
        restored,
        afterSplit,
        dirtyAfterSplit,
        onDiskAfterSplitClips: onDiskAfterSplit?.clips?.length,
        afterUndo,
        dirtyAfterUndo,
        afterRedo,
        afterDiscard,
        dirtyAfterDiscard,
        dirtyAfterSave,
        onDiskAfterSaveClips: onDiskAfterSave?.clips?.length,
        reset,
        afterResetUndo,
        reopened,
        importedDeleted,
        baselineAssetExists,
      }
    })

    assert.deepEqual(errors, [])
    assert.equal(result.restored.status, 'ready')
    assert.equal(result.restored.clips, 2)
    assert.equal(result.restored.overlays, 2)
    assert.equal(result.restored.assets, 1)
    assert.equal(result.restored.selection, 'clip')
    assert.equal(result.restored.dirty, false)
    assert.equal(result.afterSplit, 3)
    assert.equal(result.dirtyAfterSplit, true)
    assert.equal(result.onDiskAfterSplitClips, 2)
    assert.equal(result.afterUndo, 2)
    assert.equal(result.dirtyAfterUndo, false)
    assert.equal(result.afterRedo, 3)
    assert.equal(result.afterDiscard, 2)
    assert.equal(result.dirtyAfterDiscard, false)
    assert.equal(result.dirtyAfterSave, false)
    assert.equal(result.onDiskAfterSaveClips, 3)
    assert.equal(result.reset.clips, 1)
    assert.equal(result.reset.overlays, 0)
    assert.equal(result.reset.assets, 0)
    assert.equal(result.reset.dirty, true)
    assert.equal(result.afterResetUndo, 3)
    assert.equal(result.reopened.status, 'ready')
    assert.equal(result.reopened.clips, 3)
    assert.equal(result.reopened.overlays, 2)
    assert.equal(result.reopened.assets, 1)
    assert.equal(result.reopened.saved, true)
    assert.equal(result.reopened.dirty, false)
    assert.equal(result.importedDeleted, true)
    assert.equal(result.baselineAssetExists, true)
  } finally {
    await page.close()
  }
})
