<script lang="ts">
  import { createDiagnosticUrl, revokeDiagnosticUrl } from '../diagnostics/resources'
  import { onMount, tick, untrack } from 'svelte'
  import {
    AlertTriangle,
    Calendar,
    Clock3,
    Download,
    Film,
    HardDrive,
    Loader,
    Pencil,
    Play,
    ShieldCheck,
    Trash2,
    Volume2,
    VolumeX,
    X,
  } from '@lucide/svelte'
  import type { RecordingMetadata } from '../types'
  import type { ToastKind } from '../toast'
  import {
    formatBytes,
    formatDate,
    formatDuration,
    formatResolution,
  } from '../utils/format'

  interface Props {
    recording: RecordingMetadata
    thumbnailUrl: string | null
    onClose: () => void
    onGetFile: (recording: RecordingMetadata) => Promise<File>
    onDelete: (recording: RecordingMetadata) => Promise<void>
    onRename: (
      recording: RecordingMetadata,
      title: string,
    ) => Promise<RecordingMetadata>
    onNotify: (message: string, kind: ToastKind) => void
  }

  let {
    recording,
    thumbnailUrl,
    onClose,
    onGetFile,
    onDelete,
    onRename,
    onNotify,
  }: Props = $props()

  let currentRecording = $state<RecordingMetadata>(untrack(() => recording))
  let dialogElement = $state<HTMLDialogElement | null>(null)
  let renameInput = $state<HTMLInputElement | null>(null)
  let videoElement = $state<HTMLVideoElement | null>(null)
  let videoUrl = $state<string | null>(null)
  let loadingFile = $state(true)
  let playbackError = $state<string | null>(null)
  let editingTitle = $state(false)
  let titleDraft = $state(untrack(() => recording.title))
  let savingTitle = $state(false)
  let confirmingDelete = $state(false)
  let deleting = $state(false)
  let exporting = $state(false)
  let exportProgress = $state(0)
  let actionError = $state<string | null>(null)

  let activeObjectUrl: string | null = null
  let previouslyFocused: HTMLElement | null = null
  let disposed = false

  let isPartial = $derived(
    currentRecording.status !== 'completed',
  )
  let formatDescription = $derived.by(() => {
    const videoNames: Record<string, string> = {
      avc: 'H.264',
      hevc: 'HEVC',
      vp9: 'VP9',
      vp8: 'VP8',
      av1: 'AV1',
      prores: 'ProRes',
    }
    const audioNames: Record<string, string> = {
      aac: 'AAC',
      opus: 'Opus',
      mp3: 'MP3',
      vorbis: 'Vorbis',
      flac: 'FLAC',
      'pcm-s16': 'PCM',
    }
    const video = currentRecording.videoCodec
      ? videoNames[currentRecording.videoCodec] ?? currentRecording.videoCodec
      : ''
    const audio = currentRecording.audioCodec
      ? audioNames[currentRecording.audioCodec] ?? currentRecording.audioCodec
      : ''
    return `${currentRecording.container.toUpperCase()}${video ? ` · ${video}` : ''}${audio ? ` + ${audio}` : ''}`
  })
  let audioDescription = $derived(
    !currentRecording.hasAudio
      ? 'Sin audio'
      : currentRecording.hasMicrophone && currentRecording.hasSystemAudio
        ? 'Micrófono + sistema'
        : currentRecording.hasMicrophone
          ? 'Micrófono'
          : 'Audio del sistema',
  )
  let statusCopy = $derived.by(() => {
    if (currentRecording.status === 'interrupted') {
      return {
        title: 'Grabación interrumpida',
        text:
          currentRecording.note ??
          'La sesión no se cerró correctamente. Se conserva el contenido escrito en disco.',
      }
    }
    if (currentRecording.status === 'recovered') {
      return {
        title: 'Grabación recuperada',
        text:
          currentRecording.note ??
          'Se recuperó el contenido válido de una sesión interrumpida.',
      }
    }
    if (currentRecording.status === 'error') {
      return {
        title: 'Grabación con errores',
        text:
          currentRecording.note ??
          'El archivo puede estar incompleto. Intenta exportarlo para conservarlo.',
      }
    }
    return null
  })

  onMount(() => {
    previouslyFocused = document.activeElement as HTMLElement | null
    document.documentElement.classList.add('modal-open')
    const dialog = dialogElement
    if (dialog && !dialog.open) {
      dialog.showModal()
    }

    void loadFile()

    return () => {
      disposed = true
      document.documentElement.classList.remove('modal-open')
      dialogElement?.close()
      videoElement?.pause()
      if (activeObjectUrl) {
        revokeDiagnosticUrl(activeObjectUrl)
        activeObjectUrl = null
      }
      previouslyFocused?.focus?.()
    }
  })

  $effect(() => {
    if (!editingTitle) return
    void tick().then(() => {
      renameInput?.focus()
      renameInput?.select()
    })
  })

  async function loadFile() {
    loadingFile = true
    playbackError = null
    try {
      const file = await onGetFile(recording)
      if (disposed) return
      const url = createDiagnosticUrl(file, 'playbackUrl')
      activeObjectUrl = url
      videoUrl = url
    } catch (error) {
      if (disposed) return
      playbackError =
        error instanceof Error
          ? error.message
          : 'No se pudo abrir el archivo de la grabación.'
    } finally {
      if (!disposed) loadingFile = false
    }
  }

  function close() {
    if (exporting || deleting) return
    onClose()
  }

  function handleCancel(event: Event) {
    event.preventDefault()
    close()
  }

  function handleDialogClick(event: MouseEvent) {
    if (event.target === dialogElement) {
      close()
    }
  }

  function startRename() {
    titleDraft = currentRecording.title
    editingTitle = true
    actionError = null
  }

  function cancelRename() {
    editingTitle = false
    titleDraft = currentRecording.title
  }

  async function saveTitle(event: SubmitEvent) {
    event.preventDefault()
    const nextTitle = titleDraft.trim()
    if (!nextTitle || savingTitle) return
    savingTitle = true
    actionError = null
    try {
      const updated = await onRename(currentRecording, nextTitle.slice(0, 120))
      currentRecording = updated
      titleDraft = updated.title
      editingTitle = false
    } catch (error) {
      actionError =
        error instanceof Error
          ? error.message
          : 'No se pudo cambiar el título.'
    } finally {
      savingTitle = false
    }
  }

  function requestDelete() {
    confirmingDelete = true
    actionError = null
  }

  async function deleteRecording() {
    if (deleting) return
    deleting = true
    actionError = null
    try {
      await onDelete(currentRecording)
      onClose()
    } catch (error) {
      actionError =
        error instanceof Error
          ? error.message
          : 'No se pudo eliminar la grabación.'
      confirmingDelete = false
    } finally {
      deleting = false
    }
  }

  async function exportRecording() {
    if (exporting) return
    exporting = true
    exportProgress = 0
    actionError = null

    try {
      const fileExtension = currentRecording.extension
      const suggestedName = `${safeFilename(currentRecording.title)}.${fileExtension}`
      const picker = (
        window as unknown as {
          showSaveFilePicker?: (options: {
            suggestedName?: string
            types?: Array<{
              description?: string
              accept: Record<string, string[]>
            }>
          }) => Promise<FileSystemFileHandle>
        }
      ).showSaveFilePicker

      if (typeof picker === 'function') {
        const handle = await picker({
          suggestedName,
          types: [
            {
              description:
                currentRecording.container === 'mp4'
                  ? 'Video MP4'
                  : 'Video WebM',
              accept: {
                [currentRecording.container === 'mp4'
                  ? 'video/mp4'
                  : 'video/webm']: [`.${fileExtension}`],
              },
            },
          ],
        })
        const file = await onGetFile(currentRecording)
        const writable = await handle.createWritable()
        try {
          const reader = file.stream().getReader()
          let written = 0
          let lastUpdate = 0
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            await writable.write(value)
            written += value.byteLength
            const now = performance.now()
            if (now - lastUpdate > 120 || written === file.size) {
              exportProgress = file.size > 0 ? written / file.size : 1
              lastUpdate = now
            }
          }
          await writable.close()
          exportProgress = 1
          onNotify('Grabación exportada.', 'success')
        } catch (error) {
          await writable.abort().catch(() => undefined)
          throw error
        }
      } else {
        const file = await onGetFile(currentRecording)
        const url = createDiagnosticUrl(file, 'downloadUrl')
        const link = document.createElement('a')
        link.href = url
        link.download = suggestedName
        document.body.appendChild(link)
        link.click()
        link.remove()
        window.setTimeout(() => revokeDiagnosticUrl(url), 60_000)
        onNotify('Descarga iniciada. El archivo se guardará fuera de OPFS.', 'success')
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return
      }
      actionError =
        error instanceof Error
          ? error.message
          : 'No se pudo exportar la grabación.'
      onNotify(actionError, 'error')
    } finally {
      exporting = false
    }
  }

  function safeFilename(title: string): string {
    const filename = title
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
    return filename || 'Ratorder'
  }
