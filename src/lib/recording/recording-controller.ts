import {
  MediaStreamAudioTrackSource,
  MediaStreamVideoTrackSource,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  WebMOutputFormat,
  type AudioCodec,
  type VideoCodec,
} from 'mediabunny'
import type {
  CaptureSourceInfo,
  RecorderSnapshot,
  RecordingMetadata,
  RecordingPreferences,
} from '../types'
import { chooseAudioCodec, chooseVideoCodec } from '../media/codecs'
import { OpfsStreamWriter } from '../storage/opfs-stream-writer'
import { holdRecordingLock } from '../storage/recording-lock'
import type { RecordingStore } from '../storage/recording-store'
import { AudioMixer } from './audio-mixer'
import {
  computeOutputDimensions,
  computeVideoBitrate,
  QUALITY_PRESETS,
} from './config'

type NoticeKind = 'info' | 'success' | 'warning' | 'error'

interface RecordingControllerDeps {
  store: RecordingStore
  onNotice?: (message: string, kind: NoticeKind) => void
  onRecordingFinished?: (recording: RecordingMetadata) => void
  onRecordingCleanup?: () => void
}

interface ActiveSession {
  releaseLock: () => void
  id: string
  metadata: RecordingMetadata
  output: Output
  writer: OpfsStreamWriter
  videoSource: MediaStreamVideoTrackSource
  audioSource: MediaStreamAudioTrackSource | null
  mixer: AudioMixer | null
  microphoneStream: MediaStream | null
  systemAudioStream: MediaStream | null
  segmentStartedAt: number
  accumulatedMs: number
  tickTimer: ReturnType<typeof setInterval> | null
  lastHeartbeatAt: number
  lastReportedSecond: number
  stopping: boolean
  autoStopped: boolean
}

// Chrome enables echo cancellation, noise suppression and AGC for display
// audio by default, which also downmixes tab audio to mono. Disabling them
// keeps tab audio unprocessed (usually stereo). These are ideals, so browsers
// that cannot honor them still capture audio.
const DISPLAY_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
}

const INITIAL_SNAPSHOT: RecorderSnapshot = {
  phase: 'idle',
  source: null,
  previewStream: null,
  elapsedMs: 0,
  bytesWritten: 0,
  hasAudio: false,
  microphoneActive: false,
  systemAudioActive: false,
  microphoneMuted: false,
  error: null,
  completedRecording: null,
  activeRecordingId: null,
  outputWidth: null,
  outputHeight: null,
}

export class RecordingController {
  #deps: RecordingControllerDeps
  #snapshot: RecorderSnapshot = { ...INITIAL_SNAPSHOT }
  #listeners = new Set<(snapshot: RecorderSnapshot) => void>()
  #sourceStream: MediaStream | null = null
  #sourceInfo: CaptureSourceInfo | null = null
  #session: ActiveSession | null = null
  #selecting = false
  #beforeUnloadHandler = (event: BeforeUnloadEvent) => {
    if (!this.#session) return
    event.preventDefault()
    event.returnValue = ''
  }

  constructor(deps: RecordingControllerDeps) {
    this.#deps = deps
  }

  get snapshot(): RecorderSnapshot {
    return this.#snapshot
  }

