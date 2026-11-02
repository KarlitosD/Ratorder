<script lang="ts">
  import { onMount } from 'svelte'
  import {
    ArrowUpRight,
    ChevronDown,
    Circle,
    Download,
    ImagePlus,
    Pause,
    Play,
    Plus,
    Redo2,
    Scissors,
    SkipBack,
    SkipForward,
    Square,
    Trash2,
    Type,
    Undo2,
    Upload,
    Volume2,
    VolumeX,
  } from '@lucide/svelte'
  import type { EditorController } from '../../editor/controller'
  import type { EditorOverlayKind, EditorSnapshot } from '../../editor/types'

  interface Props {
    snapshot: EditorSnapshot
    controller: EditorController
    onExport: () => void
    onImportVideo: () => void
    onImportImage: () => void
  }

  let {
    snapshot,
    controller,
    onExport,
    onImportVideo,
    onImportImage,
  }: Props = $props()

  let addOpen = $state(false)
  let addWrap = $state<HTMLDivElement | null>(null)
  let rateOpen = $state(false)
  let rateWrap = $state<HTMLDivElement | null>(null)

  const previewRates = [0.25, 0.5, 1, 2] as const

  onMount(() => {
    const close = (event: PointerEvent) => {
      if (addOpen && addWrap && !addWrap.contains(event.target as Node)) {
        addOpen = false
      }
      if (rateOpen && rateWrap && !rateWrap.contains(event.target as Node)) {
        rateOpen = false
      }
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  })

  let project = $derived(snapshot.project)
  let exportBusy = $derived(
    ['preparing', 'exporting', 'finalizing'].includes(
      snapshot.exportState.phase,
    ),
  )
  let busy = $derived(exportBusy || snapshot.importBusy)
  let canEdit = $derived(Boolean(project) && !busy)
  let empty = $derived(!project || project.clips.length === 0)
  let selectedClipSilent = $derived.by(() => {
    const selection = snapshot.selection
    if (!project || selection?.type !== 'clip') return false
    const clip = project.clips.find((item) => item.id === selection.id)
    return clip ? clip.muted || clip.volume <= 0 : false
  })

  const overlayOptions: Array<{
    kind: EditorOverlayKind
    label: string
    icon: typeof Type
  }> = [
    { kind: 'text', label: 'Texto', icon: Type },
    { kind: 'rect', label: 'Rectángulo', icon: Square },
    { kind: 'ellipse', label: 'Elipse', icon: Circle },
    { kind: 'arrow', label: 'Flecha', icon: ArrowUpRight },
  ]

  function addOverlay(kind: EditorOverlayKind) {
    controller.addOverlayKind(kind)
    addOpen = false
  }

  function addImage() {
    addOpen = false
    onImportImage()
  }

  function togglePlayback() {
    if (busy || empty) return
    void controller.togglePlayback()
  }

  function formatClock(seconds: number): string {
    const safe = Math.max(0, seconds)
    const hours = Math.floor(safe / 3600)
    const minutes = Math.floor((safe % 3600) / 60)
    const wholeSeconds = Math.floor(safe % 60)
    const centiseconds = Math.floor((safe % 1) * 100)
    return `${hours > 0 ? `${hours}:` : ''}${String(minutes).padStart(
      hours > 0 ? 2 : 1,
      '0',
    )}:${String(wholeSeconds).padStart(2, '0')}.${String(
      centiseconds,
    ).padStart(2, '0')}`
  }
</script>

<div class="editor-actions" aria-label="Acciones de edición">
  <div class="action-group transport-group">
    <button
      type="button"
      class="icon-button"
      aria-label="Retroceder un fotograma"
      title="Fotograma anterior (←)"
      disabled={empty || busy}
      onclick={() => controller.step(-1)}
    >
      <SkipBack size={15} strokeWidth={1.9} />
    </button>
    <button
      type="button"
      class="play-button"
      aria-label={snapshot.playing ? 'Pausar' : 'Reproducir'}
      title="Reproducir o pausar (Espacio)"
      disabled={empty || busy}
      onclick={togglePlayback}
    >
      {#if snapshot.playing}
        <Pause size={16} strokeWidth={1.9} fill="currentColor" />
      {:else}
        <Play size={16} strokeWidth={1.9} fill="currentColor" />
      {/if}
    </button>
    <button
      type="button"
      class="icon-button"
      aria-label="Avanzar un fotograma"
      title="Fotograma siguiente (→)"
      disabled={empty || busy}
      onclick={() => controller.step(1)}
    >
      <SkipForward size={15} strokeWidth={1.9} />
    </button>
    <span class="time-readout">
      <span class="current">{formatClock(snapshot.playhead)}</span>
      <span class="separator">/</span>
      <span class="total">{formatClock(snapshot.duration)}</span>
    </span>

    <div class="rate-wrap" bind:this={rateWrap}>
      <button
        type="button"
        class="rate-button"
        aria-expanded={rateOpen}
        aria-label="Velocidad de previsualización"
        title="Velocidad de preview; no afecta a la exportación"
        disabled={empty || busy}
        onclick={() => (rateOpen = !rateOpen)}
      >
        {snapshot.previewRate}×
        <ChevronDown size={11} strokeWidth={2} />
      </button>
      {#if rateOpen}
        <div class="rate-menu" role="menu" aria-label="Velocidad de previsualización">
          <span class="rate-note">Solo preview</span>
          {#each previewRates as rate}
            <button
              type="button"
              role="menuitem"
              class:active={Math.abs(snapshot.previewRate - rate) < 0.001}
              onclick={() => {
                controller.setPreviewRate(rate)
                rateOpen = false
              }}
            >
              {rate}×
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <div class="action-group edit-group">
    <button
      type="button"
      class="icon-button"
      aria-label="Deshacer"
      title="Deshacer (Ctrl+Z)"
      disabled={!canEdit || !snapshot.canUndo}
      onclick={() => controller.undo()}
    >
      <Undo2 size={16} strokeWidth={1.9} />
    </button>
    <button
      type="button"
      class="icon-button"
      aria-label="Rehacer"
      title="Rehacer (Ctrl+Shift+Z)"
      disabled={!canEdit || !snapshot.canRedo}
      onclick={() => controller.redo()}
    >
      <Redo2 size={16} strokeWidth={1.9} />
    </button>
    <span class="divider"></span>
    <button
      type="button"
      class="icon-button"
      aria-label="Dividir segmento"
      title="Dividir en el cabezal (S)"
      disabled={!canEdit}
      onclick={() => controller.splitAtPlayhead()}
    >
      <Scissors size={16} strokeWidth={1.9} />
    </button>
    <button
      type="button"
      class="icon-button"
      aria-label={selectedClipSilent ? 'Activar audio del segmento' : 'Silenciar segmento'}
      title={selectedClipSilent ? 'Activar audio (M)' : 'Silenciar segmento (M)'}
      disabled={!canEdit}
      onclick={() => controller.toggleMuteSelected()}
    >
      {#if selectedClipSilent}
        <VolumeX size={16} strokeWidth={1.9} />
      {:else}
        <Volume2 size={16} strokeWidth={1.9} />
      {/if}
    </button>
    <button
      type="button"
      class="icon-button danger"
      aria-label="Eliminar selección"
      title="Eliminar selección (Supr)"
      disabled={!canEdit || !snapshot.selection}
      onclick={() => controller.deleteSelection()}
    >
      <Trash2 size={16} strokeWidth={1.9} />
    </button>
  </div>

  <div class="action-group media-group">
    <button
      type="button"
      class="btn btn-secondary btn-sm"
      disabled={!canEdit}
      onclick={onImportVideo}
    >
      {#if snapshot.importBusy}
        <span class="spinner"></span>
        Importando
      {:else}
        <Upload size={14} strokeWidth={1.9} />
        Importar video
      {/if}
    </button>

    <div class="add-wrap" bind:this={addWrap}>
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        aria-expanded={addOpen}
        disabled={!canEdit || empty}
        onclick={() => (addOpen = !addOpen)}
      >
        <Plus size={14} strokeWidth={2} />
        Añadir
      </button>
      {#if addOpen}
        <div class="add-menu" role="menu" aria-label="Añadir elemento">
          {#each overlayOptions as option}
            {@const Icon = option.icon}
            <button
              type="button"
              role="menuitem"
              onclick={() => addOverlay(option.kind)}
            >
              <Icon size={14} strokeWidth={1.9} />
              {option.label}
            </button>
          {/each}
          <button type="button" role="menuitem" onclick={addImage}>
            <ImagePlus size={14} strokeWidth={1.9} />
            Imagen
          </button>
        </div>
      {/if}
    </div>

    <button
      type="button"
      class="btn btn-primary btn-sm"
      disabled={!project || exportBusy || snapshot.duration <= 0}
      title="Exportar una copia editada (Ctrl+E)"
      onclick={onExport}
    >
      {#if exportBusy}
        <span class="spinner"></span>
        Exportando
      {:else}
        <Download size={14} strokeWidth={1.9} />
        Exportar
      {/if}
    </button>
  </div>
</div>

<style>
  .editor-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    min-height: 46px;
    padding: 6px 16px;
    background: var(--surface);
    border-top: 1px solid var(--border-soft);
  }

  .action-group {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
  }

  .transport-group {
    flex: 1;
  }

  .edit-group {
    flex: 0 0 auto;
  }

  .media-group {
    flex: 1;
    justify-content: flex-end;
  }

  .media-group .btn {
    height: 32px;
    min-height: 32px;
    box-shadow: none;
  }

  .add-wrap {
    display: flex;
    align-items: center;
  }

  .icon-button {
    width: 30px;
    height: 30px;
  }

  .icon-button.danger:hover:not(:disabled) {
    color: var(--danger);
    background: var(--danger-soft);
    border-color: var(--danger-border);
  }

  .play-button {
    display: grid;
    width: 33px;
    height: 33px;
    place-items: center;
    color: var(--primary-contrast);
    background: var(--primary);
    border: 1px solid var(--primary);
    border-radius: 8px;
    cursor: pointer;
    transition: background-color var(--fast);
  }

  .play-button:hover:not(:disabled) {
    background: var(--primary-hover);
  }

  .play-button:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  .play-button :global(svg) {
    margin-left: 1px;
  }

  .divider {
    width: 1px;
    height: 18px;
    margin: 0 3px;
    background: var(--border-soft);
  }

  .time-readout {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-left: 8px;
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .time-readout .current {
    color: var(--text);
    font-weight: 520;
  }

  .separator {
    opacity: 0.55;
  }

  .rate-wrap {
    position: relative;
    margin-left: 3px;
  }

  .rate-button {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 25px;
    padding: 0 6px;
    color: var(--text-secondary);
    background: var(--surface-inset);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-family: var(--font-mono);
    font-size: 9px;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }

  .rate-button:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--border-strong);
  }

  .rate-button:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  .rate-menu {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: 35;
    display: flex;
    flex-direction: column;
    min-width: 108px;
    padding: 4px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 9px;
    box-shadow: var(--shadow-popover);
  }

  .rate-note {
    padding: 4px 7px 5px;
    color: var(--text-tertiary);
    font-size: 8.5px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .rate-menu button {
    height: 27px;
    padding: 0 8px;
    color: var(--text-secondary);
    text-align: left;
    background: transparent;
    border: 0;
    border-radius: 5px;
    font-family: var(--font-mono);
    font-size: 10px;
    cursor: pointer;
  }

  .rate-menu button:hover,
  .rate-menu button.active {
    color: var(--text);
    background: var(--surface-hover);
  }

  .add-wrap {
    position: relative;
  }

  .add-menu {
    position: absolute;
    right: 0;
    bottom: calc(100% + 6px);
    z-index: 35;
    display: flex;
    min-width: 164px;
    flex-direction: column;
    padding: 4px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 9px;
    box-shadow: var(--shadow-popover);
  }

  .add-menu button {
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

  .add-menu button:hover {
    color: var(--text);
    background: var(--surface-hover);
  }

  @media (max-width: 1120px) {
    .editor-actions {
      flex-wrap: wrap;
      gap: 8px;
    }

    .transport-group {
      flex: 1 1 auto;
    }

    .edit-group {
      order: 2;
    }

    .media-group {
      order: 3;
      flex: 1 1 100%;
      justify-content: flex-end;
    }
  }

  @media (max-width: 640px) {
    .editor-actions {
      padding: 6px 12px;
    }

    .transport-group {
      flex: 1 1 100%;
      justify-content: center;
    }

    .edit-group {
      flex: 1;
      justify-content: center;
    }

    .media-group {
      flex: 1 1 100%;
    }

    .media-group .btn {
      flex: 1;
      justify-content: center;
    }

    .add-wrap {
      flex: 1;
    }

    .add-wrap > .btn {
      width: 100%;
    }

    .time-readout {
      margin-left: 4px;
      font-size: 9.5px;
    }
  }
</style>
