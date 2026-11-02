<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte'
  import {
    AlertTriangle,
    ArrowUpRight,
    Circle,
    Clapperboard,
    ImagePlus,
    Keyboard,
    Maximize2,
    Pause,
    Play,
    RefreshCcw,
    Save,
    Scissors,
    Square,
    Trash2,
    Type,
    Undo2,
    Upload,
    Volume2,
    VolumeX,
  } from '@lucide/svelte'
  import { EditorController } from '../editor/controller'
  import type {
    EditorContextMenuState,
    EditorMenuItem,
    EditorOverlayKind,
    EditorSnapshot,
  } from '../editor/types'
  import type { RecordingMetadata } from '../types'
  import type { RecordingStore } from '../storage/recording-store'
  import type { ToastKind } from '../toast'
  import ConfirmDialog from './editor/ConfirmDialog.svelte'
  import ContextMenu from './editor/ContextMenu.svelte'
  import EditorActionBar from './editor/EditorActionBar.svelte'
  import EditorToolbar from './editor/EditorToolbar.svelte'
  import ExportDialog from './editor/ExportDialog.svelte'
  import Inspector from './editor/Inspector.svelte'
  import KeyboardShortcutsDialog from './editor/KeyboardShortcutsDialog.svelte'
  import PreviewStage from './editor/PreviewStage.svelte'
  import Timeline from './editor/Timeline.svelte'
  import UnsavedChangesDialog from './editor/UnsavedChangesDialog.svelte'

  interface Props {
    recording: RecordingMetadata
    store: RecordingStore
    closeRequest?: number
    onClose: () => void
    onExported: (recording: RecordingMetadata) => void
    onNotify: (message: string, kind: ToastKind) => void
    onBusyChange: (busy: boolean) => void
    onDirtyChange: (dirty: boolean) => void
  }

  let {
    recording,
    store,
    closeRequest = 0,
    onClose,
    onExported,
    onNotify,
    onBusyChange,
    onDirtyChange,
  }: Props = $props()

  const controller = untrack(
    () =>
      new EditorController({
        store,
        recording,
        onNotice: (message, kind) => onNotify(message, kind),
        onExported,
        onBusyChange,
        onDirtyChange,
      }),
  )

  let snapshot = $state.raw<EditorSnapshot>(controller.snapshot)
  let exportOpen = $state(false)
  let unsavedOpen = $state(false)
  let savingExit = $state(false)
  let saveExitError = $state<string | null>(null)
  let shortcutsOpen = $state(false)
  let confirmAction = $state<'reset' | 'discard' | null>(null)
  let contextMenu = $state<EditorContextMenuState | null>(null)
  let videoInput = $state<HTMLInputElement | null>(null)
  let imageInput = $state<HTMLInputElement | null>(null)
  let handledCloseRequest = $state(0)

  const unsubscribe = controller.subscribe((next) => {
    snapshot = next
  })

  let exportBusy = $derived(
    ['preparing', 'exporting', 'finalizing'].includes(
      snapshot.exportState.phase,
    ),
  )
  let canEdit = $derived(
    Boolean(snapshot.project) && !exportBusy && !snapshot.importBusy,
  )
  let menuItems = $derived(
    contextMenu ? buildContextItems(contextMenu) : [],
  )

  onMount(() => {
    void controller.initialize()
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  })

  onDestroy(() => {
    unsubscribe()
    controller.dispose()
  })

  $effect(() => {
    if (closeRequest <= handledCloseRequest) return
    handledCloseRequest = closeRequest
    requestClose()
  })

  $effect(() => {
    if (contextMenu && (exportBusy || snapshot.status !== 'ready')) {
      contextMenu = null
    }
  })

  function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false
    if (target.isContentEditable) return true
    const tag = target.tagName.toLowerCase()
    return tag === 'input' || tag === 'textarea' || tag === 'select'
  }

  function handleKeydown(event: KeyboardEvent) {
    if (contextMenu && event.key === 'Escape') {
      event.preventDefault()
      contextMenu = null
      return
    }
    if (contextMenu) contextMenu = null
    if (
      exportOpen ||
      unsavedOpen ||
      confirmAction ||
      shortcutsOpen ||
      exportBusy
    ) {
      return
    }
    if (isTypingTarget(event.target)) return

    const modifier = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()

    if (modifier && key === 's') {
      event.preventDefault()
      void controller.saveNow()
      return
    }
    if (modifier && key === 'e') {
      event.preventDefault()
      openExportDialog()
      return
    }
    if (modifier && key === 'z') {
      event.preventDefault()
      if (event.shiftKey) controller.redo()
      else controller.undo()
      return
    }
    if (modifier && key === 'y') {
      event.preventDefault()
      controller.redo()
      return
    }
    if (event.key === ' ') {
      event.preventDefault()
      void controller.togglePlayback()
      return
    }
    if (key === 's') {
      event.preventDefault()
      controller.splitAtPlayhead()
      return
    }
    if (key === 'm') {
      event.preventDefault()
      controller.toggleMuteSelected()
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (!snapshot.selection) return
      event.preventDefault()
      controller.deleteSelection()
      return
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const direction = event.key === 'ArrowLeft' ? -1 : 1
      const fps = Math.max(1, Math.round(snapshot.project?.fps ?? 30))
      controller.step(direction * (event.shiftKey ? fps : 1))
      return
    }
    if (event.key === ',' || event.key === '.') {
      event.preventDefault()
      controller.step(event.key === ',' ? -1 : 1)
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      controller.seek(0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      controller.seek(snapshot.duration)
      return
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      controller.setZoom(snapshot.zoom * 1.33)
      return
    }
    if (event.key === '-') {
      event.preventDefault()
      controller.setZoom(snapshot.zoom * 0.75)
      return
    }
    if (event.key === '0') {
      event.preventDefault()
      controller.setZoom(80)
      return
    }
    if (event.key === '[' || event.key === ']') {
      event.preventDefault()
      const rates = [0.25, 0.5, 1, 2]
      const currentIndex = rates.findIndex(
        (rate) => Math.abs(rate - snapshot.previewRate) < 0.001,
      )
      const base = currentIndex >= 0 ? currentIndex : 2
      const nextIndex = Math.min(
        rates.length - 1,
        Math.max(0, base + (event.key === ']' ? 1 : -1)),
      )
      controller.setPreviewRate(rates[nextIndex])
      return
    }
    if (event.key === '?') {
      event.preventDefault()
      shortcutsOpen = true
      return
    }
    if (event.key === 'Escape') {
      controller.setSelection(null)
    }
  }

  function requestClose() {
    if (exportBusy) return
    if (snapshot.saving) {
      onNotify('Espera a que termine de guardar el proyecto.', 'info')
      return
    }
    contextMenu = null
    if (exportOpen) exportOpen = false
    if (snapshot.dirty) {
      saveExitError = null
      unsavedOpen = true
      return
    }
    onClose()
  }

  async function saveAndExit() {
    if (savingExit) return
    savingExit = true
    saveExitError = null
    const saved = await controller.saveNow()
    savingExit = false
    if (!saved) {
      saveExitError = 'No se pudo guardar el proyecto. Revisa el espacio local e inténtalo de nuevo.'
      return
    }
    unsavedOpen = false
    onClose()
  }

  function discardAndExit() {
    unsavedOpen = false
    onClose()
  }

  function openExportDialog() {
    if (exportBusy) return
    contextMenu = null
    controller.resetExportState()
    exportOpen = true
  }

  function handleOpenLibraryAfterExport() {
    exportOpen = false
    requestClose()
  }

  function pickVideo() {
    videoInput?.click()
  }

  function pickImage() {
    imageInput?.click()
  }

  async function onVideoFiles(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const files = Array.from(input.files ?? [])
    input.value = ''
    if (files.length > 0) await controller.importVideos(files)
  }

  async function onImageFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (file) await controller.importImage(file)
  }

  function addOverlay(kind: EditorOverlayKind) {
    if (!canEdit || snapshot.duration <= 0) return
    controller.addOverlayKind(kind)
  }

  function buildContextItems(state: EditorContextMenuState): EditorMenuItem[] {
    const project = snapshot.project
    if (!project) return []
    const items: EditorMenuItem[] = []
    const target = state.target
    const editing = canEdit
    const seekHere = () => controller.seek(target.time)
    const playHere = () => {
      controller.seek(target.time)
      if (!snapshot.playing) void controller.togglePlayback()
    }

    const overlayId =
      target.kind === 'overlay'
        ? target.overlayId
        : target.kind === 'preview'
          ? target.overlayId
          : null

    if (target.kind === 'clip' || overlayId) {
      const clip =
        target.kind === 'clip'
          ? project.clips.find((item) => item.id === target.clipId)
          : null
      const overlay = overlayId
        ? project.overlays.find((item) => item.id === overlayId)
        : null

      items.push({
        label: 'Reproducir desde aquí',
        icon: Play,
        action: playHere,
      })
      if (target.kind === 'clip') {
        const silent = Boolean(clip?.muted || (clip?.volume ?? 1) <= 0)
        items.push({
          label: 'Dividir aquí',
          icon: Scissors,
          disabled: !editing,
          action: () => {
            controller.splitAtPlayhead()
          },
        })
        items.push({
          label: silent ? 'Activar audio' : 'Silenciar segmento',
          icon: silent ? Volume2 : VolumeX,
          disabled: !editing,
          action: () => {
            controller.selectClip(target.clipId)
            controller.toggleMuteSelected()
          },
        })
        items.push({
          label: 'Eliminar segmento',
          icon: Trash2,
          danger: true,
          separatorBefore: true,
          disabled: !editing,
          action: () => {
            controller.selectClip(target.clipId)
            controller.deleteSelection()
          },
        })
      } else if (overlayId) {
        items.push({
          label: 'Ajustar al video',
          icon: Maximize2,
          disabled: !editing || !overlay,
          action: () => {
            controller.selectOverlay(overlayId)
            controller.updateOverlayDiscrete(overlayId, {
              x: 0,
              y: 0,
              width: 1,
              height: 1,
            })
          },
        })
        items.push({
          label: 'Eliminar elemento',
          icon: Trash2,
          danger: true,
          separatorBefore: true,
          disabled: !editing,
          action: () => {
            controller.selectOverlay(overlayId)
            controller.deleteSelection()
          },
        })
      }
    } else {
      items.push({
        label: snapshot.playing ? 'Pausar' : 'Reproducir',
        icon: snapshot.playing ? Pause : Play,
        action: () => void controller.togglePlayback(),
      })
      items.push({
        label: 'Mover el cabezal aquí',
        icon: Play,
        action: seekHere,
      })
      items.push({
        label: 'Dividir aquí',
        icon: Scissors,
        disabled: !editing || project.clips.length === 0,
        action: () => {
          controller.splitAtPlayhead()
        },
      })
      items.push({
        label: 'Añadir texto',
        icon: Type,
        separatorBefore: true,
        disabled: !editing || snapshot.duration <= 0,
        action: () => {
          controller.seek(target.time)
          addOverlay('text')
        },
      })
      items.push({
        label: 'Añadir rectángulo',
        icon: Square,
        disabled: !editing || snapshot.duration <= 0,
        action: () => {
          controller.seek(target.time)
          addOverlay('rect')
        },
      })
      items.push({
        label: 'Añadir elipse',
        icon: Circle,
        disabled: !editing || snapshot.duration <= 0,
        action: () => {
          controller.seek(target.time)
          addOverlay('ellipse')
        },
      })
      items.push({
        label: 'Añadir flecha',
        icon: ArrowUpRight,
        disabled: !editing || snapshot.duration <= 0,
        action: () => {
          controller.seek(target.time)
          addOverlay('arrow')
        },
      })
      items.push({
        label: 'Añadir imagen',
        icon: ImagePlus,
        disabled: !editing || snapshot.duration <= 0,
        action: () => {
          controller.seek(target.time)
          pickImage()
        },
      })
      items.push({
        label: 'Importar video',
        icon: Upload,
        disabled: !editing,
        action: pickVideo,
      })
    }

    items.push({
      label: 'Guardar proyecto',
      icon: Save,
      shortcut: 'Ctrl+S',
      separatorBefore: true,
      disabled: !snapshot.dirty || snapshot.saving,
      action: () => void controller.saveNow(),
    })
    items.push({
      label: 'Descartar cambios',
      icon: Undo2,
      disabled: !snapshot.dirty || snapshot.saving,
      action: () => (confirmAction = 'discard'),
    })
    items.push({
      label: 'Restablecer original',
      icon: RefreshCcw,
      danger: true,
      disabled: snapshot.saving,
      action: () => (confirmAction = 'reset'),
    })
    items.push({
      label: 'Atajos de teclado',
      icon: Keyboard,
      shortcut: '?',
      separatorBefore: true,
      action: () => (shortcutsOpen = true),
    })
    return items
  }

  function confirm() {
    if (confirmAction === 'reset') controller.resetToOriginal()
    if (confirmAction === 'discard') controller.discardChanges()
    confirmAction = null
  }

  let confirmCopy = $derived(
    confirmAction === 'reset'
      ? {
          title: 'Restablecer al video original',
          message:
            'Se quitarán los cortes, elementos superpuestos y videos importados de esta edición. Podrás deshacerlo mientras el editor siga abierto. El archivo original no cambia.',
          label: 'Restablecer edición',
        }
      : {
          title: 'Descartar cambios',
          message:
            'Se volverá a la última versión guardada del proyecto de edición. Perderás los cambios realizados después de guardar.',
          label: 'Descartar cambios',
        },
  )
