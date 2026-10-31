<script lang="ts">
  import {
    AlertTriangle,
    Check,
    Eye,
    EyeOff,
    FolderOpen,
    Mic,
    MicOff,
    Monitor,
    Pause,
    Play,
    RotateCcw,
    ShieldCheck,
    Square,
  } from '@lucide/svelte'
  import type {
    CaptureSourceInfo,
    RecorderPhase,
    RecorderSnapshot,
    RecordingPreferences,
  } from '../types'
  import { formatBytes, formatDuration, formatResolution } from '../utils/format'
  import SettingsPanel from './SettingsPanel.svelte'

  interface Props {
    snapshot: RecorderSnapshot
    preferences: RecordingPreferences
    onSelectSource: () => void
    onStart: () => Promise<void> | void
    onStop: (thumbnail?: Blob) => Promise<void> | void
    onPause: () => void
    onResume: () => void
    onToggleMute: () => void
    onReset: () => void
    onOpenLibrary: () => void
  }

  let {
    snapshot,
    preferences = $bindable(),
    onSelectSource,
    onStart,
    onStop,
    onPause,
    onResume,
    onToggleMute,
    onReset,
    onOpenLibrary,
  }: Props = $props()

  let previewHidden = $state(false)
  let previewVideo = $state<HTMLVideoElement | null>(null)
  let thumbnailCandidate: Blob | null = null
  let previousStream: MediaStream | null = null

  let source = $derived(snapshot.source)
  let phase = $derived(snapshot.phase)
  let previewStream = $derived(snapshot.previewStream)
  let isCapturing = $derived(phase === 'recording' || phase === 'paused')
  let isBusy = $derived(phase === 'preparing' || phase === 'finalizing')
  let showPreviewToggle = $derived(Boolean(source) && !isBusy)
  let dims = $derived(
    snapshot.outputWidth && snapshot.outputHeight
      ? { width: snapshot.outputWidth, height: snapshot.outputHeight }
      : source
        ? { width: source.width, height: source.height }
        : { width: 0, height: 0 },
  )
  let metadataLine = $derived(
    `${formatResolution(dims.width, dims.height)} · ${snapshot.completedRecording?.fps ?? source?.fps ?? preferences.fps} FPS · ${
      snapshot.bytesWritten > 0
        ? formatBytes(snapshot.bytesWritten)
        : 'Preparando archivo'
    }`,
  )

  $effect(() => {
    const video = previewVideo
    const stream = previewStream
    if (!video) return

    if (!stream) {
      if (video.srcObject) video.srcObject = null
      return
    }

    if (video.srcObject !== stream) {
      video.srcObject = stream
      void video.play().catch(() => undefined)
    }
  })

  $effect(() => {
    const stream = snapshot.previewStream
    if (stream && stream !== previousStream) {
      previewHidden = false
      thumbnailCandidate = null
    }
    previousStream = stream
  })

  function statusLabel(currentPhase: RecorderPhase): string {
    switch (currentPhase) {
      case 'preparing':
        return 'Preparando'
      case 'recording':
        return 'Grabando'
      case 'paused':
        return 'En pausa'
      case 'finalizing':
        return 'Guardando'
      case 'completed':
        return 'Completada'
      case 'error':
        return 'Error'
      default:
        return source ? 'Fuente lista' : 'Vista previa'
    }
  }

  async function startRecording() {
    await onStart()
    window.setTimeout(() => {
      void captureThumbnail().then((thumbnail) => {
        if (thumbnail) thumbnailCandidate = thumbnail
      })
    }, 900)
  }

  async function stopRecording() {
    const thumbnail = (await captureThumbnail()) ?? thumbnailCandidate
    await onStop(thumbnail ?? undefined)
    thumbnailCandidate = null
  }

  async function captureThumbnail(): Promise<Blob | null> {
    const video = previewVideo
    if (!video || !video.videoWidth || !video.videoHeight) return null

    const canvas = document.createElement('canvas')
    canvas.width = 720
    canvas.height = 405
    const context = canvas.getContext('2d')
    if (!context) return null

    const sourceRatio = video.videoWidth / video.videoHeight
    const targetRatio = canvas.width / canvas.height
    let sx = 0
    let sy = 0
    let sw = video.videoWidth
    let sh = video.videoHeight

    if (sourceRatio > targetRatio) {
      sw = video.videoHeight * targetRatio
      sx = (video.videoWidth - sw) / 2
    } else {
      sh = video.videoWidth / targetRatio
      sy = (video.videoHeight - sh) / 2
    }

    context.fillStyle = '#090b0f'
    context.fillRect(0, 0, canvas.width, canvas.height)
    try {
      context.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
    } catch {
      return null
    }

    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/webp', 0.82)
    })
  }

  function sourceChanged() {
    onSelectSource()
  }
