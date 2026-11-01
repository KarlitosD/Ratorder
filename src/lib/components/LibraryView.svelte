<script lang="ts">
  import { createDiagnosticUrl, revokeDiagnosticUrl } from '../diagnostics/resources'
  import { onDestroy } from 'svelte'
  import {
    AlertTriangle,
    ArrowDownWideNarrow,
    Calendar,
    Play,
    Search,
    Volume2,
    X,
  } from '@lucide/svelte'
  import type { RecordingMetadata } from '../types'
  import {
    formatBytes,
    formatDate,
    formatDuration,
    formatResolution,
    pluralize,
  } from '../utils/format'
  import RecordingDetail from './RecordingDetail.svelte'
  import SelectField from './SelectField.svelte'

  interface Props {
    recordings: RecordingMetadata[]
    loading: boolean
    error: string | null
    onRefresh: () => Promise<void> | void
    onGetFile: (recording: RecordingMetadata) => Promise<File>
    onGetThumbnail: (recordingId: string) => Promise<File | null>
    onDelete: (recording: RecordingMetadata) => Promise<void>
    onRename: (
      recording: RecordingMetadata,
      title: string,
    ) => Promise<RecordingMetadata>
    onNewRecording: () => void
    onNotify: (message: string, kind: 'info' | 'success' | 'warning' | 'error') => void
  }

  let {
    recordings,
    loading,
    error,
    onRefresh,
    onGetFile,
    onGetThumbnail,
    onDelete,
    onRename,
    onNewRecording,
    onNotify,
  }: Props = $props()

  type SortMode = 'recent' | 'oldest' | 'largest' | 'longest'

  const sortOptions = [
    { value: 'recent', label: 'Más recientes' },
    { value: 'oldest', label: 'Más antiguas' },
    { value: 'largest', label: 'Más grandes' },
    { value: 'longest', label: 'Más largas' },
  ] as const

  let query = $state('')
  let sort = $state<SortMode>('recent')
  let selected = $state<RecordingMetadata | null>(null)
  let thumbnailUrls = $state<Record<string, string>>({})
  const activeThumbnailUrls = new Map<string, string>()

  let totalSize = $derived(
    recordings.reduce((total, recording) => total + recording.size, 0),
  )

  let filteredRecordings = $derived.by(() => {
    const needle = query.trim().toLocaleLowerCase('es')
    const list = needle
      ? recordings.filter((recording) =>
          `${recording.title} ${recording.sourceLabel}`
            .toLocaleLowerCase('es')
            .includes(needle),
        )
      : [...recordings]

    return list.sort((left, right) => {
      switch (sort) {
        case 'oldest':
          return Date.parse(left.createdAt) - Date.parse(right.createdAt)
        case 'largest':
          return right.size - left.size
        case 'longest':
          return right.durationMs - left.durationMs
        default:
          return Date.parse(right.createdAt) - Date.parse(left.createdAt)
      }
    })
  })

  $effect(() => {
    const target = recordings.map((recording) => ({
      id: recording.id,
      hasThumbnail: Boolean(recording.thumbnail),
    }))
    let cancelled = false
    void syncThumbnails(target, () => cancelled)
    return () => {
      cancelled = true
    }
  })

  onDestroy(() => {
    for (const url of activeThumbnailUrls.values()) {
      revokeDiagnosticUrl(url)
    }
    activeThumbnailUrls.clear()
  })

  async function syncThumbnails(
    target: Array<{ id: string; hasThumbnail: boolean }>,
    isCancelled: () => boolean,
  ) {
    const wanted = new Set(
      target.filter((item) => item.hasThumbnail).map((item) => item.id),
    )

    for (const [id, url] of Array.from(activeThumbnailUrls.entries())) {
      if (wanted.has(id)) continue
      revokeDiagnosticUrl(url)
      activeThumbnailUrls.delete(id)
      const next = { ...thumbnailUrls }
      delete next[id]
      thumbnailUrls = next
    }

    for (const item of target) {
      if (!item.hasThumbnail || activeThumbnailUrls.has(item.id)) continue
      try {
        const file = await onGetThumbnail(item.id)
        if (isCancelled()) return
        if (!file) continue
        const url = createDiagnosticUrl(file, 'thumbnailUrl')
        activeThumbnailUrls.set(item.id, url)
        thumbnailUrls = { ...thumbnailUrls, [item.id]: url }
      } catch {
        // A missing thumbnail is not a fatal library error.
      }
    }
  }

  function clearSearch() {
    query = ''
  }

  function statusLabel(recording: RecordingMetadata): string {
    if (recording.status === 'interrupted') return 'Interrumpida'
    if (recording.status === 'recovered') return 'Recuperada'
    if (recording.status === 'error') return 'Con errores'
    return 'Completada'
  }

  async function handleDelete(recording: RecordingMetadata) {
    await onDelete(recording)
    selected = null
  }

  async function handleRename(
    recording: RecordingMetadata,
    title: string,
  ): Promise<RecordingMetadata> {
    const renamed = await onRename(recording, title)
    if (selected?.id === renamed.id) selected = renamed
    return renamed
  }

  let summaryText = $derived(
    recordings.length > 0
      ? `${recordings.length} ${pluralize(recordings.length, 'grabación', 'grabaciones')} · ${formatBytes(totalSize)} en este dispositivo`
      : '',
  )
