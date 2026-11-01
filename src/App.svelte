<script lang="ts">
  import { onMount } from 'svelte'
  import { AlertTriangle } from '@lucide/svelte'
  import AppHeader from './lib/components/AppHeader.svelte'
  import LibraryView from './lib/components/LibraryView.svelte'
  import RecordView from './lib/components/RecordView.svelte'
  import Toast from './lib/components/Toast.svelte'
  import { inspectAfterRecording } from './lib/diagnostics/reporting'
  import {
    getBrowserCapabilities,
    loadPreferences,
    savePreferences,
  } from './lib/recording/config'
  import { RecordingController } from './lib/recording/recording-controller'
  import { RecordingStore } from './lib/storage/recording-store'
  import type {
    AppView,
    RecorderSnapshot,
    RecordingMetadata,
    RecordingPreferences,
    StorageSummary,
  } from './lib/types'
  import type { ToastMessage, ToastKind } from './lib/toast'

  let preferences = $state<RecordingPreferences>(loadPreferences())
  let theme = $state<'dark' | 'light'>(loadTheme())
  let view = $state<AppView>('record')
  let snapshot = $state.raw<RecorderSnapshot>({
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
  })
  let recordings = $state<RecordingMetadata[]>([])
  let storage = $state<StorageSummary>({ used: 0, quota: 0 })
  let libraryLoading = $state(true)
  let libraryError = $state<string | null>(null)
  let toast = $state<ToastMessage | null>(null)
  let toastTimer: ReturnType<typeof setTimeout> | null = null
  let toastCounter = 0

  const capabilities = getBrowserCapabilities()
  const store = new RecordingStore()
  const recorder = new RecordingController({
    store,
    onNotice: (message, kind) => showToast(message, kind),
    onRecordingFinished: () => {
      void refreshLibrary()
      window.setTimeout(() => void updateStorageUsage(), 300)
    },
    onRecordingCleanup: () => {
      if (['preparing', 'recording', 'paused', 'finalizing'].includes(snapshot.phase)) return
      if (inspectAfterRecording()) {
        showToast('Diagnóstico: un recurso de grabación sigue activo. Consulta el informe local.', 'warning')
      }
    },
  })

  let supportWarning = $derived(
    !capabilities.displayCapture || !capabilities.webCodecs || !capabilities.opfs,
  )

  $effect(() => {
    return recorder.subscribe((next) => {
      snapshot = next
    })
  })

  $effect(() => {
    savePreferences(preferences)
  })

  $effect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'dark' ? '#0E1015' : '#F3F5F9')
    try {
      localStorage.setItem('ratorder.theme', theme)
    } catch {
      // Theme persistence is optional.
    }
  })

  onMount(() => {
    void initializeLibrary()
  })

  function loadTheme(): 'dark' | 'light' {
    try {
      return localStorage.getItem('ratorder.theme') === 'light'
        ? 'light'
        : 'dark'
    } catch {
      return 'dark'
    }
  }

  async function initializeLibrary() {
    libraryLoading = true
    libraryError = null
    try {
      recordings = await store.initialize()
      await updateStorageUsage()
    } catch (error) {
      libraryError =
        error instanceof Error
          ? error.message
          : 'No se pudo abrir el almacenamiento local.'
    } finally {
      libraryLoading = false
    }
  }

  async function refreshLibrary() {
    try {
      recordings = await store.listRecordings(
        snapshot.activeRecordingId ?? undefined,
      )
      libraryError = null
      await updateStorageUsage()
    } catch (error) {
      libraryError =
        error instanceof Error
          ? error.message
          : 'No se pudo actualizar la biblioteca.'
    }
  }

  async function updateStorageUsage() {
    try {
      const estimate = await navigator.storage?.estimate?.()
      const recordingsSize = recordings.reduce(
        (total, recording) => total + recording.size,
        0,
      )
      storage = {
        used: recordingsSize,
        quota: estimate?.quota ?? 0,
      }
    } catch {
      // The size shown on each recording still works without an estimate.
    }
  }

  function showToast(
    message: string,
    kind: ToastKind = 'info',
    actionLabel?: string,
  ) {
    if (toastTimer) {
      clearTimeout(toastTimer)
      toastTimer = null
    }
    toast = { id: ++toastCounter, message, kind, actionLabel }
    toastTimer = setTimeout(() => {
      toast = null
      toastTimer = null
    }, 5200)
  }

  function dismissToast() {
    if (toastTimer) {
      clearTimeout(toastTimer)
      toastTimer = null
    }
    toast = null
  }

  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark'
  }

  function navigate(nextView: AppView) {
    if (view === nextView) return
    view = nextView
    if (nextView === 'library') {
      void refreshLibrary()
      void updateStorageUsage()
    }
  }

  async function handleSelectSource() {
    await recorder.selectSource(preferences)
  }

  async function handleStart() {
    if (navigator.storage?.persist) {
      void navigator.storage.persist().catch(() => undefined)
    }
    await recorder.start(preferences)
  }

  async function handleStop(thumbnail?: Blob) {
    await recorder.stop(thumbnail)
  }

  async function handleDelete(recording: RecordingMetadata) {
    await store.deleteRecording(recording.id)
    await refreshLibrary()
    await updateStorageUsage()
    showToast('Grabación eliminada.', 'success')
  }

  async function handleRename(
    recording: RecordingMetadata,
    title: string,
  ): Promise<RecordingMetadata> {
    const renamed: RecordingMetadata = {
      ...recording,
      title: title.trim() || recording.title,
    }
    await store.saveMetadata(renamed)
    await refreshLibrary()
    showToast('Título actualizado.', 'success')
    return renamed
  }

  async function handleGetFile(
    recording: RecordingMetadata,
  ): Promise<File> {
    return await store.getVideoFile(recording)
  }

  function handleNewRecording() {
    recorder.reset()
    view = 'record'
  }
