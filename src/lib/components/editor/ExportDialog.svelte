<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import {
    AlertTriangle,
    Check,
    Download,
    Film,
    Loader,
    ShieldCheck,
    X,
  } from '@lucide/svelte'
  import type { EditorController } from '../../editor/controller'
  import { editedTitle } from '../../editor/export'
  import type { EditorSnapshot } from '../../editor/types'
  import { formatBytes, formatDuration } from '../../utils/format'

  interface Props {
    snapshot: EditorSnapshot
    controller: EditorController
    onClose: () => void
    onOpenLibrary: () => void
  }

  let { snapshot, controller, onClose, onOpenLibrary }: Props = $props()

  let dialog = $state<HTMLDialogElement | null>(null)
  let titleDraft = $state(
    untrack(() => editedTitle(snapshot.project?.title ?? 'Grabación')),
  )

  let phase = $derived(snapshot.exportState.phase)
  let busy = $derived(
    ['preparing', 'exporting', 'finalizing'].includes(phase),
  )
  let success = $derived(phase === 'done')
  let failed = $derived(phase === 'error')
  let canceled = $derived(phase === 'canceled')
  let progress = $derived(
    Math.round(Math.min(1, Math.max(0, snapshot.exportState.progress)) * 100),
  )
  let project = $derived(snapshot.project)

  onMount(() => {
    if (dialog && !dialog.open) dialog.showModal()
    return () => dialog?.close()
  })

  function requestClose() {
    if (busy) return
    onClose()
  }

  function handleCancel(event: Event) {
    event.preventDefault()
    requestClose()
  }

  function backdropClick(event: MouseEvent) {
    if (event.target === dialog && !busy) onClose()
  }

  async function startExport() {
    await controller.exportNow(titleDraft)
  }
</script>

<dialog
  bind:this={dialog}
  class="export-dialog"
  aria-labelledby="export-dialog-title"
  oncancel={handleCancel}
  onclick={backdropClick}
