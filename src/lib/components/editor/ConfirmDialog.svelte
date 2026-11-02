<script lang="ts">
  import { onMount } from 'svelte'
  import { X } from '@lucide/svelte'

  interface Props {
    title: string
    message: string
    confirmLabel: string
    danger?: boolean
    onConfirm: () => void
    onCancel: () => void
  }

  let {
    title,
    message,
    confirmLabel,
    danger = false,
    onConfirm,
    onCancel,
  }: Props = $props()

  let dialog = $state<HTMLDialogElement | null>(null)

  onMount(() => {
    if (dialog && !dialog.open) dialog.showModal()
    return () => dialog?.close()
  })

  function handleCancel(event: Event) {
    event.preventDefault()
    onCancel()
  }

  function backdropClick(event: MouseEvent) {
    if (event.target === dialog) onCancel()
  }
</script>

<dialog
  bind:this={dialog}
  class="confirm-dialog"
  aria-labelledby="confirm-title"
  oncancel={handleCancel}
  onclick={backdropClick}
>
  <div class="confirm-shell">
    <header class="confirm-header">
      <h2 id="confirm-title">{title}</h2>
      <button
        type="button"
        class="icon-button"
        aria-label="Cerrar"
        onclick={onCancel}
      >
        <X size={16} strokeWidth={1.9} />
      </button>
    </header>
    <div class="confirm-body">
      <p>{message}</p>
    </div>
    <footer class="confirm-footer">
      <button type="button" class="btn btn-ghost" onclick={onCancel}>
        Cancelar
      </button>
      <button
        type="button"
        class="btn"
        class:btn-primary={!danger}
        class:btn-danger-ghost={danger}
        onclick={onConfirm}
      >
        {confirmLabel}
      </button>
    </footer>
  </div>
</dialog>

<style>
  .confirm-dialog {
    width: min(480px, calc(100vw - 32px));
    max-width: 480px;
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
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 16px 18px 13px;
    border-bottom: 1px solid var(--border-soft);
  }

  h2 {
    color: var(--text);
    font-size: 18px;
    font-weight: 580;
    letter-spacing: -0.035em;
    line-height: 1.25;
  }

  .confirm-body {
    padding: 15px 18px 17px;
  }

  .confirm-body p {
    color: var(--text-secondary);
    font-size: 11.5px;
    line-height: 1.65;
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

  @media (max-width: 480px) {
    .confirm-footer .btn {
      flex: 1;
      justify-content: center;
    }
  }
</style>
