<script lang="ts">
  import { onMount } from 'svelte'
  import {
    ChevronDown,
    ChevronRight,
    Mic,
    Settings2,
  } from '@lucide/svelte'
  import type {
    CaptureSourceInfo,
    RecorderPhase,
    RecordingPreferences,
  } from '../types'
  import {
    QUALITY_PRESETS,
    computeVideoBitrate,
  } from '../recording/config'
  import { formatBitrate, formatResolution } from '../utils/format'
  import SelectField from './SelectField.svelte'

  interface Props {
    preferences: RecordingPreferences
    source: CaptureSourceInfo | null
    phase: RecorderPhase
    onSelectSource: () => void
  }

  let {
    preferences = $bindable(),
    source,
    phase,
    onSelectSource,
  }: Props = $props()

  let microphones = $state<MediaDeviceInfo[]>([])
  let advancedOpen = $state(false)

  const formatOptions = [
    { value: 'mp4', label: 'MP4 · H.264' },
    { value: 'webm', label: 'WebM · VP9' },
  ] as const

  const fragmentOptions = [
    { value: 2, label: 'Cada 2 segundos' },
    { value: 4, label: 'Cada 4 segundos' },
    { value: 8, label: 'Cada 8 segundos' },
  ] as const

  const audioBitrateOptions = [
    { value: 96_000, label: '96 kbps' },
    { value: 128_000, label: '128 kbps' },
    { value: 192_000, label: '192 kbps' },
  ] as const

  let microphoneOptions = $derived([
    { value: 'off', label: 'Sin micrófono' },
    { value: 'default', label: 'Micrófono predeterminado' },
    ...microphones
      .filter(
        (device) =>
          device.deviceId !== 'default' &&
          device.deviceId !== 'communications',
      )
      .map((device, index) => ({
        value: device.deviceId,
        label: micLabel(device, index),
      })),
  ])

  let locked = $derived(
    phase === 'preparing' ||
      phase === 'recording' ||
      phase === 'paused' ||
      phase === 'finalizing',
  )
  let quality = $derived(QUALITY_PRESETS[preferences.quality])
  let estimatedBitrate = $derived(
    computeVideoBitrate(preferences.quality, preferences.fps),
  )

  onMount(() => {
    void loadDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', loadDevices)
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', loadDevices)
    }
  })

  $effect(() => {
    if (phase === 'recording' || phase === 'error' || phase === 'completed') {
      void loadDevices()
    }
  })

  async function loadDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      microphones = devices.filter((device) => device.kind === 'audioinput')
      const current = preferences.microphoneId
      if (
        current !== 'off' &&
        current !== 'default' &&
        !microphones.some((device) => device.deviceId === current)
      ) {
        preferences.microphoneId = 'default'
      }
    } catch {
      microphones = []
    }
  }

  function selectQuality(value: RecordingPreferences['quality']) {
    if (locked) return
    preferences.quality = value
  }

  function micLabel(device: MediaDeviceInfo, index: number): string {
    if (device.label) return device.label
    return `Micrófono ${index + 1}`
  }
</script>