</script>

<div class="app-shell">
  <AppHeader
    {view}
    {theme}
    storageUsed={storage.used}
    phase={snapshot.phase}
    elapsedMs={snapshot.elapsedMs}
    onNavigate={navigate}
    onToggleTheme={toggleTheme}
  />

  <main class="app-main">
    {#if supportWarning}
      <div class="support-banner" role="alert">
        <span class="support-icon">
          <AlertTriangle size={17} strokeWidth={1.9} />
        </span>
        <div>
          <strong>Este navegador no puede usar el grabador completo</strong>
          <p>
            Ratorder necesita captura de pantalla, WebCodecs y almacenamiento
            OPFS. Usa una versión reciente de Chrome, Edge u otro navegador
            Chromium de escritorio.
          </p>
        </div>
      </div>
    {/if}

    {#if view === 'record'}
      <RecordView
        {snapshot}
        bind:preferences
        onSelectSource={handleSelectSource}
        onStart={handleStart}
        onStop={handleStop}
        onPause={() => recorder.pause()}
        onResume={() => recorder.resume()}
        onToggleMute={() => recorder.setMicrophoneMuted(!snapshot.microphoneMuted)}
        onReset={handleNewRecording}
        onOpenLibrary={() => navigate('library')}
      />
    {:else}
      <LibraryView
        {recordings}
        loading={libraryLoading}
        error={libraryError}
        onRefresh={refreshLibrary}
        onGetFile={handleGetFile}
        onGetThumbnail={(recordingId) => store.getThumbnailFile(recordingId)}
        onDelete={handleDelete}
        onRename={handleRename}
        onNewRecording={() => navigate('record')}
        onNotify={showToast}
      />
    {/if}
  </main>
</div>

{#if toast}
  <Toast
    {toast}
    onClose={dismissToast}
    onAction={toast.actionLabel
      ? () => {
          if (toast?.actionLabel === 'Abrir biblioteca') navigate('library')
        }
      : undefined}
  />
{/if}

<style>
  .support-banner {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 18px;
    padding: 13px 15px;
    color: var(--warning);
    background: var(--warning-soft);
    border: 1px solid var(--warning-border);
    border-radius: 11px;
  }

  .support-icon {
    display: grid;
    width: 30px;
    height: 30px;
    flex: 0 0 auto;
    place-items: center;
    background: rgba(255, 255, 255, 0.04);
    border-radius: 8px;
  }

  .support-banner strong {
    display: block;
    font-size: 12px;
    font-weight: 600;
  }

  .support-banner p {
    margin-top: 3px;
    color: var(--warning);
    opacity: 0.78;
    font-size: 11px;
    line-height: 1.5;
  }

  .support-banner :global(span) {
    color: var(--warning);
  }
</style>