</script>

<div class="library">
  <header class="library-header">
    <div class="library-heading">
      <h1>Biblioteca</h1>
      {#if summaryText}
        <p>{summaryText}</p>
      {/if}
    </div>

    {#if recordings.length > 0 || loading || error}
      <button type="button" class="btn btn-primary" onclick={onNewRecording}>
        Nueva grabación
      </button>
    {/if}
  </header>

  {#if error}
    <div class="state-card error-card">
      <span class="state-icon error">
        <AlertTriangle size={22} strokeWidth={1.9} />
      </span>
      <h2>No se pudo abrir la biblioteca</h2>
      <p>{error}</p>
      <button type="button" class="btn btn-secondary" onclick={onRefresh}>
        Volver a intentar
      </button>
    </div>
  {:else if loading}
    <div class="library-toolbar skeleton-toolbar" aria-hidden="true">
      <span class="skeleton skeleton-search"></span>
      <span class="skeleton skeleton-sort"></span>
    </div>
    <div class="recordings-grid" aria-label="Cargando grabaciones">
      {#each Array(4) as _}
        <div class="recording-card skeleton-card" aria-hidden="true">
          <div class="skeleton skeleton-thumb"></div>
          <div class="skeleton-copy">
            <span class="skeleton skeleton-title"></span>
            <span class="skeleton skeleton-meta"></span>
          </div>
        </div>
      {/each}
    </div>
  {:else if recordings.length === 0}
    <div class="empty-library">
      <div class="empty-library-mark" aria-hidden="true">
        <svg viewBox="0 0 220 150" fill="none">
          <path
            d="M38 72V52c0-7.7 6.3-14 14-14h20"
            stroke="var(--primary)"
            stroke-width="1.5"
          />
          <path
            d="M182 72V52c0-7.7-6.3-14-14-14h-20"
            stroke="var(--border-strong)"
            stroke-width="1.5"
          />
          <path
            d="M38 78v20c0 7.7 6.3 14 14 14h20"
            stroke="var(--border-strong)"
            stroke-width="1.5"
          />
          <path
            d="M182 78v20c0 7.7-6.3 14-14 14h-20"
            stroke="var(--primary)"
            stroke-width="1.5"
          />
          <rect
            x="106"
            y="71"
            width="8"
            height="8"
            rx="2"
            fill="var(--primary)"
          />
        </svg>
      </div>
      <div class="empty-library-copy">
        <h2>Aún no hay grabaciones.</h2>
        <p>
          Lo que grabes aparecerá aquí, listo para reproducir o exportar.
          Nada sale de este dispositivo.
        </p>
        <button type="button" class="btn btn-primary" onclick={onNewRecording}>
          Grabar ahora
        </button>
      </div>
    </div>
  {:else}
    <div class="library-toolbar">
      <div class="search-field">
        <Search size={15} strokeWidth={1.8} />
        <input
          type="search"
          placeholder="Buscar grabaciones…"
          aria-label="Buscar grabaciones"
          bind:value={query}
        />
        {#if query}
          <button
            type="button"
            class="search-clear"
            aria-label="Limpiar búsqueda"
            onclick={clearSearch}
          >
            <X size={13} strokeWidth={2} />
          </button>
        {/if}
      </div>

      <div class="toolbar-right">
        <div class="sort-wrap">
          <ArrowDownWideNarrow size={14} strokeWidth={1.8} />
          <label class="sr-only" for="sort-recordings">Ordenar por</label>
          <SelectField
            id="sort-recordings"
            bind:value={sort}
            options={sortOptions}
            ariaLabel="Ordenar grabaciones"
            align="end"
            bare
          />
        </div>
      </div>
    </div>

    {#if filteredRecordings.length === 0}
      <div class="no-results">
        <span class="state-icon">
          <Search size={20} strokeWidth={1.8} />
        </span>
        <h2>No encontramos nada</h2>
        <p>No hay grabaciones que coincidan con “{query}”.</p>
        <button type="button" class="btn btn-secondary btn-sm" onclick={clearSearch}>
          Limpiar búsqueda
        </button>
      </div>
    {:else}
      <div class="recordings-grid">
        {#each filteredRecordings as recording (recording.id)}
          <button
            type="button"
            class="recording-card"
            aria-label={`Abrir ${recording.title}`}
            onclick={() => (selected = recording)}
          >
            <div class="card-thumb">
              {#if thumbnailUrls[recording.id]}
                <img
                  src={thumbnailUrls[recording.id]}
                  alt=""
                  loading="lazy"
                  decoding="async"
                />
              {:else}
                <div class="thumb-placeholder">
                  <svg viewBox="0 0 34 26" fill="none" aria-hidden="true">
                    <path
                      d="M9 9H4v5M25 17h5v-5"
                      stroke="currentColor"
                      stroke-width="1.2"
                    />
                  </svg>
                </div>
              {/if}

              {#if recording.status !== 'completed'}
                <span
                  class="status-badge"
                  class:warning={recording.status === 'interrupted'}
                  class:error={recording.status === 'error'}
                  class:recovered={recording.status === 'recovered'}
                >
                  {statusLabel(recording)}
                </span>
              {/if}

              <span class="play-affordance" aria-hidden="true">
                <Play size={17} strokeWidth={1.8} fill="currentColor" />
              </span>

              <span class="duration-pill">
                {formatDuration(recording.durationMs)}
              </span>
            </div>

            <div class="card-content">
              <div class="card-title-row">
                <h3>{recording.title}</h3>
                {#if recording.hasAudio}
                  <Volume2
                    size={13}
                    strokeWidth={1.8}
                    class="card-audio"
                    aria-label="Con audio"
                  />
                {/if}
              </div>
              <div class="card-meta">
                <span>
                  <Calendar size={12} strokeWidth={1.8} />
                  {formatDate(recording.createdAt)}
                </span>
                <span class="meta-dot"></span>
                <span>{formatBytes(recording.size)}</span>
                <span class="meta-dot"></span>
                <span>{formatResolution(recording.width, recording.height)}</span>
              </div>
            </div>
          </button>
        {/each}
      </div>
    {/if}
  {/if}
</div>

{#if selected}
  <RecordingDetail
    recording={selected}
    thumbnailUrl={thumbnailUrls[selected.id] ?? null}
    onClose={() => (selected = null)}
    {onGetFile}
    onDelete={handleDelete}
    onRename={handleRename}
    {onNotify}
  />
{/if}

<style>
  .library {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .library-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 24px;
    padding: 2px 0 0;
  }

  .library-heading {
    min-width: 0;
  }

  h1 {
    color: var(--text);
    font-size: clamp(27px, 3.2vw, 34px);
    font-weight: 580;
    line-height: 1.05;
    letter-spacing: -0.045em;
  }

  .library-heading p {
    margin-top: 8px;
    color: var(--text-tertiary);
    font-size: 12px;
    line-height: 1.5;
  }

  .library-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin: 26px 0 18px;
    padding-top: 18px;
    border-top: 1px solid var(--border-soft);
  }

  .search-field {
    position: relative;
    display: flex;
    align-items: center;
    width: min(300px, 100%);
    height: 38px;
    color: var(--text-tertiary);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 9px;
    transition:
      border-color var(--fast),
      box-shadow var(--fast);
  }

  .search-field:focus-within {
    border-color: var(--primary-border);
    box-shadow: 0 0 0 3px var(--primary-soft);
  }

  .search-field > :global(svg) {
    margin-left: 12px;
    flex: 0 0 auto;
  }

  .search-field input {
    width: 100%;
    height: 100%;
    min-width: 0;
    padding: 0 8px;
    color: var(--text);
    background: transparent;
    border: 0;
    outline: none;
    font-size: 12px;
  }

  .search-field input::placeholder {
    color: var(--text-tertiary);
  }

  .search-field input::-webkit-search-cancel-button {
    display: none;
  }

  .search-clear {
    display: grid;
    width: 24px;
    height: 24px;
    margin-right: 6px;
    flex: 0 0 auto;
    place-items: center;
    color: var(--text-tertiary);
    background: transparent;
    border: 0;
    border-radius: 6px;
    cursor: pointer;
  }

  .search-clear:hover {
    color: var(--text);
    background: var(--surface-hover);
  }

  .toolbar-right {
    display: flex;
    align-items: center;
    gap: 13px;
    flex: 0 0 auto;
  }

  .sort-wrap {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 36px;
    padding: 0 0 0 9px;
    color: var(--text-tertiary);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 8px;
  }

  .sort-wrap:focus-within {
    border-color: var(--primary-border);
  }

  .recordings-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(272px, 1fr));
    gap: 18px;
  }

  .recording-card {
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding: 0;
    overflow: hidden;
    color: var(--text);
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    cursor: pointer;
    transition:
      border-color var(--fast),
      background-color var(--fast);
  }

  .recording-card:hover {
    background: var(--surface-raised);
    border-color: var(--border-strong);
  }

  .recording-card:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }

  .card-thumb {
    position: relative;
    overflow: hidden;
    width: 100%;
    aspect-ratio: 16 / 9;
    background: var(--surface-inset);
    border-bottom: 1px solid var(--border-soft);
  }

  .card-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform 220ms var(--ease);
  }

  .recording-card:hover .card-thumb img {
    transform: scale(1.015);
  }

  .thumb-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    color: var(--text-tertiary);
  }

  .thumb-placeholder :global(svg) {
    width: 34px;
    height: 26px;
    opacity: 0.55;
  }

  .status-badge {
    position: absolute;
    top: 9px;
    left: 9px;
    display: inline-flex;
    align-items: center;
    height: 21px;
    padding: 0 7px;
    color: var(--success);
    background: rgba(10, 13, 18, 0.86);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 5px;
    font-size: 9.5px;
    font-weight: 550;
  }

  .status-badge.warning {
    color: #f2c06d;
  }

  .status-badge.error {
    color: #ff8b93;
  }

  .status-badge.recovered {
    color: #7fe3ba;
  }

  .duration-pill {
    position: absolute;
    right: 9px;
    bottom: 9px;
    display: inline-flex;
    align-items: center;
    height: 21px;
    padding: 0 7px;
    color: rgba(255, 255, 255, 0.9);
    background: rgba(8, 10, 13, 0.8);
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 5px;
    font-family: var(--font-mono);
    font-size: 9.5px;
    font-variant-numeric: tabular-nums;
  }

  .play-affordance {
    position: absolute;
    top: 50%;
    left: 50%;
    display: grid;
    width: 40px;
    height: 40px;
    place-items: center;
    color: #fff;
    background: rgba(12, 15, 20, 0.8);
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 50%;
    opacity: 0;
    transform: translate(-50%, -46%) scale(0.95);
    transition:
      opacity var(--fast),
      transform var(--fast);
  }

  .recording-card:hover .play-affordance,
  .recording-card:focus-visible .play-affordance {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }

  .play-affordance :global(svg) {
    margin-left: 2px;
  }

  .card-content {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 13px 14px 14px;
    min-width: 0;
  }

  .card-title-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  h3 {
    overflow: hidden;
    min-width: 0;
    flex: 1;
    color: var(--text);
    font-size: 12.5px;
    font-weight: 550;
    line-height: 1.4;
    letter-spacing: -0.015em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.card-audio) {
    flex: 0 0 auto;
    color: var(--text-tertiary);
  }

  .card-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
    color: var(--text-tertiary);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .card-meta span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }

  .card-meta span:not(.meta-dot) {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .meta-dot {
    width: 3px;
    height: 3px;
    flex: 0 0 auto;
    background: var(--border-strong);
    border-radius: 50%;
  }

  .empty-library {
    display: grid;
    grid-template-columns: 220px minmax(0, 420px);
    align-items: center;
    gap: clamp(32px, 5vw, 64px);
    min-height: 410px;
    margin-top: 26px;
    padding: 48px 0 56px;
    border-top: 1px solid var(--border-soft);
  }

  .empty-library-mark {
    width: 100%;
    max-width: 220px;
    color: var(--text-tertiary);
  }

  .empty-library-mark svg {
    width: 100%;
    height: auto;
  }

  .empty-library-copy h2 {
    color: var(--text);
    font-size: clamp(24px, 2.8vw, 31px);
    font-weight: 580;
    line-height: 1.1;
    letter-spacing: -0.04em;
  }

  .empty-library-copy p {
    max-width: 38ch;
    margin-top: 10px;
    color: var(--text-secondary);
    font-size: 12.5px;
    line-height: 1.65;
  }

  .empty-library-copy .btn {
    margin-top: 22px;
  }

  .state-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    min-height: 320px;
    margin-top: 26px;
    padding: 44px 0;
    text-align: left;
    border-top: 1px solid var(--border-soft);
  }

  .state-card h2,
  .no-results h2 {
    margin-top: 16px;
    color: var(--text);
    font-size: 22px;
    font-weight: 580;
    letter-spacing: -0.04em;
  }

  .state-card p,
  .no-results p {
    max-width: 42ch;
    margin-top: 7px;
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1.65;
  }

  .state-card .btn {
    margin-top: 20px;
  }

  .state-icon {
    display: grid;
    width: 38px;
    height: 38px;
    place-items: center;
    color: var(--text-tertiary);
    border: 1px solid var(--border);
    border-radius: 50%;
  }

  .state-icon.error {
    color: var(--danger);
    border-color: var(--danger-border);
  }

  .no-results {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    min-height: 280px;
    padding: 38px 0;
    text-align: left;
    border-top: 1px solid var(--border-soft);
  }

  .no-results .btn {
    margin-top: 16px;
  }

  .skeleton {
    display: block;
    background: var(--surface-active);
    border-radius: 6px;
    animation: skeleton-pulse 1.5s ease-in-out infinite;
  }

  .skeleton-toolbar {
    justify-content: flex-start;
  }

  .skeleton-search {
    width: 300px;
    height: 38px;
    border-radius: 9px;
  }

  .skeleton-sort {
    width: 120px;
    height: 34px;
    margin-left: auto;
  }

  .skeleton-card {
    min-height: 230px;
    cursor: default;
  }

  .skeleton-card:hover {
    background: var(--surface);
    border-color: var(--border);
  }

  .skeleton-thumb {
    width: 100%;
    aspect-ratio: 16 / 9;
    border-radius: 0;
  }

  .skeleton-copy {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 13px;
  }

  .skeleton-title {
    width: 62%;
    height: 11px;
  }

  .skeleton-meta {
    width: 82%;
    height: 8px;
  }

  @keyframes skeleton-pulse {
    0%,
    100% {
      opacity: 0.55;
    }
    50% {
      opacity: 1;
    }
  }

  @media (hover: none) {
    .play-affordance {
      display: none;
    }
  }

  @media (max-width: 720px) {
    .library-header {
      align-items: flex-start;
      flex-direction: column;
      gap: 16px;
    }

    .library-toolbar {
      align-items: stretch;
      flex-direction: column;
      gap: 10px;
      margin-top: 22px;
    }

    .search-field {
      width: 100%;
    }

    .toolbar-right {
      justify-content: space-between;
    }

    .recordings-grid {
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 12px;
    }

    .empty-library {
      grid-template-columns: 1fr;
      gap: 28px;
      min-height: 0;
      padding: 35px 0 42px;
    }

    .empty-library-mark {
      max-width: 168px;
    }

    .state-card {
      min-height: 280px;
      padding: 34px 0;
    }
  }

  @media (max-width: 480px) {
    .recordings-grid {
      grid-template-columns: 1fr;
    }

    .skeleton-search {
      width: 100%;
    }
  }
</style>