</script>

<div class="workspace">
  <section class="stage-card" aria-label="Vista previa de grabación">
    <div class="stage-topbar">
      <div class="stage-status">
        <span
          class="status-indicator"
          class:recording={phase === 'recording'}
          class:paused={phase === 'paused'}
          class:busy={isBusy}
          class:success={phase === 'completed'}
          class:error={phase === 'error'}
          class:ready={phase === 'idle' && Boolean(source)}
        ></span>
        <span class="status-text">{statusLabel(phase)}</span>
      </div>

      {#if showPreviewToggle}
        <button
          type="button"
          class="preview-toggle"
          title={previewHidden ? 'Mostrar vista previa' : 'Ocultar vista previa'}
          onclick={() => (previewHidden = !previewHidden)}
        >
          {#if previewHidden}
            <Eye size={14} strokeWidth={1.8} />
            <span>Mostrar</span>
          {:else}
            <EyeOff size={14} strokeWidth={1.8} />
            <span>Ocultar</span>
          {/if}
        </button>
      {/if}
    </div>

    <div
      class="stage-body"
      class:collapsed={previewHidden && Boolean(source) && phase !== 'completed'}
    >
      {#if source}
        <div
          class="preview-shell"
          class:is-recording={phase === 'recording'}
          class:is-paused={phase === 'paused'}
        >
          <video
            bind:this={previewVideo}
            class="preview-video"
            muted
            playsinline
            aria-label="Vista previa de la pantalla compartida"
          ></video>
        </div>
      {:else if phase === 'completed' && snapshot.completedRecording}
        <div class="completed-stage">
          <div class="completed-icon">
            <Check size={23} strokeWidth={1.9} />
          </div>
          <div class="completed-copy">
            <h2>Grabación guardada</h2>
            <p>Ya está a salvo en tu biblioteca local.</p>
            <div class="completed-meta">
              <span>{formatDuration(snapshot.completedRecording.durationMs)}</span>
              <span class="meta-separator"></span>
              <span>{formatBytes(snapshot.completedRecording.size)}</span>
              <span class="meta-separator"></span>
              <span
                >{formatResolution(
                  snapshot.completedRecording.width,
                  snapshot.completedRecording.height,
                )}</span
              >
            </div>
          </div>
        </div>
      {:else if phase === 'error'}
        <div class="error-stage">
          <div class="error-panel">
            <span class="error-icon">
              <AlertTriangle size={21} strokeWidth={1.8} />
            </span>
            <h2>La captura se detuvo</h2>
            <p>
              {snapshot.error ??
                'Ocurrió un problema al preparar la grabación.'}
            </p>
          </div>
        </div>
      {:else}
        <div class="empty-stage">
          <div class="empty-copy">
            <h2>Captura tu pantalla.</h2>
            <p class="empty-subtitle">
              Comparte una pestaña, una ventana o la pantalla completa.
            </p>

            <button
              type="button"
              class="btn btn-primary btn-lg select-button"
              disabled={isBusy}
              onclick={sourceChanged}
            >
              {#if phase === 'preparing'}
                <span class="spinner"></span>
                Preparando…
              {:else}
                <Monitor size={18} strokeWidth={1.8} />
                Seleccionar pantalla
              {/if}
            </button>

            <span class="privacy-note">
              <ShieldCheck size={13} strokeWidth={1.8} />
              Todo se queda en este dispositivo
            </span>
          </div>

          <div class="empty-illustration" aria-hidden="true">
            <svg viewBox="0 0 320 210" fill="none">
              <path
                d="M52 98V66c0-9.9 8.1-18 18-18h28"
                stroke="var(--primary)"
                stroke-width="1.6"
              />
              <path
                d="M268 98V66c0-9.9-8.1-18-18-18h-28"
                stroke="var(--border-strong)"
                stroke-width="1.6"
              />
              <path
                d="M52 112v32c0 9.9 8.1 18 18 18h28"
                stroke="var(--border-strong)"
                stroke-width="1.6"
              />
              <path
                d="M268 112v32c0 9.9-8.1 18-18 18h-28"
                stroke="var(--primary)"
                stroke-width="1.6"
              />
              <rect
                x="153"
                y="99"
                width="14"
                height="14"
                rx="3"
                fill="var(--primary)"
              />
            </svg>
          </div>
        </div>
      {/if}
    </div>

    <footer class="stage-footer" class:idle={!source && !isCapturing && phase !== 'completed' && phase !== 'error'}>
      {#if isCapturing}
        <div class="recording-display">
          <div class="timer-line">
            <span
              class="recording-dot"
              class:paused={phase === 'paused'}
            ></span>
            <span class="timer mono-digits"
              >{formatDuration(snapshot.elapsedMs)}</span
            >
          </div>
          <span class="recording-meta">{metadataLine}</span>
        </div>

        <div class="recording-actions">
          <button
            type="button"
            class="control-button"
            title={phase === 'paused' ? 'Reanudar grabación' : 'Pausar grabación'}
            aria-label={phase === 'paused' ? 'Reanudar grabación' : 'Pausar grabación'}
            onclick={phase === 'paused' ? onResume : onPause}
          >
            {#if phase === 'paused'}
              <Play size={17} strokeWidth={1.9} fill="currentColor" />
            {:else}
              <Pause size={17} strokeWidth={1.9} fill="currentColor" />
            {/if}
          </button>

          <button
            type="button"
            class="control-button"
            class:muted={snapshot.microphoneMuted}
            title={snapshot.microphoneMuted ? 'Activar micrófono' : 'Silenciar micrófono'}
            aria-label={snapshot.microphoneMuted ? 'Activar micrófono' : 'Silenciar micrófono'}
            aria-pressed={snapshot.microphoneMuted}
            disabled={!snapshot.microphoneActive}
            onclick={onToggleMute}
          >
            {#if snapshot.microphoneMuted}
              <MicOff size={17} strokeWidth={1.9} />
            {:else}
              <Mic size={17} strokeWidth={1.9} />
            {/if}
          </button>

          <button
            type="button"
            class="btn stop-button"
            onclick={stopRecording}
          >
            <Square size={13} strokeWidth={2} fill="currentColor" />
            Detener
          </button>
        </div>
      {:else if phase === 'finalizing'}
        <div class="recording-display">
          <div class="timer-line">
            <span class="spinner"></span>
            <span class="timer mono-digits"
              >{formatDuration(snapshot.elapsedMs)}</span
            >
          </div>
          <span class="recording-meta">Finalizando y escribiendo en disco…</span>
        </div>
        <button type="button" class="btn stop-button" disabled>
          <span class="spinner"></span>
          Guardando
        </button>
      {:else if phase === 'preparing'}
        <div class="ready-display">
          <span class="spinner"></span>
          <div class="ready-copy">
            <strong>Preparando la captura…</strong>
            <span>
              {source
                ? 'Configurando la fuente y el codificador'
                : 'Esperando a que elijas qué compartir'}
            </span>
          </div>
        </div>
        <span class="preparing-note">Un momento</span>
      {:else if phase === 'completed'}
        <div class="footer-actions actions-right">
          <button type="button" class="btn btn-primary" onclick={onOpenLibrary}>
            <FolderOpen size={16} strokeWidth={1.9} />
            Abrir biblioteca
          </button>
          <button type="button" class="btn btn-secondary" onclick={onReset}>
            Nueva grabación
          </button>
        </div>
      {:else if phase === 'error'}
        <div class="footer-actions actions-right">
          <button type="button" class="btn btn-secondary" onclick={sourceChanged}>
            {source ? 'Cambiar fuente' : 'Elegir fuente'}
          </button>
          {#if source}
            <button
              type="button"
              class="btn btn-primary"
              onclick={startRecording}
            >
              <RotateCcw size={15} strokeWidth={1.9} />
              Reintentar
            </button>
          {/if}
        </div>
      {:else if source}
        <div class="ready-display">
          <div class="ready-copy">
            <strong>{source.label}</strong>
            <span
              >{formatResolution(
                dims.width,
                dims.height,
              )} · {source.fps} FPS · {preferences.container === 'mp4'
                ? 'MP4'
                : 'WebM'}</span
            >
          </div>
        </div>
        <div class="footer-actions">
          <button
            type="button"
            class="btn btn-primary start-button"
            onclick={startRecording}
          >
            <span class="record-circle"></span>
            Iniciar grabación
          </button>
        </div>
      {/if}
    </footer>
  </section>

  <SettingsPanel
    bind:preferences
    source={snapshot.source}
    phase={snapshot.phase}
    onSelectSource={sourceChanged}
  />
</div>

<style>
  .workspace {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 348px;
    align-items: stretch;
    overflow: hidden;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }

  .stage-card {
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
    background: transparent;
    border: 0;
    border-radius: 0;
    overflow: hidden;
  }

  .stage-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 54px;
    padding: 0 20px;
  }

  .stage-status {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .status-indicator {
    width: 6px;
    height: 6px;
    flex: 0 0 auto;
    background: var(--text-tertiary);
    border-radius: 50%;
  }

  .status-indicator.ready {
    background: var(--success);
  }

  .status-indicator.recording {
    background: var(--danger);
    animation: pulse-recording 1.8s ease-in-out infinite;
  }

  .status-indicator.paused {
    background: var(--warning);
  }

  .status-indicator.busy {
    background: var(--primary);
    animation: pulse-recording 1.2s ease-in-out infinite;
  }

  .status-indicator.success {
    background: var(--success);
  }

  .status-indicator.error {
    background: var(--danger);
  }

  .status-text {
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 550;
  }

  .preview-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 4px;
    flex: 0 0 auto;
    color: var(--text-tertiary);
    background: transparent;
    border: 0;
    border-radius: 6px;
    font-size: 11.5px;
    cursor: pointer;
    transition: color var(--fast);
  }

  .preview-toggle:hover {
    color: var(--text);
  }

  .stage-body {
    display: flex;
    flex: 1;
    flex-direction: column;
    padding: 0 16px 18px;
  }

  .stage-body.collapsed {
    display: none;
  }

  .preview-shell {
    position: relative;
    overflow: hidden;
    width: 100%;
    aspect-ratio: 16 / 9;
    background: var(--canvas);
    border: 1px solid var(--border-soft);
    border-radius: 11px;
    transition: border-color 180ms var(--ease);
  }

  .preview-shell.is-recording {
    border-color: var(--danger-border);
  }

  .preview-shell.is-paused {
    border-color: var(--warning-border);
  }

  .preview-video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: var(--canvas);
  }

  .empty-stage {
    display: grid;
    grid-template-columns: minmax(0, 1.05fr) minmax(220px, 0.95fr);
    align-items: center;
    gap: clamp(28px, 5vw, 64px);
    min-height: clamp(390px, 42vw, 560px);
    flex: 1;
    padding: 48px clamp(30px, 4.6vw, 68px);
    background: var(--surface-inset);
    border: 1px solid var(--border-soft);
    border-radius: 11px;
    text-align: left;
  }

  .empty-copy {
    min-width: 0;
    max-width: 390px;
  }

  .empty-copy h2 {
    color: var(--text);
    font-size: clamp(28px, 3.1vw, 39px);
    font-weight: 560;
    line-height: 1.04;
    letter-spacing: -0.045em;
  }

  .empty-subtitle {
    max-width: 35ch;
    margin-top: 12px;
    color: var(--text-secondary);
    font-size: 13px;
    line-height: 1.65;
  }

  .select-button {
    margin-top: 26px;
  }

  .privacy-note {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 16px;
    color: var(--text-tertiary);
    font-size: 11px;
  }

  .empty-illustration {
    width: 100%;
    max-width: 312px;
    justify-self: end;
  }

  .empty-illustration svg {
    width: 100%;
    height: auto;
    overflow: visible;
  }

  .completed-stage,
  .error-stage {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: clamp(300px, 34vw, 430px);
    flex: 1;
    padding: 40px 28px;
    background: var(--surface-inset);
    border: 1px solid var(--border-soft);
    border-radius: 11px;
    text-align: center;
  }

  .completed-stage {
    flex-direction: column;
  }

  .completed-icon {
    display: grid;
    width: 46px;
    height: 46px;
    place-items: center;
    color: var(--success);
    border: 1px solid var(--success-border);
    border-radius: 50%;
  }

  .completed-copy h2,
  .error-panel h2 {
    margin-top: 16px;
    color: var(--text);
    font-size: 23px;
    font-weight: 580;
    letter-spacing: -0.04em;
  }

  .completed-copy p,
  .error-panel p {
    max-width: 460px;
    margin-top: 7px;
    color: var(--text-secondary);
    font-size: 12.5px;
    line-height: 1.6;
  }

  .completed-meta {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    margin-top: 15px;
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
  }

  .meta-separator {
    width: 3px;
    height: 3px;
    background: var(--border-strong);
    border-radius: 50%;
  }

  .error-panel {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .error-icon {
    display: grid;
    width: 46px;
    height: 46px;
    place-items: center;
    color: var(--danger);
    border: 1px solid var(--danger-border);
    border-radius: 50%;
  }

  .stage-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    min-height: 82px;
    margin-top: auto;
    padding: 16px 20px;
    border-top: 1px solid var(--border-soft);
  }

  .stage-footer.idle {
    display: none;
  }

  .recording-display {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
  }

  .timer-line {
    display: flex;
    align-items: center;
    gap: 9px;
  }

  .recording-dot {
    width: 7px;
    height: 7px;
    background: var(--danger);
    border-radius: 50%;
    animation: pulse-recording 1.8s ease-in-out infinite;
  }

  .recording-dot.paused {
    background: var(--warning);
    animation: none;
  }

  .timer {
    color: var(--text);
    font-family: var(--font-mono);
    font-size: clamp(29px, 3.1vw, 36px);
    font-weight: 450;
    line-height: 1;
    letter-spacing: -0.055em;
    font-variant-numeric: tabular-nums;
    font-feature-settings: 'tnum' 1;
  }

  .recording-meta {
    overflow: hidden;
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .recording-actions {
    display: flex;
    align-items: center;
    gap: 7px;
    flex: 0 0 auto;
  }

  .control-button {
    display: grid;
    width: 40px;
    height: 40px;
    place-items: center;
    color: var(--text-secondary);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 9px;
    cursor: pointer;
    transition:
      color var(--fast),
      background-color var(--fast),
      border-color var(--fast);
  }

  .control-button:hover:not(:disabled) {
    color: var(--text);
    background: var(--surface-hover);
    border-color: var(--border-strong);
  }

  .control-button:disabled {
    cursor: not-allowed;
    opacity: 0.35;
  }

  .control-button.muted {
    color: var(--warning);
    border-color: var(--warning-border);
  }

  .stop-button {
    height: 40px;
    padding: 0 15px;
    color: var(--danger);
    background: var(--danger-soft);
    border-color: var(--danger-border);
  }

  .stop-button:hover:not(:disabled) {
    color: #170a0c;
    background: var(--danger);
    border-color: var(--danger);
  }

  .ready-display {
    display: flex;
    align-items: center;
    gap: 11px;
    min-width: 0;
  }

  .ready-display > .spinner {
    flex: 0 0 auto;
    color: var(--primary);
  }

  .ready-copy {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .ready-copy strong {
    overflow: hidden;
    color: var(--text);
    font-size: 12.5px;
    font-weight: 550;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ready-copy span {
    overflow: hidden;
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .footer-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
  }

  .actions-right {
    margin-left: auto;
  }

  .start-button {
    padding-left: 16px;
  }

  .record-circle {
    width: 7px;
    height: 7px;
    background: currentColor;
    border-radius: 50%;
  }

  .preparing-note {
    color: var(--text-tertiary);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  @media (max-width: 1140px) {
    .workspace {
      grid-template-columns: minmax(0, 1fr) 330px;
    }
  }

  @media (max-width: 1040px) {
    .workspace {
      grid-template-columns: 1fr;
    }

    .stage-body {
      padding: 0 16px 18px;
    }

    .empty-stage {
      min-height: 400px;
    }
  }

  @media (max-width: 760px) {
    .stage-topbar {
      min-height: 50px;
      padding: 0 15px;
    }

    .stage-body {
      padding: 0 10px 12px;
    }

    .stage-footer {
      flex-direction: column;
      align-items: stretch;
      gap: 14px;
      padding: 14px 15px;
    }

    .recording-actions,
    .footer-actions {
      justify-content: flex-end;
    }

    .recording-actions .stop-button {
      flex: 1;
    }

    .footer-actions .start-button {
      flex: 1;
    }

    .empty-stage {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 26px;
      min-height: 0;
      padding: 34px 24px 36px;
    }

    .empty-illustration {
      order: -1;
      width: 168px;
      max-width: none;
      justify-self: auto;
    }

    .empty-copy h2 {
      font-size: 29px;
    }

    .empty-subtitle {
      max-width: 38ch;
    }

    .completed-stage,
    .error-stage {
      min-height: 350px;
      padding: 32px 20px;
    }

    .completed-copy h2,
    .error-panel h2 {
      font-size: 21px;
    }
  }

  @media (max-width: 420px) {
    .empty-illustration {
      width: 142px;
    }

    .empty-copy h2 {
      font-size: 27px;
    }

    .privacy-note {
      align-items: flex-start;
    }

    .preview-toggle span {
      display: none;
    }
  }
</style>