<aside class="settings-panel" aria-label="Configuración de grabación">
  <div class="panel-heading">
    <h2>Configuración</h2>
  </div>

  <div class="settings-body">
    <section class="section">
      <div class="section-title">
        <span>Fuente</span>
        {#if phase === 'error'}
          <span class="source-error">Error</span>
        {:else if source}
          <span class="source-ready">
            <span class="dot"></span>
            {phase === 'recording' || phase === 'paused' ? 'Activa' : 'Lista'}
          </span>
        {/if}
      </div>

      <div class="source-row">
        <div class="source-copy">
          <span class="source-label">{source?.label ?? 'Sin fuente seleccionada'}</span>
          <span class="source-detail">
            {source
              ? `${formatResolution(source.width, source.height)} · ${source.fps} FPS`
              : 'Pantalla, ventana o pestaña del navegador'}
          </span>
        </div>
        {#if source}
          <button
            type="button"
            class="source-action"
            disabled={locked}
            onclick={onSelectSource}
          >
            Cambiar
            <ChevronRight size={14} strokeWidth={1.9} />
          </button>
        {/if}
      </div>
    </section>

    <section class="section">
      <div class="section-title">
        <span>Audio</span>
      </div>

      <div class="field">
        <div class="field-label-row">
          <label class="field-label" for="microphone-select">
            <Mic size={13} strokeWidth={1.9} />
            Micrófono
          </label>
        </div>
        <SelectField
          id="microphone-select"
          bind:value={preferences.microphoneId}
          options={microphoneOptions}
          disabled={locked}
          ariaLabel="Micrófono"
        />
      </div>

      <div class="toggle-row">
        <div class="toggle-copy">
          <span class="field-label">Audio del sistema</span>
          <span class="field-hint">
            {source?.hasSystemAudio
              ? 'Disponible en esta fuente'
              : 'Depende de la fuente y del navegador'}
          </span>
        </div>
        <button
          type="button"
          class="switch"
          role="switch"
          aria-checked={preferences.systemAudio}
          aria-label="Grabar audio del sistema"
          disabled={locked}
          onclick={() => (preferences.systemAudio = !preferences.systemAudio)}
        ></button>
      </div>

      {#if source && !locked}
        {#if preferences.systemAudio && !source.hasSystemAudio}
          <p class="inline-note">
            La fuente actual no comparte audio. Vuelve a seleccionarla para
            activarlo.
          </p>
        {:else if !preferences.systemAudio && source.hasSystemAudio}
          <p class="inline-note">
            El audio del sistema de esta fuente no se incluirá al grabar.
          </p>
        {/if}
      {/if}
    </section>

    <section class="section">
      <div class="section-title">
        <span>Video</span>
        <span class="section-meta">{formatBitrate(estimatedBitrate)}</span>
      </div>

      <div class="field">
        <div class="field-label-row">
          <span class="field-label">Calidad</span>
        </div>
        <div class="segmented quality-options">
          {#each Object.entries(QUALITY_PRESETS) as [value, preset]}
            <button
              type="button"
              class:active={preferences.quality === value}
              aria-pressed={preferences.quality === value}
              disabled={locked}
              onclick={() =>
                selectQuality(value as RecordingPreferences['quality'])}
            >
              <span>{preset.label}</span>
              <small>{preset.shortLabel}</small>
            </button>
          {/each}
        </div>
        <p class="field-hint quality-hint">{quality.description}</p>
      </div>

      <div class="field split-field">
        <div class="split-item">
          <div class="field-label-row">
            <span class="field-label">Fotogramas</span>
          </div>
          <div class="segmented fps-options">
            <button
              type="button"
              class:active={preferences.fps === 30}
              aria-pressed={preferences.fps === 30}
              disabled={locked}
              onclick={() => (preferences.fps = 30)}>30</button
            >
            <button
              type="button"
              class:active={preferences.fps === 60}
              aria-pressed={preferences.fps === 60}
              disabled={locked}
              onclick={() => (preferences.fps = 60)}>60</button
            >
          </div>
        </div>

        <div class="split-item">
          <div class="field-label-row">
            <label class="field-label" for="format-select">Formato</label>
          </div>
          <SelectField
            id="format-select"
            bind:value={preferences.container}
            options={formatOptions}
            disabled={locked}
            ariaLabel="Formato de salida"
          />
        </div>
      </div>
    </section>

    <section class="advanced">
      <button
        type="button"
        class="advanced-toggle"
        aria-expanded={advancedOpen}
        onclick={() => (advancedOpen = !advancedOpen)}
      >
        <span>
          <Settings2 size={14} strokeWidth={1.8} />
          Opciones avanzadas
        </span>
        <span class="advanced-chevron" class:rotated={advancedOpen}>
          <ChevronDown size={15} strokeWidth={1.8} />
        </span>
      </button>

      <div class="advanced-collapse" class:open={advancedOpen}>
        <div class="advanced-inner">
          <div class="advanced-grid">
            <div class="field">
              <div class="field-label-row">
                <span class="field-label">Fragmentos MP4</span>
              </div>
              <SelectField
                bind:value={preferences.fragmentDuration}
                options={fragmentOptions}
                disabled={locked || preferences.container === 'webm'}
                ariaLabel="Duración de los fragmentos MP4"
              />
            </div>

            <div class="field">
              <div class="field-label-row">
                <span class="field-label">Audio</span>
              </div>
              <SelectField
                bind:value={preferences.audioBitrate}
                options={audioBitrateOptions}
                disabled={locked}
                ariaLabel="Bitrate del audio"
              />
            </div>
          </div>
          <p class="advanced-note">
            {preferences.container === 'mp4'
              ? 'La escritura es progresiva. Los fragmentos permiten recuperar el contenido si la sesión se interrumpe.'
              : 'La escritura es progresiva. El contenido ya escrito se conserva aunque la sesión se interrumpa.'}
          </p>
        </div>
      </div>
    </section>
  </div>

</aside>

<style>
  .settings-panel {
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: transparent;
    border: 0;
    border-left: 1px solid var(--border-soft);
  }

  .panel-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 22px 22px 18px;
  }

  h2 {
    font-size: 15px;
    font-weight: 620;
    letter-spacing: -0.025em;
  }

  .settings-body {
    display: flex;
    flex-direction: column;
    padding: 0 22px;
  }

  .section {
    padding: 18px 0;
    border-top: 1px solid var(--border-soft);
  }

  .section-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 13px;
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 570;
    letter-spacing: 0;
  }

  .source-ready {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--success);
    font-size: 10px;
    font-weight: 550;
    letter-spacing: 0;
  }

  .source-ready .dot {
    width: 5px;
    height: 5px;
    background: currentColor;
    border-radius: 50%;
  }

  .source-error {
    color: var(--danger);
    font-size: 10px;
    font-weight: 550;
    letter-spacing: 0;
  }

  .section-meta {
    color: var(--text-tertiary);
    font-size: 10.5px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  .source-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .source-copy {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  .source-label {
    overflow: hidden;
    color: var(--text);
    font-size: 13px;
    font-weight: 550;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .source-detail {
    overflow: hidden;
    color: var(--text-tertiary);
    font-size: 11.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .source-action {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    height: 30px;
    padding: 0 4px;
    flex: 0 0 auto;
    color: var(--primary-ink);
    background: transparent;
    border: 0;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 550;
    cursor: pointer;
    transition: color var(--fast);
  }

  .source-action:hover:not(:disabled) {
    color: var(--primary-hover);
  }

  .source-action:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 7px;
    margin-top: 14px;
  }

  .section-title + .field {
    margin-top: 0;
  }

  .field-label-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 16px;
  }

  .field-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text-secondary);
    font-size: 12.5px;
    font-weight: 520;
  }

  .toggle-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 16px;
  }

  .toggle-copy {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }

  .field-hint {
    color: var(--text-tertiary);
    font-size: 11px;
    line-height: 1.45;
  }

  .toggle-copy .field-label {
    color: var(--text);
    font-weight: 540;
  }

  .toggle-copy .field-hint {
    margin-top: 2px;
  }

  .inline-note {
    margin-top: 10px;
    padding: 0;
    color: var(--warning);
    font-size: 11px;
    line-height: 1.5;
  }

  .quality-options {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .quality-options button {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    height: 44px;
    padding: 0 5px;
    font-size: 11px;
  }

  .quality-options small {
    color: var(--text-tertiary);
    font-size: 10px;
    font-weight: 500;
  }

  .quality-options button.active small {
    color: var(--primary-ink);
  }

  .quality-hint {
    margin-top: 1px;
  }

  .split-field {
    display: grid;
    grid-template-columns: 1fr 1.15fr;
    gap: 10px;
    margin-top: 16px;
  }

  .split-item {
    display: flex;
    flex-direction: column;
    gap: 7px;
    min-width: 0;
  }

  .fps-options {
    grid-template-columns: 1fr 1fr;
  }

  .fps-options button {
    height: 40px;
  }

  .advanced {
    margin: 0 -22px;
    padding: 0 22px;
    border-top: 1px solid var(--border-soft);
  }

  .advanced-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    height: 50px;
    padding: 0;
    color: var(--text-tertiary);
    background: transparent;
    border: 0;
    font-size: 12px;
    font-weight: 550;
    cursor: pointer;
  }

  .advanced-toggle:hover {
    color: var(--text-secondary);
  }

  .advanced-toggle span {
    display: inline-flex;
    align-items: center;
    gap: 7px;
  }

  .advanced-chevron {
    display: inline-flex;
    transition: transform 180ms var(--ease);
  }

  .advanced-chevron.rotated {
    transform: rotate(180deg);
  }

  .advanced-collapse {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 200ms var(--ease);
  }

  .advanced-collapse.open {
    grid-template-rows: 1fr;
  }

  .advanced-inner {
    overflow: hidden;
  }

  .advanced-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    padding-top: 2px;
  }

  .advanced-grid .field {
    margin: 0;
  }

  .advanced-note {
    padding: 12px 0 18px;
    color: var(--text-tertiary);
    font-size: 10.5px;
    line-height: 1.5;
  }

  @media (max-width: 1040px) {
    .settings-panel {
      width: 100%;
      border-top: 1px solid var(--border-soft);
      border-left: 0;
    }

    .settings-body {
      display: grid;
      grid-template-columns: 1fr 1fr;
      column-gap: 26px;
    }

    .section:nth-of-type(3) {
      grid-column: 1 / -1;
    }

    .panel-heading {
      border-bottom: 1px solid var(--border-soft);
    }

    .section {
      border-top: 0;
      border-bottom: 1px solid var(--border-soft);
    }

    .advanced {
      grid-column: 1 / -1;
      margin: 0;
      padding: 0;
      border-bottom: 1px solid var(--border-soft);
    }
  }

  @media (max-width: 700px) {
    .settings-body {
      display: flex;
    }

    .section {
      border-bottom: 0;
      border-top: 1px solid var(--border-soft);
    }

    .advanced {
      margin: 0 -22px;
      padding: 0 22px;
      border-bottom: 0;
    }
  }
</style>