</script>

<dialog
  bind:this={dialogElement}
  class="detail-dialog"
  aria-labelledby="recording-modal-title"
  oncancel={handleCancel}
  onclick={handleDialogClick}
>
  <div class="modal-shell">
    <header class="modal-header">
      <div class="modal-title-block">
        <span class="modal-kicker">
          {formatDescription} · {formatResolution(currentRecording.width, currentRecording.height)}
        </span>
        <h2 id="recording-modal-title">{currentRecording.title}</h2>
      </div>
      <button
        type="button"
        class="icon-button bordered modal-close"
        aria-label="Cerrar grabación"
        disabled={exporting || deleting}
        onclick={close}
      >
        <X size={17} strokeWidth={1.9} />
      </button>
    </header>

    <div class="modal-scroll">
      {#if isPartial && statusCopy}
        <div class="partial-banner" class:error={currentRecording.status === 'error'}>
          <AlertTriangle size={16} strokeWidth={1.9} />
          <div>
            <strong>{statusCopy.title}</strong>
            <p>{statusCopy.text}</p>
          </div>
        </div>
      {/if}

      <div class="player-shell">
        {#if videoUrl && !playbackError}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video
            bind:this={videoElement}
            src={videoUrl}
            poster={thumbnailUrl ?? undefined}
            controls
            preload="metadata"
            playsinline
            aria-label={`Reproductor de ${currentRecording.title}`}
            onerror={() => {
              playbackError =
                'No se pudo reproducir el archivo. Puedes exportarlo o abrirlo en un reproductor externo.'
            }}
          ></video>
        {:else if loadingFile}
          <div class="player-state">
            <span class="spinner"></span>
            <span>Preparando la reproducción…</span>
          </div>
        {:else}
          <div class="player-state error">
            <span class="player-error-icon">
              <AlertTriangle size={20} strokeWidth={1.9} />
            </span>
            <strong>Vista previa no disponible</strong>
            <span>{playbackError ?? 'No se pudo abrir el archivo.'}</span>
          </div>
        {/if}
      </div>

      <div class="detail-content">
        {#if editingTitle}
          <form class="rename-row" onsubmit={saveTitle}>
            <label class="sr-only" for="recording-title">Título de la grabación</label>
            <input
              id="recording-title"
              bind:this={renameInput}
              bind:value={titleDraft}
              maxlength="120"
              disabled={savingTitle}
              onkeydown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelRename()
                }
              }}
            />
            <button type="submit" class="btn btn-primary btn-sm" disabled={savingTitle || !titleDraft.trim()}>
              {#if savingTitle}<span class="spinner"></span>{/if}
              Guardar
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              disabled={savingTitle}
              onclick={cancelRename}
            >
              Cancelar
            </button>
          </form>
        {/if}

        {#if actionError}
          <div class="action-banner error">
            <AlertTriangle size={14} strokeWidth={1.9} />
            <span>{actionError}</span>
            <button
              type="button"
              aria-label="Descartar error"
              onclick={() => (actionError = null)}
            >
              <X size={13} strokeWidth={2} />
            </button>
          </div>
        {/if}

        {#if exporting}
          <div class="export-progress">
            <div class="export-progress-copy">
              <span>
                <Loader size={13} strokeWidth={1.9} class="spin-icon" />
                Exportando archivo…
              </span>
              <span>{Math.round(exportProgress * 100)}%</span>
            </div>
            <div class="export-track">
              <span style:width={`${Math.max(1, exportProgress * 100)}%`}></span>
            </div>
          </div>
        {/if}

        {#if confirmingDelete}
          <div class="delete-confirmation">
            <div>
              <strong>¿Eliminar esta grabación?</strong>
              <span>Se borrará de este dispositivo. No se puede deshacer.</span>
            </div>
            <div class="delete-actions">
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                disabled={deleting}
                onclick={() => (confirmingDelete = false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                class="btn btn-danger btn-sm"
                disabled={deleting}
                onclick={deleteRecording}
              >
                {#if deleting}<span class="spinner"></span>{/if}
                Eliminar
              </button>
            </div>
          </div>
        {/if}

        <dl class="details-grid">
          <div>
            <dt><Calendar size={13} strokeWidth={1.8} /> Grabada</dt>
            <dd>{formatDate(currentRecording.createdAt)}</dd>
          </div>
          <div>
            <dt><Clock3 size={13} strokeWidth={1.8} /> Duración</dt>
            <dd>{formatDuration(currentRecording.durationMs)}</dd>
          </div>
          <div>
            <dt><Film size={13} strokeWidth={1.8} /> Resolución</dt>
            <dd>{formatResolution(currentRecording.width, currentRecording.height)}</dd>
          </div>
          <div>
            <dt><HardDrive size={13} strokeWidth={1.8} /> Tamaño</dt>
            <dd>{formatBytes(currentRecording.size)}</dd>
          </div>
          <div>
            <dt>
              {#if currentRecording.hasAudio}
                <Volume2 size={13} strokeWidth={1.8} />
              {:else}
                <VolumeX size={13} strokeWidth={1.8} />
              {/if}
              Audio
            </dt>
            <dd>{audioDescription}</dd>
          </div>
          <div>
            <dt><Play size={13} strokeWidth={1.8} /> Fotogramas</dt>
            <dd>{currentRecording.fps > 0 ? `${currentRecording.fps} FPS` : '—'}</dd>
          </div>
        </dl>
      </div>
    </div>

    <footer class="modal-footer">
      <span class="local-note">
        <ShieldCheck size={14} strokeWidth={1.8} />
        Guardada localmente
      </span>
      <div class="modal-actions">
        <button
          type="button"
          class="btn btn-ghost action-button"
          disabled={exporting || deleting}
          onclick={startRename}
        >
          <Pencil size={15} strokeWidth={1.9} />
          Renombrar
        </button>
        <button
          type="button"
          class="btn btn-danger-ghost action-button delete-button"
          disabled={exporting || deleting}
          onclick={requestDelete}
        >
          <Trash2 size={15} strokeWidth={1.9} />
          Eliminar
        </button>
        <button
          type="button"
          class="btn btn-primary action-button"
          disabled={exporting || deleting}
          onclick={exportRecording}
        >
          {#if exporting}
            <span class="spinner"></span>
            {Math.round(exportProgress * 100)}%
          {:else}
            <Download size={15} strokeWidth={1.9} />
            Exportar
          {/if}
        </button>
      </div>
    </footer>
  </div>
</dialog>

<style>
  :global(html.modal-open) {
    overflow: hidden;
  }

  .detail-dialog {
    width: min(940px, calc(100vw - 34px));
    max-width: 940px;
    max-height: calc(100dvh - 34px);
    padding: 0;
    color: var(--text);
    background: transparent;
    border: 0;
    border-radius: var(--radius-lg);
    overflow: visible;
  }

  .detail-dialog::backdrop {
    background: var(--overlay);
  }

  .detail-dialog[open] {
    animation: dialog-in 180ms var(--ease) both;
  }

  .detail-dialog[open]::backdrop {
    animation: backdrop-in 180ms var(--ease) both;
  }

  .modal-shell {
    display: flex;
    flex-direction: column;
    max-height: calc(100dvh - 34px);
    overflow: hidden;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-popover);
  }

  .modal-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 20px;
    padding: 18px 20px 16px;
    border-bottom: 1px solid var(--border-soft);
  }

  .modal-title-block {
    min-width: 0;
  }

  .modal-kicker {
    display: block;
    overflow: hidden;
    color: var(--text-tertiary);
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0.055em;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }

  h2 {
    overflow: hidden;
    margin-top: 5px;
    color: var(--text);
    font-size: 18px;
    font-weight: 590;
    letter-spacing: -0.035em;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .modal-close {
    width: 32px;
    height: 32px;
    margin-top: 2px;
    flex: 0 0 auto;
  }

  .modal-scroll {
    overflow-y: auto;
    min-height: 0;
    flex: 1;
    scrollbar-width: thin;
  }

  .partial-banner {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    margin: 14px 18px 0;
    padding: 10px 12px;
    color: var(--warning);
    background: var(--warning-soft);
    border: 1px solid var(--warning-border);
    border-radius: 9px;
  }

  .partial-banner.error {
    color: var(--danger);
    background: var(--danger-soft);
    border-color: var(--danger-border);
  }

  .partial-banner :global(svg) {
    flex: 0 0 auto;
    margin-top: 1px;
  }

  .partial-banner strong {
    display: block;
    font-size: 11px;
    font-weight: 600;
  }

  .partial-banner p {
    margin-top: 2px;
    color: currentColor;
    opacity: 0.75;
    font-size: 10.5px;
    line-height: 1.5;
  }

  .player-shell {
    position: relative;
    width: calc(100% - 36px);
    margin: 14px 18px 0;
    overflow: hidden;
    aspect-ratio: 16 / 9;
    background: #090b0f;
    border: 1px solid var(--border-soft);
    border-radius: 10px;
  }

  .player-shell video {
    width: 100%;
    height: 100%;
    background: #090b0f;
    object-fit: contain;
  }

  .player-shell video::cue {
    font-family: inherit;
  }

  .player-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    width: 100%;
    height: 100%;
    min-height: 220px;
    padding: 24px;
    color: var(--text-tertiary);
    font-size: 11px;
    text-align: center;
  }

  .player-state.error {
    color: var(--text-tertiary);
  }

  .player-state.error strong {
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 570;
  }

  .player-error-icon {
    display: grid;
    width: 42px;
    height: 42px;
    place-items: center;
    color: var(--danger);
    background: var(--danger-soft);
    border: 1px solid var(--danger-border);
    border-radius: 10px;
  }

  .detail-content {
    padding: 16px 20px 18px;
  }

  .rename-row {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 12px;
  }

  .rename-row input {
    width: 100%;
    height: 36px;
    min-width: 0;
    flex: 1;
    padding: 0 11px;
    color: var(--text);
    background: var(--surface-inset);
    border: 1px solid var(--primary-border);
    border-radius: 8px;
    box-shadow: 0 0 0 3px var(--primary-soft);
    outline: none;
    font-size: 12px;
  }

  .action-banner {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 12px;
    padding: 8px 10px;
    color: var(--danger);
    background: var(--danger-soft);
    border: 1px solid var(--danger-border);
    border-radius: 8px;
    font-size: 10.5px;
  }

  .action-banner span {
    flex: 1;
  }

  .action-banner button {
    display: grid;
    width: 20px;
    height: 20px;
    flex: 0 0 auto;
    place-items: center;
    color: currentColor;
    background: transparent;
    border: 0;
    border-radius: 4px;
    cursor: pointer;
  }

  .export-progress {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 14px;
    padding: 10px 12px;
    background: var(--primary-soft);
    border: 1px solid var(--primary-border);
    border-radius: 9px;
  }

  .export-progress-copy {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    color: var(--primary-ink);
    font-size: 10.5px;
    font-weight: 520;
  }

  .export-progress-copy span:first-child {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  :global(.spin-icon) {
    animation: spin 1.2s linear infinite;
  }

  .export-track {
    width: 100%;
    height: 3px;
    overflow: hidden;
    background: var(--primary-border);
    border-radius: 999px;
  }

  .export-track span {
    display: block;
    height: 100%;
    background: var(--primary);
    border-radius: inherit;
    transition: width 120ms linear;
  }

  .delete-confirmation {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 14px;
    padding: 11px 12px;
    background: var(--danger-soft);
    border: 1px solid var(--danger-border);
    border-radius: 9px;
  }

  .delete-confirmation > div:first-child {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .delete-confirmation strong {
    color: var(--danger);
    font-size: 11px;
    font-weight: 600;
  }

  .delete-confirmation span {
    color: var(--text-tertiary);
    font-size: 10px;
  }

  .delete-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 0 0 auto;
  }

  .details-grid {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 16px;
    margin: 2px 0 0;
    padding: 15px 0 2px;
    border-top: 1px solid var(--border-soft);
  }

  .details-grid div {
    min-width: 0;
  }

  dt {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--text-tertiary);
    font-size: 10px;
    font-weight: 550;
    letter-spacing: 0;
    white-space: nowrap;
  }

  dd {
    overflow: hidden;
    margin: 5px 0 0;
    color: var(--text-secondary);
    font-size: 11.5px;
    font-weight: 480;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .modal-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 13px 18px;
    background: var(--surface-raised);
    border-top: 1px solid var(--border-soft);
  }

  .local-note {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text-tertiary);
    font-size: 9.5px;
    white-space: nowrap;
  }

  .modal-actions {
    display: flex;
    align-items: center;
    gap: 5px;
    flex: 0 0 auto;
  }

  .action-button {
    height: 34px;
    padding: 0 11px;
    font-size: 11px;
  }

  .delete-button {
    background: transparent;
    border-color: transparent;
  }

  .delete-button:hover:not(:disabled) {
    color: var(--danger);
    background: var(--danger-soft);
    border-color: var(--danger-border);
  }

  @keyframes dialog-in {
    from {
      opacity: 0;
      transform: translateY(10px) scale(0.985);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  @keyframes backdrop-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (max-width: 760px) {
    .detail-dialog {
      width: calc(100vw - 20px);
      max-height: calc(100dvh - 20px);
    }

    .modal-shell {
      max-height: calc(100dvh - 20px);
    }

    .player-shell {
      width: calc(100% - 24px);
      margin: 10px 12px 0;
    }

    .partial-banner {
      margin: 10px 12px 0;
    }

    .detail-content {
      padding: 13px 14px 15px;
    }

    .details-grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 13px;
    }

    .modal-footer {
      flex-direction: column;
      align-items: stretch;
      gap: 10px;
      padding: 11px 12px;
    }

    .local-note {
      justify-content: center;
    }

    .modal-actions {
      justify-content: flex-end;
    }

    .modal-actions .btn-primary {
      flex: 1;
    }
  }

  @media (max-width: 520px) {
    .modal-header {
      padding: 14px;
    }

    .details-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .modal-actions {
      flex-wrap: wrap;
    }

    .modal-actions .action-button {
      flex: 1;
      min-width: max-content;
    }

    .delete-confirmation {
      flex-direction: column;
      align-items: stretch;
    }

    .delete-actions {
      justify-content: flex-end;
    }

    .rename-row {
      flex-wrap: wrap;
    }

    .rename-row input {
      flex-basis: 100%;
    }
  }
</style>