>
  <div class="export-shell">
    <header class="export-header">
      <div>
        <span class="export-kicker">Exportar edición</span>
        <h2 id="export-dialog-title">
          {success ? 'Copia guardada' : busy ? 'Creando la copia' : 'Guardar una copia editada'}
        </h2>
      </div>
      <button
        type="button"
        class="icon-button"
        aria-label="Cerrar exportación"
        disabled={busy}
        onclick={requestClose}
      >
        <X size={16} strokeWidth={1.9} />
      </button>
    </header>

    <div class="export-body">
      {#if success && snapshot.exportState.result}
        <div class="success-panel">
          <span class="success-icon">
            <Check size={22} strokeWidth={2} />
          </span>
          <div>
            <strong>{snapshot.exportState.result.title}</strong>
            <p>
              {formatDuration(snapshot.exportState.result.durationMs)} ·
              {formatBytes(snapshot.exportState.result.size)} ·
              {snapshot.exportState.result.container.toUpperCase()}
            </p>
            <p class="success-note">
              Está en la biblioteca local. La grabación original no cambió.
            </p>
            {#if snapshot.dirty}
              <p class="success-note warning">
                El proyecto de edición todavía tiene cambios sin guardar.
              </p>
            {/if}
          </div>
        </div>
      {:else if busy}
        <div class="progress-panel" role="status" aria-live="polite">
          <div class="progress-copy">
            <span class="progress-stage">
              <Loader size={14} strokeWidth={2} class="spin" />
              {snapshot.exportState.message || 'Exportando…'}
            </span>
            <span class="progress-percent">{progress}%</span>
          </div>
          <div class="progress-track">
            <span style:width={`${Math.max(2, progress)}%`}></span>
          </div>
          <p class="progress-note">
            Se está volviendo a codificar todo el video con los cambios de la
            línea de tiempo.
          </p>
          {#if phase !== 'finalizing'}
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              onclick={() => controller.cancelExport()}
            >
              Cancelar exportación
            </button>
          {/if}
        </div>
      {:else}
        <label class="field">
          <span>Título de la copia</span>
          <input
            type="text"
            maxlength="120"
            bind:value={titleDraft}
            disabled={busy}
          />
        </label>

        {#if project}
          <dl class="summary">
            <div>
              <dt><Film size={13} strokeWidth={1.8} /> Duración</dt>
              <dd>{formatDuration(snapshot.duration * 1000)}</dd>
            </div>
            <div>
              <dt>Resolución</dt>
              <dd>{project.width} × {project.height}</dd>
            </div>
            <div>
              <dt>Fotogramas</dt>
              <dd>{project.fps} FPS</dd>
            </div>
            <div>
              <dt>Formato</dt>
              <dd>{project.container.toUpperCase()}</dd>
            </div>
          </dl>
        {/if}

        {#if failed}
          <div class="export-error" role="alert">
            <AlertTriangle size={15} strokeWidth={1.9} />
            <div>
              <strong>No se pudo exportar</strong>
              <p>{snapshot.exportState.error}</p>
            </div>
          </div>
        {:else if canceled}
          <div class="export-canceled">
            <span>La exportación se canceló. No se guardó ninguna copia.</span>
          </div>
        {/if}

        <div class="export-notes">
          <span>
            <ShieldCheck size={13} strokeWidth={1.8} />
            El original se conserva intacto.
          </span>
          <p>
            La edición se guarda como una grabación nueva en este dispositivo.
            La exportación vuelve a codificar el video completo.
          </p>
        </div>
      {/if}
    </div>

    <footer class="export-footer">
      {#if success}
        <button type="button" class="btn btn-secondary" onclick={requestClose}>
          Seguir editando
        </button>
        <button type="button" class="btn btn-primary" onclick={onOpenLibrary}>
          Abrir biblioteca
        </button>
      {:else if busy}
        <span class="busy-note">No cierres esta pestaña durante la exportación.</span>
      {:else}
        <button type="button" class="btn btn-ghost" onclick={requestClose}>
          Cancelar
        </button>
        <button
          type="button"
          class="btn btn-primary"
          disabled={!project || snapshot.duration <= 0}
          onclick={startExport}
        >
          <Download size={15} strokeWidth={1.9} />
          {failed || canceled ? 'Reintentar exportación' : 'Exportar copia'}
        </button>
      {/if}
    </footer>
  </div>
</dialog>

<style>
  .export-dialog {
    width: min(560px, calc(100vw - 32px));
    max-width: 560px;
    padding: 0;
    color: var(--text);
    background: transparent;
    border: 0;
  }

  .export-dialog::backdrop {
    background: var(--overlay);
  }

  .export-shell {
    overflow: hidden;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-popover);
  }

  .export-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 17px 18px 14px;
    border-bottom: 1px solid var(--border-soft);
  }

  .export-kicker {
    display: block;
    color: var(--text-tertiary);
    font-size: 8.5px;
    font-weight: 650;
    letter-spacing: 0.075em;
    text-transform: uppercase;
  }

  h2 {
    margin-top: 5px;
    color: var(--text);
    font-size: 18px;
    font-weight: 580;
    letter-spacing: -0.035em;
    line-height: 1.25;
  }

  .export-body {
    padding: 16px 18px 18px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 14px;
  }

  .field span {
    color: var(--text-tertiary);
    font-size: 9.5px;
    font-weight: 550;
  }

  .field input {
    width: 100%;
    height: 34px;
    padding: 0 10px;
    color: var(--text);
    background: var(--surface-inset);
    border: 1px solid var(--border);
    border-radius: 7px;
    outline: none;
    font-size: 12px;
  }

  .field input:focus {
    border-color: var(--primary-border);
    box-shadow: 0 0 0 3px var(--primary-soft);
  }

  .summary {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px 16px;
    margin: 0;
    padding: 12px 13px;
    background: var(--surface-inset);
    border: 1px solid var(--border-soft);
    border-radius: 8px;
  }

  .summary div {
    min-width: 0;
  }

  .summary dt {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--text-tertiary);
    font-size: 9px;
  }

  .summary dd {
    margin: 3px 0 0;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }

  .export-notes {
    margin-top: 14px;
    padding-top: 13px;
    border-top: 1px solid var(--border-soft);
    color: var(--text-tertiary);
    font-size: 10px;
    line-height: 1.55;
  }

  .export-notes > span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--success);
    font-weight: 550;
  }

  .export-notes p {
    margin-top: 6px;
  }

  .progress-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .progress-copy {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    color: var(--text-secondary);
    font-size: 11px;
  }

  .progress-stage {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }

  .progress-stage :global(.spin) {
    flex: 0 0 auto;
    color: var(--primary);
  }

  .progress-percent {
    color: var(--text);
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }

  .progress-track {
    width: 100%;
    height: 4px;
    overflow: hidden;
    background: var(--surface-active);
    border-radius: 999px;
  }

  .progress-track span {
    display: block;
    height: 100%;
    background: var(--primary);
    border-radius: inherit;
    transition: width 140ms linear;
  }

  .progress-note {
    color: var(--text-tertiary);
    font-size: 10px;
    line-height: 1.5;
  }

  .progress-panel .btn {
    align-self: flex-start;
    margin-top: 2px;
  }

  .success-panel {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .success-icon {
    display: grid;
    width: 40px;
    height: 40px;
    flex: 0 0 auto;
    place-items: center;
    color: var(--success);
    background: var(--success-soft);
    border: 1px solid var(--success-border);
    border-radius: 50%;
  }

  .success-panel strong {
    display: block;
    color: var(--text);
    font-size: 13px;
    font-weight: 580;
  }

  .success-panel p {
    margin-top: 4px;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }

  .success-panel .success-note {
    color: var(--text-tertiary);
    font-family: inherit;
    font-size: 10px;
    line-height: 1.5;
  }

  .success-panel .success-note.warning {
    color: var(--warning);
  }

  .export-error {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-top: 13px;
    padding: 9px 10px;
    color: var(--danger);
    background: var(--danger-soft);
    border: 1px solid var(--danger-border);
    border-radius: 8px;
  }

  .export-error strong {
    display: block;
    font-size: 10.5px;
    font-weight: 600;
  }

  .export-error p {
    margin-top: 2px;
    color: var(--text-secondary);
    font-size: 10px;
    line-height: 1.45;
  }

  .export-canceled {
    margin-top: 13px;
    padding: 8px 10px;
    color: var(--text-tertiary);
    background: var(--surface-inset);
    border: 1px solid var(--border-soft);
    border-radius: 7px;
    font-size: 10px;
  }

  .export-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 7px;
    padding: 12px 18px;
    background: var(--surface-raised);
    border-top: 1px solid var(--border-soft);
  }

  .busy-note {
    margin-right: auto;
    color: var(--text-tertiary);
    font-size: 9.5px;
  }

  .icon-button {
    width: 30px;
    height: 30px;
  }

  :global(.spin) {
    animation: spin 1.1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (max-width: 480px) {
    .export-header,
    .export-body {
      padding-left: 14px;
      padding-right: 14px;
    }

    .export-footer {
      padding: 10px 14px;
    }

    .export-footer .btn {
      flex: 1;
      justify-content: center;
    }

    .busy-note {
      display: none;
    }
  }
</style>
