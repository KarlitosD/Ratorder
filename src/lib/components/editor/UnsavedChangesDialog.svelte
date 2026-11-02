<script lang="ts">
  import { onMount } from 'svelte'
  import { AlertTriangle, Save, Trash2, X } from '@lucide/svelte'

  interface Props {
    saving: boolean
    error: string | null
    onSave: () => void
    onDiscard: () => void
    onCancel: () => void
  }

  let { saving, error, onSave, onDiscard, onCancel }: Props = $props()

  let dialog = $state<HTMLDialogElement | null>(null)

  onMount(() => {
    if (dialog && !dialog.open) dialog.showModal()
    return () => dialog?.close()
  })

  function handleCancel(event: Event) {
    event.preventDefault()
    if (!saving) onCancel()
  }

  function backdropClick(event: MouseEvent) {
    if (event.target === dialog && !saving) onCancel()
  }
</script>

<dialog
  bind:this={dialog}
  class="confirm-dialog"
  aria-labelledby="unsaved-title"
  oncancel={handleCancel}
  onclick={backdropClick}
>
  <div class="confirm-shell">
    <header class="confirm-header">
      <div>
        <span class="confirm-kicker">Proyecto de edición</span>
        <h2 id="unsaved-title">Cambios sin guardar</h2>
      </div>
      <button
        type="button"
        class="icon-button"
        aria-label="Cerrar aviso"
        disabled={saving}
        onclick={onCancel}
      >
        <X size={16} strokeWidth={1.9} />
      </button>
    </header>

    <div class="confirm-body">
      <p>
        Puedes guardar la edición en este dispositivo o salir sin guardar. La
        grabación original no cambia en ningún caso.
      </p>
      {#if error}
        <div class="confirm-error" role="alert">
          <AlertTriangle size={14} strokeWidth={1.9} />
          <span>{error}</span>
        </div>
      {/if}
    </div>

    <footer class="confirm-footer">
      <button
        type="button"
        class="btn btn-ghost"
        disabled={saving}
        onclick={onCancel}
      >
        Cancelar
      </button>
      <button
        type="button"
        class="btn btn-danger-ghost"
        disabled={saving}
        onclick={onDiscard}
      >
        <Trash2 size={15} strokeWidth={1.9} />
        Salir sin guardar
      </button>
      <button
        type="button"
        class="btn btn-primary"
        disabled={saving}
        onclick={onSave}
      >
        {#if saving}
          <span class="spinner"></span>
        {:else}
          <Save size={15} strokeWidth={1.9} />
        {/if}
        Guardar y salir
      </button>
    </footer>
  </div>
</dialog>

<style>
  .confirm-dialog {
    width: min(520px, calc(100vw - 32px));
    max-width: 520px;
    padding: 0;
    color: var(--text);
    background: transparent;
    border: 0;
  }

  .confirm-dialog::backdrop {
    background: var(--overlay);
  }

  .confirm-shell {
    overflow: hidden;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-popover);
  }

  .confirm-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 17px 18px 14px;
    border-bottom: 1px solid var(--border-soft);
  }

  .confirm-kicker {
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
    font-size: 19px;
    font-weight: 580;
    letter-spacing: -0.035em;
    line-height: 1.25;
  }

  .confirm-body {
    padding: 16px 18px;
  }

  .confirm-body p {
    color: var(--text-secondary);
    font-size: 11.5px;
    line-height: 1.65;
  }

  .confirm-error {
    display: flex;
    align-items: flex-start;
    gap: 7px;
    margin-top: 12px;
    padding: 9px 10px;
    color: var(--danger);
    background: var(--danger-soft);
    border: 1px solid var(--danger-border);
    border-radius: 8px;
    font-size: 10.5px;
    line-height: 1.5;
  }

  .confirm-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 7px;
    padding: 12px 18px;
    background: var(--surface-raised);
    border-top: 1px solid var(--border-soft);
  }

  .icon-button {
    width: 30px;
    height: 30px;
  }

  @media (max-width: 520px) {
    .confirm-footer {
      flex-wrap: wrap;
    }

    .confirm-footer .btn {
      flex: 1;
      min-width: max-content;
      justify-content: center;
    }
  }
</style>