</script>

<div class="editor-view">
  <div class="editor-surface">
    <EditorToolbar
      {snapshot}
      {controller}
      onBack={requestClose}
      onShowShortcuts={() => (shortcutsOpen = true)}
      onDiscardChanges={() => (confirmAction = 'discard')}
      onResetOriginal={() => (confirmAction = 'reset')}
    />

    {#if snapshot.status === 'loading'}
      <div class="editor-state">
        <div class="state-mark" aria-hidden="true">
          <svg viewBox="0 0 220 150" fill="none">
            <path d="M38 72V52c0-7.7 6.3-14 14-14h20" stroke="var(--primary)" stroke-width="1.5" />
            <path d="M182 72V52c0-7.7-6.3-14-14-14h-20" stroke="var(--border-strong)" stroke-width="1.5" />
            <path d="M38 78v20c0 7.7 6.3 14 14 14h20" stroke="var(--border-strong)" stroke-width="1.5" />
            <path d="M182 78v20c0 7.7-6.3 14-14 14h-20" stroke="var(--primary)" stroke-width="1.5" />
            <rect x="106" y="71" width="8" height="8" rx="2" fill="var(--primary)" />
          </svg>
        </div>
        <div class="state-copy">
          <span class="spinner"></span>
          <strong>Preparando la edición…</strong>
          <p>Leyendo el video y el proyecto guardado.</p>
        </div>
      </div>
    {:else if snapshot.status === 'error'}
      <div class="editor-state error">
        <span class="error-icon">
          <AlertTriangle size={22} strokeWidth={1.9} />
        </span>
        <div class="state-copy">
          <strong>No se pudo abrir el editor</strong>
          <p>{snapshot.error ?? 'Ocurrió un problema al leer la grabación.'}</p>
          <button type="button" class="btn btn-secondary btn-sm" onclick={onClose}>
            Volver a la biblioteca
          </button>
        </div>
      </div>
    {:else if snapshot.project}
      <div class="editor-main">
        <PreviewStage
          {snapshot}
          {controller}
          onContextMenu={(state) => (contextMenu = state)}
        />
        <Inspector {snapshot} {controller} />
      </div>
      <EditorActionBar
        {snapshot}
        {controller}
        onExport={openExportDialog}
        onImportVideo={pickVideo}
        onImportImage={pickImage}
      />
      <Timeline
        {snapshot}
        {controller}
        onContextMenu={(state) => (contextMenu = state)}
      />
    {:else}
      <div class="editor-state">
        <span class="error-icon">
          <Clapperboard size={22} strokeWidth={1.8} />
        </span>
        <div class="state-copy">
          <strong>No hay una edición disponible</strong>
          <p>Vuelve a la biblioteca y elige otra grabación.</p>
          <button type="button" class="btn btn-secondary btn-sm" onclick={onClose}>
            Volver a la biblioteca
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>

<input
  bind:this={videoInput}
  class="hidden-input"
  type="file"
  accept="video/mp4,video/webm,.mp4,.webm"
  multiple
  onchange={onVideoFiles}
/>
<input
  bind:this={imageInput}
  class="hidden-input"
  type="file"
  accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
  onchange={onImageFile}
/>

{#if exportOpen}
  <ExportDialog
    {snapshot}
    {controller}
    onClose={() => (exportOpen = false)}
    onOpenLibrary={handleOpenLibraryAfterExport}
  />
{/if}

{#if unsavedOpen}
  <UnsavedChangesDialog
    saving={savingExit}
    error={saveExitError}
    onSave={saveAndExit}
    onDiscard={discardAndExit}
    onCancel={() => {
      unsavedOpen = false
      saveExitError = null
    }}
  />
{/if}

{#if confirmAction}
  <ConfirmDialog
    title={confirmCopy.title}
    message={confirmCopy.message}
    confirmLabel={confirmCopy.label}
    danger={confirmAction === 'reset'}
    onConfirm={confirm}
    onCancel={() => (confirmAction = null)}
  />
{/if}

{#if shortcutsOpen}
  <KeyboardShortcutsDialog onClose={() => (shortcutsOpen = false)} />
{/if}

{#if contextMenu}
  <ContextMenu
    x={contextMenu.x}
    y={contextMenu.y}
    items={menuItems}
    onClose={() => (contextMenu = null)}
  />
{/if}

<style>
  .editor-view {
    min-width: 0;
  }

  .editor-surface {
    display: flex;
    height: calc(100dvh - 150px);
    min-height: 640px;
    flex-direction: column;
    overflow: hidden;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }

  .editor-main {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 292px;
    min-height: 0;
    flex: 1;
    align-items: stretch;
  }

  .editor-state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: clamp(28px, 5vw, 56px);
    min-height: 480px;
    flex: 1;
    padding: 48px;
    background: var(--surface-inset);
    text-align: left;
  }

  .state-mark {
    width: 190px;
    max-width: 34%;
    flex: 0 0 auto;
    color: var(--text-tertiary);
  }

  .state-mark svg {
    width: 100%;
    height: auto;
  }

  .state-copy {
    display: flex;
    max-width: 360px;
    flex-direction: column;
    align-items: flex-start;
    gap: 7px;
  }

  .state-copy strong {
    color: var(--text);
    font-size: 22px;
    font-weight: 580;
    letter-spacing: -0.035em;
  }

  .state-copy p {
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1.6;
  }

  .state-copy .btn {
    margin-top: 10px;
  }

  .error-icon {
    display: grid;
    width: 46px;
    height: 46px;
    flex: 0 0 auto;
    place-items: center;
    color: var(--danger);
    background: var(--danger-soft);
    border: 1px solid var(--danger-border);
    border-radius: 50%;
  }

  .hidden-input {
    display: none;
  }

  @media (max-width: 1100px) {
    .editor-main {
      grid-template-columns: minmax(0, 1fr) 270px;
    }
  }

  @media (max-width: 980px) {
    .editor-surface {
      height: auto;
      min-height: 0;
    }

    .editor-main {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 640px) {
    .editor-state {
      flex-direction: column;
      gap: 24px;
      min-height: 360px;
      padding: 32px 22px;
      text-align: center;
      align-items: center;
    }

    .state-mark {
      width: 150px;
      max-width: none;
    }

    .state-copy {
      align-items: center;
    }

    .state-copy strong {
      font-size: 20px;
    }
  }
</style>