  subscribe(listener: (snapshot: RecorderSnapshot) => void): () => void {
    this.#listeners.add(listener)
    listener(this.#snapshot)
    return () => this.#listeners.delete(listener)
  }

  async selectSource(preferences: RecordingPreferences): Promise<void> {
    if (this.#selecting) return
    if (
      this.#snapshot.phase === 'recording' ||
      this.#snapshot.phase === 'paused' ||
      this.#snapshot.phase === 'finalizing' ||
      this.#snapshot.phase === 'preparing'
    ) {
      return
    }

    this.#selecting = true
    this.#emit({ phase: 'preparing', error: null, completedRecording: null })

    try {
      const options = {
        video: {
          frameRate: { ideal: preferences.fps, max: 60 },
        },
        audio: preferences.systemAudio ? DISPLAY_AUDIO_CONSTRAINTS : false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        systemAudio: preferences.systemAudio ? 'include' : 'exclude',
      } as DisplayMediaStreamOptions & Record<string, unknown>

      const stream = await navigator.mediaDevices.getDisplayMedia(options)
      const [videoTrack] = stream.getVideoTracks()
      if (!videoTrack) {
        stream.getTracks().forEach((track) => track.stop())
        throw new Error('No se recibió ninguna imagen de la fuente elegida.')
      }

      this.#releaseSource()
      this.#sourceStream = stream
      this.#sourceInfo = this.#describeSource(stream, preferences)
      videoTrack.addEventListener('ended', this.#handleSourceEnded)

      this.#emit({
        phase: 'idle',
        source: this.#sourceInfo,
        previewStream: stream,
        elapsedMs: 0,
        bytesWritten: 0,
        hasAudio: false,
        microphoneActive: false,
        systemAudioActive: false,
        microphoneMuted: false,
        outputWidth: this.#sourceInfo.width,
        outputHeight: this.#sourceInfo.height,
      })
    } catch (error) {
      this.#emit({ phase: 'idle' })
      if (!this.#isSelectionCancelled(error)) {
        const message = this.#describeError(
          error,
          'No se pudo acceder a la fuente de pantalla.',
        )
        this.#emit({ error: message })
        this.#notify(message, 'error')
      }
    } finally {
      this.#selecting = false
    }
  }

  async start(preferences: RecordingPreferences): Promise<void> {
    if (this.#snapshot.phase !== 'idle' && this.#snapshot.phase !== 'error') {
      return
    }
    if (!this.#sourceStream) return
    const videoTrack = this.#sourceStream.getVideoTracks()[0]
    if (!videoTrack || videoTrack.readyState !== 'live') {
      this.#emit({ error: 'La fuente de pantalla ya no está disponible.' })
      return
    }

    this.#emit({
      phase: 'preparing',
      error: null,
      completedRecording: null,
      elapsedMs: 0,
      bytesWritten: 0,
      microphoneMuted: false,
    })

    let microphoneStream: MediaStream | null = null
    let systemAudioStream: MediaStream | null = null
    let mixer: AudioMixer | null = null
    let writer: OpfsStreamWriter | null = null
    let output: Output | null = null
    let videoSource: MediaStreamVideoTrackSource | null = null
    let audioSource: MediaStreamAudioTrackSource | null = null
    let recordingMetadata: RecordingMetadata | null = null
    let releaseLock: (() => void) | null = null

