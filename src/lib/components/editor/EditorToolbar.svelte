<script lang="ts">
  import { onMount } from 'svelte'
  import {
    ArrowLeft,
    Check,
    Keyboard,
    Loader,
    MoreHorizontal,
    RefreshCcw,
    Save,
    Undo2,
  } from '@lucide/svelte'
  import type { EditorController } from '../../editor/controller'
  import type { EditorSnapshot } from '../../editor/types'

  interface Props {
    snapshot: EditorSnapshot
    controller: EditorController
    onBack: () => void
    onShowShortcuts: () => void
    onDiscardChanges: () => void
    onResetOriginal: () => void
  }

  let {
    snapshot,
    controller,
    onBack,
    onShowShortcuts,
    onDiscardChanges,
    onResetOriginal,
  }: Props = $props()

  let menuOpen = $state(false)
  let menuWrap = $state<HTMLDivElement | null>(null)

  let project = $derived(snapshot.project)
  let exportBusy = $derived(
    ['preparing', 'exporting', 'finalizing'].includes(
      snapshot.exportState.phase,
    ),
  )
  let canEdit = $derived(Boolean(project) && !exportBusy)
  let statusText = $derived(
    snapshot.saving
      ? 'Guardando…'
      : snapshot.dirty
        ? 'Cambios sin guardar'
        : snapshot.savedAt !== null
          ? 'Guardado'
          : 'Sin cambios',
  )

  onMount(() => {
    const closeMenu = (event: PointerEvent) => {
      if (!menuOpen || !menuWrap) return
      if (menuWrap.contains(event.target as Node)) return
      menuOpen = false
    }
    document.addEventListener('pointerdown', closeMenu)
    return () => document.removeEventListener('pointerdown', closeMenu)
  })

  function run(action: () => void) {
    menuOpen = false
    action()
  }
</script>

<header class="editor-header">
  <div class="header-left">
    <button
      type="button"
      class="icon-button back-button"
      aria-label="Volver a la biblioteca"
      disabled={exportBusy}
      onclick={onBack}
    >
      <ArrowLeft size={17} strokeWidth={1.9} />
    </button>
    <div class="title-block">
      <span class="editor-kicker">Editor de video</span>
      <h1>{project?.title ?? 'Editar grabación'}</h1>
    </div>
  </div>

  <div class="header-right">
    <span
      class="save-state"
      class:dirty={snapshot.dirty && !snapshot.saving}
      class:saving={snapshot.saving}
      title={statusText}
      aria-label={statusText}
      aria-live="polite"
    >
      {#if snapshot.saving}
        <Loader size={12} strokeWidth={2} class="spin" />
      {:else if snapshot.dirty}
        <span class="dirty-dot"></span>
      {:else}
        <Check size={12} strokeWidth={2.2} />
      {/if}
      <span class="save-label">{statusText}</span>
    </span>

    <button
      type="button"
      class="btn btn-sm save-button"
      class:btn-primary={snapshot.dirty}
      class:btn-secondary={!snapshot.dirty}
      aria-label="Guardar proyecto"
      disabled={!snapshot.dirty || snapshot.saving || !canEdit}
      onclick={() => void controller.saveNow()}
    >
      {#if snapshot.saving}
        <span class="spinner"></span>
      {:else}
        <Save size={14} strokeWidth={1.9} />
      {/if}
      <span class="save-label">Guardar</span>
    </button>

    <div class="menu-wrap" bind:this={menuWrap}>
      <button
        type="button"
        class="icon-button"
        aria-label="Más opciones"
        aria-expanded={menuOpen}
        disabled={!canEdit}
        onclick={() => (menuOpen = !menuOpen)}
      >
        <MoreHorizontal size={17} strokeWidth={1.9} />
      </button>
      {#if menuOpen}
        <div class="options-menu" role="menu" aria-label="Opciones del editor">
          <button
            type="button"
            role="menuitem"
            disabled={!snapshot.dirty || snapshot.saving}
            onclick={() => run(() => void controller.saveNow())}
          >
            <Save size={14} strokeWidth={1.9} />
            Guardar
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!snapshot.dirty || snapshot.saving}
            onclick={() => run(onDiscardChanges)}
          >
            <Undo2 size={14} strokeWidth={1.9} />
            Descartar cambios
          </button>
          <button
            type="button"
            role="menuitem"
            class="danger-item"
            disabled={snapshot.saving}
            onclick={() => run(onResetOriginal)}
          >
            <RefreshCcw size={14} strokeWidth={1.9} />
            Restablecer original
          </button>
          <span class="menu-separator"></span>
          <button
            type="button"
            role="menuitem"
            onclick={() => run(onShowShortcuts)}
          >
            <Keyboard size={14} strokeWidth={1.9} />
            Atajos de teclado
          </button>
        </div>
      {/if}
    </div>
  </div>
</header>

<style>
  .editor-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    min-height: 60px;
    padding: 9px 16px;
    background: var(--surface);
    border-bottom: 1px solid var(--border-soft);
  }

  .header-left,
  .header-right {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .header-left {
    flex: 1;
  }

  .header-right {
    flex: 0 0 auto;
  }

  .title-block {
    min-width: 0;
    margin-left: 2px;
  }

  .editor-kicker {
    display: block;
    color: var(--text-tertiary);
    font-size: 9px;
    font-weight: 650;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h1 {
    overflow: hidden;
    margin-top: 2px;
    color: var(--text);
    font-size: 14px;
    font-weight: 580;
    letter-spacing: -0.025em;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .save-state {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0 2px;
    color: var(--text-tertiary);
    font-size: 10px;
    font-weight: 550;
    white-space: nowrap;
  }

  .save-state.dirty {
    color: var(--warning);
  }

  .save-state.saving {
    color: var(--text-tertiary);
  }

  .dirty-dot {
    width: 6px;
    height: 6px;
    background: var(--warning);
    border-radius: 50%;
  }

  .save-button {
    min-width: 96px;
  }

  :global(.spin) {
    animation: spin 1.1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .menu-wrap {
    position: relative;
  }

  .options-menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 40;
    display: flex;
    min-width: 212px;
    flex-direction: column;
    padding: 4px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 9px;
    box-shadow: var(--shadow-popover);
  }

  .options-menu button {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 9px;
    color: var(--text-secondary);
    text-align: left;
    background: transparent;
    border: 0;
    border-radius: 6px;
    font-size: 11.5px;
    cursor: pointer;
  }

  .options-menu button:hover:not(:disabled) {
    color: var(--text);
    background: var(--surface-hover);
  }

  .options-menu button:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  .options-menu .danger-item {
    color: var(--danger);
  }

  .menu-separator {
    height: 1px;
    margin: 4px 5px;
    background: var(--border-soft);
  }

  .icon-button {
    width: 32px;
    height: 32px;
  }

  @media (max-width: 640px) {
    .editor-header {
      gap: 10px;
      padding: 8px 12px;
    }

    .save-button {
      width: 32px;
      min-width: 32px;
      padding: 0;
    }

    .save-label {
      display: none;
    }

    .editor-kicker {
      display: none;
    }

    .title-block h1 {
      font-size: 13px;
    }
  }
</style>
