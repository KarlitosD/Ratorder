<script lang="ts">
  import { AlertTriangle, Check, Info, X } from '@lucide/svelte'
  import { fly } from 'svelte/transition'
  import type { ToastMessage } from '../toast'

  interface Props {
    toast: ToastMessage
    onClose: () => void
    onAction?: () => void
  }

  let { toast, onClose, onAction }: Props = $props()

  let ToastIcon = $derived(
    toast.kind === 'success'
      ? Check
      : toast.kind === 'error' || toast.kind === 'warning'
        ? AlertTriangle
        : Info,
  )
</script>

<div
  class="toast"
  class:error={toast.kind === 'error'}
  class:warning={toast.kind === 'warning'}
  class:success={toast.kind === 'success'}
  role={toast.kind === 'error' ? 'alert' : 'status'}
  transition:fly={{ y: 10, duration: 180 }}
>
  <span class="toast-icon">
    <ToastIcon size={17} strokeWidth={1.9} />
  </span>
  <p>{toast.message}</p>
  {#if toast.actionLabel && onAction}
    <button
      type="button"
      class="toast-action"
      onclick={() => {
        onAction?.()
        onClose()
      }}
    >
      {toast.actionLabel}
    </button>
  {/if}
  <button
    type="button"
    class="toast-close"
    aria-label="Cerrar aviso"
    onclick={onClose}
  >
    <X size={14} strokeWidth={2} />
  </button>
</div>

<style>
  .toast {
    position: fixed;
    right: max(20px, calc((100vw - 1460px) / 2 + 20px));
    bottom: 22px;
    z-index: 100;
    display: flex;
    align-items: center;
    gap: 10px;
    width: min(430px, calc(100vw - 32px));
    min-height: 52px;
    padding: 10px 10px 10px 14px;
    color: var(--text);
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 11px;
    box-shadow: var(--shadow-popover);
  }

  .toast-icon {
    display: grid;
    width: 24px;
    height: 24px;
    flex: 0 0 auto;
    place-items: center;
    color: var(--primary);
  }

  .toast.success .toast-icon {
    color: var(--success);
  }

  .toast.warning .toast-icon {
    color: var(--warning);
  }

  .toast.error .toast-icon {
    color: var(--danger);
  }

  p {
    min-width: 0;
    flex: 1;
    color: var(--text-secondary);
    font-size: 12.5px;
    line-height: 1.45;
  }

  .toast-action {
    height: 28px;
    padding: 0 10px;
    flex: 0 0 auto;
    color: var(--primary-ink);
    background: var(--primary-soft);
    border: 1px solid var(--primary-border);
    border-radius: 7px;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
  }

  .toast-action:hover {
    color: var(--primary-contrast);
    background: var(--primary);
  }

  .toast-close {
    display: grid;
    width: 28px;
    height: 28px;
    flex: 0 0 auto;
    place-items: center;
    color: var(--text-tertiary);
    background: transparent;
    border: 0;
    border-radius: 7px;
    cursor: pointer;
  }

  .toast-close:hover {
    color: var(--text);
    background: var(--surface-hover);
  }

  @media (max-width: 620px) {
    .toast {
      right: 16px;
      bottom: 16px;
    }
  }
</style>