    try {
      if (preferences.microphoneId !== 'off') {
        microphoneStream = await this.#captureMicrophone(preferences.microphoneId)
      }

      const systemTracks = this.#sourceStream.getAudioTracks()
      if (preferences.systemAudio && systemTracks.length > 0) {
        systemAudioStream = new MediaStream(systemTracks)
      }

      if (microphoneStream) {
        try {
          mixer = await AudioMixer.create({
            microphoneStream,
            systemAudioStream,
          })
        } catch (error) {
          console.warn('No se pudo iniciar la mezcla de audio.', error)
          mixer = null
          microphoneStream?.getTracks().forEach((track) => track.stop())
          microphoneStream = null

          if (systemAudioStream) {
            this.#notify(
              'No se pudo procesar el micrófono. Se grabará solo el audio del sistema.',
              'warning',
            )
          } else {
            systemAudioStream = null
            this.#notify(
              'No se pudo preparar el audio. La grabación continuará sin sonido.',
              'warning',
            )
          }
        }
      }

      const directSystemTrack =
        !mixer && !microphoneStream
          ? (systemAudioStream?.getAudioTracks()[0] as
              | MediaStreamAudioTrack
              | undefined)
          : undefined

      await videoTrack
        .applyConstraints({ frameRate: { ideal: preferences.fps } })
        .catch(() => undefined)

      const sourceSettings = videoTrack.getSettings()
      const sourceWidth = sourceSettings.width || this.#sourceInfo?.width || 1920
      const sourceHeight =
        sourceSettings.height || this.#sourceInfo?.height || 1080

      if (this.#sourceInfo) {
        this.#sourceInfo = {
          ...this.#sourceInfo,
          width: sourceWidth,
          height: sourceHeight,
          fps: Math.round(sourceSettings.frameRate ?? preferences.fps),
        }
        this.#emit({ source: this.#sourceInfo })
      }

      const dimensions = computeOutputDimensions(
        sourceWidth,
        sourceHeight,
        preferences.quality,
      )
      const videoBitrate = computeVideoBitrate(
        preferences.quality,
        preferences.fps,
      )
      const container = preferences.container
      const format =
        container === 'mp4'
          ? new Mp4OutputFormat({
              fastStart: 'fragmented',
              minimumFragmentDuration: preferences.fragmentDuration,
            })
          : new WebMOutputFormat()

      const videoCodec = await chooseVideoCodec(container, {
        width: dimensions.width,
        height: dimensions.height,
        fps: preferences.fps,
        bitrate: videoBitrate,
      })
      if (!videoCodec) {
        throw new Error(
          container === 'mp4'
            ? 'Este navegador no puede codificar video MP4 (H.264/AV1). Prueba con WebM.'
            : 'Este navegador no puede codificar video WebM (VP9/AV1). Prueba con MP4.',
        )
      }

      let audioCodec: AudioCodec | null = null
      const audioInputTrack = mixer?.track ?? directSystemTrack
      if (audioInputTrack) {
        // Some capture tracks omit these settings; they are hints, not guarantees
        // about the format of the first AudioData delivered by the browser.
        const audioSettings = audioInputTrack.getSettings()
        audioCodec = await chooseAudioCodec(container, {
          numberOfChannels: audioSettings.channelCount || 2,
          sampleRate: audioSettings.sampleRate || 48_000,
          bitrate: preferences.audioBitrate,
        })
        if (!audioCodec) {
          await mixer?.close()
          mixer = null
          systemAudioStream?.getTracks().forEach((track) => track.stop())
          systemAudioStream = null
          microphoneStream?.getTracks().forEach((track) => track.stop())
          microphoneStream = null
          this.#notify(
            'El audio no se puede codificar en este navegador. La grabación continuará sin sonido.',
            'warning',
          )
        }
      }

      videoSource = new MediaStreamVideoTrackSource(
        videoTrack,
        {
          codec: videoCodec,
          quality: new Quality({
            bitrate: videoBitrate,
            bitrateMode: 'variable',
          }),
          keyFrameInterval: 2,
          sizeChangeBehavior: 'contain',
          ...(dimensions.width !== sourceWidth || dimensions.height !== sourceHeight
            ? {
                transform: {
                  width: dimensions.width,
                  height: dimensions.height,
                  fit: 'contain' as const,
                },
              }
            : {}),
        },
        { frameRate: preferences.fps, timestampBase: 'synced-zero' },
      )

      if (audioInputTrack && audioCodec) {
        // Preserve the track's native audio format. Forcing a transform activates
        // resampling, which turns capture timestamp jitter into gaps and overlaps.
        audioSource = new MediaStreamAudioTrackSource(
          audioInputTrack as MediaStreamAudioTrack,
          {
            codec: audioCodec,
            quality: new Quality({ bitrate: preferences.audioBitrate }),
          },
          { timestampBase: 'synced-zero' },
        )
      }

      const recordingId = crypto.randomUUID()
      releaseLock = await holdRecordingLock(recordingId)
      const now = new Date()
      const metadata = this.#createMetadata(
        recordingId,
        now,
        preferences,
        dimensions,
        videoCodec,
        audioCodec,
        Boolean(microphoneStream),
        Boolean(systemAudioStream),
      )
      recordingMetadata = metadata

      writer = await OpfsStreamWriter.open(
        recordingId,
        preferences.container,
        (error) => this.#handleWriterFatal(error),
      )

      await this.#deps.store.createRecording(metadata)
      this.#emit({ activeRecordingId: recordingId })

      const target = new StreamTarget(writer.createWritable(), {
        chunked: true,
        chunkSize: 64 * 1024,
      })
      output = new Output({ format, target })
      output.addVideoTrack(videoSource, {
        frameRate: preferences.fps,
        bitrate: videoBitrate,
        name: 'Pantalla',
      })
      if (audioSource) {
        output.addAudioTrack(audioSource, {
          bitrate: preferences.audioBitrate,
          name: 'Audio mezclado',
        })
      }

      void videoSource.errorPromise.catch((error) => {
        this.#handleRuntimeError(error)
      })
      if (audioSource) {
        void audioSource.errorPromise.catch((error) => {
          this.#handleRuntimeError(error)
        })
      }

      await output.start()

      const startedAt = performance.now()
      const session: ActiveSession = {
        releaseLock,
        id: recordingId,
        metadata,
        output,
        writer,
        videoSource,
        audioSource,
        mixer,
        microphoneStream,
        systemAudioStream,
        segmentStartedAt: startedAt,
        accumulatedMs: 0,
        tickTimer: null,
        lastHeartbeatAt: Date.now(),
        lastReportedSecond: 0,
        stopping: false,
        autoStopped: false,
      }
      this.#session = session
      window.addEventListener('beforeunload', this.#beforeUnloadHandler)
      this.#startTicker(session)

      this.#emit({
        phase: 'recording',
        hasAudio: Boolean(audioSource),
        microphoneActive: Boolean(microphoneStream),
        systemAudioActive: Boolean(systemAudioStream),
        elapsedMs: 0,
        bytesWritten: writer.bytesWritten,
        activeRecordingId: session.id,
        outputWidth: dimensions.width,
        outputHeight: dimensions.height,
      })

      const audioStreams = [
        [systemAudioStream, 'system'],
        [microphoneStream, 'microphone'],
      ] as const
      for (const [stream, kind] of audioStreams) {
        const track = stream?.getAudioTracks()[0]
        if (!track) continue
        const onEnded = () => {
          if (this.#session !== session || session.stopping) return
          const patch = kind === 'system'
            ? { systemAudioActive: false, hasAudio: this.#snapshot.microphoneActive }
            : { microphoneActive: false, hasAudio: this.#snapshot.systemAudioActive }
          this.#emit(patch)
          this.#notify(
            kind === 'system'
              ? 'Se perdió el audio del sistema durante la grabación.'
              : 'Se perdió el micrófono durante la grabación.',
            'warning',
          )
        }
        track.addEventListener('ended', onEnded, { once: true })
        if (track.readyState === 'ended') onEnded()
      }

      if (audioCodec === 'opus' && container === 'mp4') {
        this.#notify(
          'El audio se guardó en Opus porque este equipo no dispone de codificador AAC.',
          'info',
        )
      }
    } catch (error) {
      await this.#cleanFailedStart({
        output,
        writer,
        audioSource,
        videoSource,
        mixer,
        microphoneStream,
        systemAudioStream,
      })

      let interruptedMetadata: RecordingMetadata | null = null
      if (recordingMetadata) {
        const bytes = writer?.bytesWritten ?? 0
        if (bytes > 0) {
          interruptedMetadata = {
            ...recordingMetadata,
            status: 'interrupted',
            size: bytes,
            updatedAt: new Date().toISOString(),
            note: 'La grabación no pudo iniciarse por completo. Se conserva el contenido escrito en disco.',
          }
          await this.#deps.store
            .saveMetadata(interruptedMetadata)
            .catch(() => undefined)
        } else {
          await this.#deps.store
            .deleteRecording(recordingMetadata.id)
            .catch(() => undefined)
        }
      }
      releaseLock?.()

      const message = this.#describeError(
        error,
        'No se pudo iniciar la grabación.',
      )
      this.#emit({ phase: 'error', error: message, activeRecordingId: null })
      this.#notify(message, 'error')
      if (interruptedMetadata) {
        this.#deps.onRecordingFinished?.(interruptedMetadata)
      }
      this.#deps.onRecordingCleanup?.()
    }
  }

  async stop(thumbnail?: Blob): Promise<void> {
    await this.#stopInternal(thumbnail, false)
  }

  pause(): void {
    const session = this.#session
    if (!session || this.#snapshot.phase !== 'recording') return
    session.accumulatedMs = this.#currentElapsed(session)
    session.videoSource.pause()
    session.audioSource?.pause()
    this.#stopTicker(session)
    const elapsedMs = session.accumulatedMs
    this.#emit({ phase: 'paused', elapsedMs })
    void this.#persistProgress(session, 'recording').catch(() => undefined)
  }

  resume(): void {
    const session = this.#session
    if (!session || this.#snapshot.phase !== 'paused') return
    session.segmentStartedAt = performance.now()
    session.videoSource.resume()
    session.audioSource?.resume()
    void session.mixer?.resume()
    this.#startTicker(session)
    this.#emit({ phase: 'recording' })
  }

  setMicrophoneMuted(muted: boolean): void {
    const session = this.#session
    if (!session) return
    session.mixer?.setMicrophoneMuted(muted)
    this.#emit({ microphoneMuted: muted })
  }

  reset(): void {
    if (
      this.#snapshot.phase === 'recording' ||
      this.#snapshot.phase === 'paused' ||
      this.#snapshot.phase === 'finalizing'
    ) {
      return
    }
    this.#releaseSource()
    this.#emit({
      ...INITIAL_SNAPSHOT,
      phase: 'idle',
    })
  }

  dispose(): void {
    window.removeEventListener('beforeunload', this.#beforeUnloadHandler)
    this.#releaseSource()
    const session = this.#session
    if (session) {
      this.#stopTicker(session)
      void session.output.cancel().catch(() => undefined)
      void session.writer.abort()
      void session.mixer?.close()
      session.releaseLock()
    }
    this.#session = null
    this.#listeners.clear()
  }

  async #stopInternal(thumbnail: Blob | undefined, autoStopped: boolean) {
    const session = this.#session
    if (!session || session.stopping) return
    if (this.#snapshot.phase !== 'recording' && this.#snapshot.phase !== 'paused') {
      return
    }

    session.stopping = true
    session.autoStopped = autoStopped
    session.accumulatedMs = this.#currentElapsed(session)
    this.#stopTicker(session)
    window.removeEventListener('beforeunload', this.#beforeUnloadHandler)
    this.#emit({
      phase: 'finalizing',
      elapsedMs: session.accumulatedMs,
    })

    try {
      await session.output.finalize()
      const mimeType = await session.output.getMimeType().catch(() => null)
      const size = await session.writer.close()
      session.metadata = {
        ...session.metadata,
        updatedAt: new Date().toISOString(),
        durationMs: Math.round(session.accumulatedMs),
        size,
        mimeType,
        status: 'completed',
        note: autoStopped
          ? 'La captura se detuvo desde el navegador.'
          : undefined,
      }
      if (thumbnail && thumbnail.size > 0) {
        try {
          session.metadata.thumbnail =
            await this.#deps.store.saveThumbnail(session.id, thumbnail)
        } catch (error) {
          console.warn('No se pudo guardar la miniatura.', error)
        }
      }
      await this.#deps.store.saveMetadata(session.metadata)
      this.#emit({
        phase: 'completed',
        elapsedMs: session.accumulatedMs,
        bytesWritten: size,
        completedRecording: session.metadata,
        hasAudio: false,
        microphoneActive: false,
        systemAudioActive: false,
        microphoneMuted: false,
        previewStream: null,
        source: null,
        activeRecordingId: null,
        outputWidth: null,
        outputHeight: null,
      })
      this.#deps.onRecordingFinished?.(session.metadata)
      this.#notify(
        autoStopped
          ? 'Se guardó el contenido grabado hasta que finalizó la captura.'
          : 'Grabación guardada en tu biblioteca local.',
        'success',
      )
    } catch (error) {
      const message = this.#describeError(
        error,
        'La grabación no se pudo cerrar correctamente.',
      )
      await session.output.cancel().catch(() => undefined)
      const size = await session.writer.close().catch(() => session.writer.bytesWritten)
      session.metadata = {
        ...session.metadata,
        updatedAt: new Date().toISOString(),
        durationMs: Math.round(session.accumulatedMs),
        size,
        status: 'interrupted',
        note: 'El cierre de la grabación no terminó correctamente. Se conserva el contenido escrito en disco.',
      }
      await this.#deps.store.saveMetadata(session.metadata).catch(() => undefined)
      this.#emit({
        phase: 'error',
        error: message,
        elapsedMs: session.accumulatedMs,
        bytesWritten: size,
        previewStream: null,
        source: null,
        activeRecordingId: null,
      })
      this.#deps.onRecordingFinished?.(session.metadata)
      this.#notify(message, 'error')
    } finally {
      session.releaseLock()
      this.#session = null
      this.#stopTicker(session)
      session.audioSource?.pause()
      session.videoSource.pause()
      safeCloseSource(session.audioSource)
      safeCloseSource(session.videoSource)
      await session.mixer?.close().catch(() => undefined)
      session.microphoneStream?.getTracks().forEach((track) => track.stop())
      session.systemAudioStream?.getTracks().forEach((track) => track.stop())
      this.#releaseSource()
      this.#emit({ source: null, previewStream: null })
      this.#deps.onRecordingCleanup?.()
    }
  }

  #startTicker(session: ActiveSession) {
    this.#stopTicker(session)
    session.tickTimer = setInterval(() => {
      if (this.#session !== session) return
      const elapsedMs = this.#currentElapsed(session)
      const second = Math.floor(elapsedMs / 1000)
      if (second === session.lastReportedSecond) return
      session.lastReportedSecond = second
      this.#emit({
        elapsedMs,
        bytesWritten: session.writer.bytesWritten,
      })

      if (Date.now() - session.lastHeartbeatAt >= 5000) {
        session.lastHeartbeatAt = Date.now()
        void this.#persistProgress(session, 'recording').catch((error) => {
          console.warn('No se pudo actualizar la metadata de progreso.', error)
        })
      }
    }, 500)
  }

  #stopTicker(session: ActiveSession) {
    if (session.tickTimer !== null) {
      clearInterval(session.tickTimer)
      session.tickTimer = null
    }
  }

  #currentElapsed(session: ActiveSession): number {
    if (this.#snapshot.phase === 'recording' && this.#session === session) {
      return session.accumulatedMs + (performance.now() - session.segmentStartedAt)
    }
    return session.accumulatedMs
  }

  async #persistProgress(
    session: ActiveSession,
    status: RecordingMetadata['status'],
  ): Promise<void> {
    const metadata: RecordingMetadata = {
      ...session.metadata,
      durationMs: Math.round(this.#currentElapsed(session)),
      size: session.writer.bytesWritten,
      status,
    }
    session.metadata = metadata
    await this.#deps.store.saveMetadata(metadata)
  }

  #handleSourceEnded = (event: Event) => {
    const endedTrack = event.target
    if (
      !(endedTrack instanceof MediaStreamTrack) ||
      this.#sourceStream?.getVideoTracks()[0] !== endedTrack
    ) {
      return
    }

    if (
      this.#session &&
      !this.#session.stopping &&
      (this.#snapshot.phase === 'recording' || this.#snapshot.phase === 'paused')
    ) {
      this.#notify('La fuente dejó de compartirse. Cerrando la grabación…', 'info')
      void this.#stopInternal(undefined, true)
      return
    }

    if (!this.#session) {
      this.#releaseSource()
      this.#emit({
        phase: 'idle',
        source: null,
        previewStream: null,
        outputWidth: null,
        outputHeight: null,
      })
      this.#notify('La fuente dejó de compartirse.', 'info')
    }
  }

  #handleRuntimeError(error: unknown) {
    const session = this.#session
    if (!session || session.stopping) return
    const message = this.#describeError(
      error,
      'La grabación se detuvo por un error interno.',
    )
    this.#notify(message, 'error')
    void this.#abortSession(session, message)
  }

  #handleWriterFatal(error: Error) {
    this.#handleRuntimeError(error)
  }

  async #abortSession(session: ActiveSession, message: string) {
    if (session.stopping) return
    session.stopping = true
    session.accumulatedMs = this.#currentElapsed(session)
    this.#stopTicker(session)
    window.removeEventListener('beforeunload', this.#beforeUnloadHandler)
    this.#emit({ phase: 'finalizing', elapsedMs: session.accumulatedMs })

    await session.output.cancel().catch(() => undefined)
    const size = await session.writer
      .close()
      .catch(() => session.writer.bytesWritten)
    session.metadata = {
      ...session.metadata,
      updatedAt: new Date().toISOString(),
      durationMs: Math.round(session.accumulatedMs),
      size,
      status: 'interrupted',
      note: 'La grabación se interrumpió por un error. Se conserva el contenido escrito en disco.',
    }
    await this.#deps.store.saveMetadata(session.metadata).catch(() => undefined)
    session.releaseLock()
    this.#session = null
    await session.mixer?.close().catch(() => undefined)
    session.audioSource?.pause()
    session.videoSource.pause()
    safeCloseSource(session.audioSource)
    safeCloseSource(session.videoSource)
    session.microphoneStream?.getTracks().forEach((track) => track.stop())
    session.systemAudioStream?.getTracks().forEach((track) => track.stop())
    this.#releaseSource()
    this.#emit({
      phase: 'error',
      error: message,
      elapsedMs: session.accumulatedMs,
      bytesWritten: size,
      hasAudio: false,
      microphoneActive: false,
      systemAudioActive: false,
      previewStream: null,
      source: null,
      activeRecordingId: null,
    })
    this.#deps.onRecordingFinished?.(session.metadata)
    this.#deps.onRecordingCleanup?.()
  }

  async #cleanFailedStart(parts: {
    output: Output | null
    writer: OpfsStreamWriter | null
    videoSource: MediaStreamVideoTrackSource | null
    audioSource: MediaStreamAudioTrackSource | null
    mixer: AudioMixer | null
    microphoneStream: MediaStream | null
    systemAudioStream: MediaStream | null
  }) {
    if (parts.output) {
      await parts.output.cancel().catch(() => undefined)
    }
    if (parts.writer) {
      await parts.writer.abort().catch(() => undefined)
    }
    parts.videoSource?.pause()
    parts.audioSource?.pause()
    safeCloseSource(parts.videoSource)
    safeCloseSource(parts.audioSource)
    await parts.mixer?.close().catch(() => undefined)
    parts.microphoneStream?.getTracks().forEach((track) => track.stop())
    parts.systemAudioStream?.getTracks().forEach((track) => track.stop())
  }

  async #captureMicrophone(deviceId: string): Promise<MediaStream | null> {
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }
    if (deviceId !== 'default') {
      audioConstraints.deviceId = { exact: deviceId }
    }

    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false,
      })
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'No se concedió permiso al micrófono. La grabación continuará sin él.'
          : 'No se pudo acceder al micrófono. La grabación continuará sin él.'
      this.#notify(message, 'warning')
      return null
    }
  }

  #describeSource(
    stream: MediaStream,
    preferences: RecordingPreferences,
  ): CaptureSourceInfo {
    const videoTrack = stream.getVideoTracks()[0]
    const settings = videoTrack.getSettings()
    const displaySurface = settings.displaySurface ?? null
    const labels: Record<string, string> = {
      browser: 'Pestaña del navegador',
      window: 'Ventana',
      monitor: 'Pantalla completa',
    }
    const label =
      labels[displaySurface ?? ''] ||
      videoTrack.label ||
      'Fuente de pantalla'

    return {
      label,
      width: Math.round(settings.width ?? 0),
      height: Math.round(settings.height ?? 0),
      fps: Math.round(settings.frameRate ?? preferences.fps),
      hasSystemAudio: stream.getAudioTracks().length > 0,
      displaySurface,
      trackLabel: videoTrack.label,
    }
  }

  #createMetadata(
    id: string,
    now: Date,
    preferences: RecordingPreferences,
    dimensions: { width: number; height: number },
    videoCodec: VideoCodec,
    audioCodec: AudioCodec | null,
    hasMicrophone: boolean,
    hasSystemAudio: boolean,
  ): RecordingMetadata {
    const title = `Grabación · ${new Intl.DateTimeFormat('es-ES', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(now)}`
    return {
      version: 1,
      id,
      title,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      startedAtEpochMs: now.getTime(),
      durationMs: 0,
      size: 0,
      width: dimensions.width,
      height: dimensions.height,
      fps: preferences.fps,
      container: preferences.container,
      extension: preferences.container,
      mimeType: null,
      status: 'recording',
      hasAudio: Boolean(audioCodec),
      hasMicrophone,
      hasSystemAudio,
      audioCodec,
      videoCodec,
      sourceLabel: this.#sourceInfo?.label ?? 'Captura de pantalla',
      thumbnail: null,
    }
  }

  #releaseSource() {
    if (this.#sourceStream) {
      const [videoTrack] = this.#sourceStream.getVideoTracks()
      videoTrack?.removeEventListener('ended', this.#handleSourceEnded)
      this.#sourceStream.getTracks().forEach((track) => {
        if (track.readyState === 'live') track.stop()
      })
    }
    this.#sourceStream = null
    this.#sourceInfo = null
  }

  #isSelectionCancelled(error: unknown): boolean {
    return (
      error instanceof DOMException &&
      (error.name === 'NotAllowedError' || error.name === 'AbortError')
    )
  }

  #describeError(error: unknown, fallback: string): string {
    if (!(error instanceof Error)) return fallback
    if (error instanceof DOMException) {
      if (error.name === 'NotAllowedError') {
        return 'El permiso para compartir la pantalla fue denegado.'
      }
      if (error.name === 'NotFoundError') {
        return 'No se encontró ningún dispositivo de captura disponible.'
      }
      if (error.name === 'NotReadableError') {
        return 'El dispositivo de captura está siendo usado por otra aplicación.'
      }
      if (error.name === 'NotSupportedError') {
        return 'Este navegador no admite la captura solicitada.'
      }
      if (error.name === 'QuotaExceededError') {
        return 'No queda suficiente espacio local para continuar la grabación.'
      }
    }
    if (/quota|storage.*full|no space/i.test(error.message)) {
      return 'No queda suficiente espacio local para continuar la grabación.'
    }
    return error.message || fallback
  }

  #notify(message: string, kind: NoticeKind) {
    this.#deps.onNotice?.(message, kind)
  }

  #emit(patch: Partial<RecorderSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...patch }
    for (const listener of this.#listeners) {
      listener(this.#snapshot)
    }
  }
}

function safeCloseSource(source: { close(): void } | null | undefined) {
  try {
    source?.close()
  } catch {
    // The output may have already released the source during cleanup.
  }
}
