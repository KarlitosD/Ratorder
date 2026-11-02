<script lang="ts">
  import {
    AlignCenter,
    AlignLeft,
    AlignRight,
    Clock3,
    Film,
    Image as ImageIcon,
    Layers,
    Save,
    Trash2,
    Volume2,
    VolumeX,
  } from '@lucide/svelte'
  import type { EditorController } from '../../editor/controller'
  import {
    layoutTimeline,
    MAX_VOLUME,
    SPEED_PRESETS,
  } from '../../editor/model'
  import type {
    EditorOverlay,
    EditorOverlayPatch,
    EditorSnapshot,
  } from '../../editor/types'
  import { formatBytes, formatDuration } from '../../utils/format'

  interface Props {
    snapshot: EditorSnapshot
    controller: EditorController
  }

  let { snapshot, controller }: Props = $props()

  const colors = [
    '#FFFFFF',
    '#4F7CF7',
    '#5AD1A3',
    '#E5B05A',
    '#F06B76',
    '#171A21',
  ]

  const MAX_STROKE = 40
  const TEXT_STROKE_DEFAULT = '#171A21'

  let project = $derived(snapshot.project)
  let views = $derived(project ? layoutTimeline(project) : [])
  let exportBusy = $derived(
    ['preparing', 'exporting', 'finalizing'].includes(
      snapshot.exportState.phase,
    ),
  )
  let selectedClip = $derived.by(() => {
    if (snapshot.selection?.type !== 'clip') return null
    return (
      views.find((view) => view.clip.id === snapshot.selection?.id) ?? null
    )
  })
  let selectedVolume = $derived(selectedClip?.clip.volume ?? 1)
  let selectedOverlay = $derived.by(() => {
    if (!project || snapshot.selection?.type !== 'overlay') return null
    return (
      project.overlays.find(
        (overlay) => overlay.id === snapshot.selection?.id,
      ) ?? null
    )
  })
  let assetsSize = $derived(
    project?.assets.reduce((total, asset) => total + asset.size, 0) ?? 0,
  )
  let imageAsset = $derived(
    selectedOverlay?.assetId
      ? project?.assets.find((asset) => asset.id === selectedOverlay?.assetId)
      : null,
  )
  let fillShape = $derived(
    selectedOverlay?.kind === 'rect' || selectedOverlay?.kind === 'ellipse',
  )
  let hasFill = $derived(selectedOverlay?.filled !== false)

  function patchOverlay(patch: EditorOverlayPatch, commit = false) {
    if (!selectedOverlay) return
    controller.updateOverlayLive(selectedOverlay.id, patch)
    if (commit) controller.commitInteraction()
  }

  function patchOverlayDiscrete(patch: EditorOverlayPatch) {
    if (!selectedOverlay) return
    controller.updateOverlayDiscrete(selectedOverlay.id, patch)
  }

  function setShapeFill(filled: boolean) {
    if (!selectedOverlay) return
    const patch: EditorOverlayPatch = { filled }
    if (!filled && selectedOverlay.strokeWidth <= 0) {
      patch.strokeWidth = Math.max(
        2,
        Math.round((project?.height ?? 720) * 0.005),
      )
    }
    patchOverlayDiscrete(patch)
  }

  function numberFrom(event: Event): number | null {
    const value = Number((event.currentTarget as HTMLInputElement).value)
    return Number.isFinite(value) ? value : null
  }

  function colorInputValue(value: string | undefined): string {
    const color = value?.trim() ?? ''
    if (/^#[0-9a-f]{6}$/i.test(color)) return color
    if (/^#[0-9a-f]{3}$/i.test(color)) {
      return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
    }
    return '#FFFFFF'
  }

  function overlayStrokeColor(overlay: EditorOverlay): string {
    if (overlay.strokeColor) return overlay.strokeColor
    return overlay.kind === 'text' ? TEXT_STROKE_DEFAULT : overlay.color
  }

  function percent(value: number): string {
    return String(Math.round(value * 100))
  }

  function seconds(value: number): string {
    return value.toFixed(2)
  }

  function shortTime(value: number): string {
    return formatDuration(value * 1000)
  }

  function overlayKindLabel(overlay: EditorOverlay): string {
    switch (overlay.kind) {
      case 'text':
        return 'Texto'
      case 'rect':
        return 'Rectángulo'
      case 'ellipse':
        return 'Elipse'
      case 'arrow':
        return 'Flecha'
      case 'image':
        return 'Imagen'
    }
  }
</script>

{#snippet borderControls(overlay: EditorOverlay)}
  <div class="field">
    <span>{overlay.kind === 'text'
      ? 'Borde del texto'
      : overlay.kind === 'arrow'
        ? 'Grosor'
        : 'Borde'}</span>
    <div class="stroke-controls">
      {#if overlay.kind !== 'arrow'}
        <label
          class="color-picker"
          style={`--picker-color: ${colorInputValue(overlayStrokeColor(overlay))}`}
          title="Elegir color del borde"
        >
          <input
            type="color"
            value={colorInputValue(overlayStrokeColor(overlay))}
            aria-label={overlay.kind === 'text'
              ? 'Color del borde del texto'
              : 'Color del borde'}
            disabled={exportBusy}
            oninput={(event) =>
              patchOverlay({
                strokeColor: (event.currentTarget as HTMLInputElement).value,
              })}
            onchange={() => controller.commitInteraction()}
          />
        </label>
        <input
          class="hex-input"
          type="text"
          maxlength="7"
          value={overlayStrokeColor(overlay)}
          aria-label="Color hexadecimal del borde"
          disabled={exportBusy}
          onchange={(event) =>
            patchOverlayDiscrete({
              strokeColor: (event.currentTarget as HTMLInputElement).value,
            })}
        />
      {/if}
      <input
        class="stroke-range"
        type="range"
        min="0"
        max={MAX_STROKE}
        step="1"
        aria-label="Grosor del borde"
        disabled={exportBusy}
        value={overlay.strokeWidth}
        oninput={(event) => {
          const value = numberFrom(event)
          if (value !== null) patchOverlay({ strokeWidth: value })
        }}
        onchange={() => controller.commitInteraction()}
      />
      <input
        class="stroke-number"
        type="number"
        min="0"
        step="1"
        aria-label="Grosor exacto del borde"
        disabled={exportBusy}
        value={overlay.strokeWidth}
        oninput={(event) => {
          const value = numberFrom(event)
          if (value !== null) patchOverlay({ strokeWidth: value })
        }}
        onchange={() => controller.commitInteraction()}
      />
    </div>
  </div>
{/snippet}

<aside class="inspector" aria-label="Propiedades de la edición">
  {#if selectedOverlay}
    <section class="inspector-section">
      <header class="section-head">
        <span class="section-kicker">Elemento</span>
        <span class="section-title">{overlayKindLabel(selectedOverlay)}</span>
        <button
          type="button"
          class="icon-button section-delete"
          aria-label="Eliminar elemento"
          title="Eliminar elemento"
          disabled={exportBusy}
          onclick={() => controller.removeSelectedOverlay()}
        >
          <Trash2 size={14} strokeWidth={1.9} />
        </button>
      </header>

      <div class="field-grid two">
        <label class="field">
          <span>Inicio</span>
          <input
            type="number"
            min="0"
            step="0.1"
            disabled={exportBusy}
            value={seconds(selectedOverlay.start)}
            oninput={(event) => {
              const value = numberFrom(event)
              if (value !== null) patchOverlay({ start: value })
            }}
            onchange={() => controller.commitInteraction()}
          />
        </label>
        <label class="field">
          <span>Fin</span>
          <input
            type="number"
            min="0"
            step="0.1"
            disabled={exportBusy}
            value={seconds(selectedOverlay.end)}
            oninput={(event) => {
              const value = numberFrom(event)
              if (value !== null) patchOverlay({ end: value })
            }}
            onchange={() => controller.commitInteraction()}
          />
        </label>
      </div>

      <div class="field-grid two">
        <label class="field">
          <span>X</span>
          <div class="input-suffix">
            <input
              type="number"
              min="0"
              max="100"
              step="1"
              disabled={exportBusy}
              value={percent(selectedOverlay.x)}
              oninput={(event) => {
                const value = numberFrom(event)
                if (value !== null) patchOverlay({ x: value / 100 })
              }}
              onchange={() => controller.commitInteraction()}
            />
            <span>%</span>
          </div>
        </label>
        <label class="field">
          <span>Y</span>
          <div class="input-suffix">
            <input
              type="number"
              min="0"
              max="100"
              step="1"
              disabled={exportBusy}
              value={percent(selectedOverlay.y)}
              oninput={(event) => {
                const value = numberFrom(event)
                if (value !== null) patchOverlay({ y: value / 100 })
              }}
              onchange={() => controller.commitInteraction()}
            />
            <span>%</span>
          </div>
        </label>
        <label class="field">
          <span>Ancho</span>
          <div class="input-suffix">
            <input
              type="number"
              min="1"
              max="100"
              step="1"
              disabled={exportBusy}
              value={percent(selectedOverlay.width)}
              oninput={(event) => {
                const value = numberFrom(event)
                if (value !== null) patchOverlay({ width: value / 100 })
              }}
              onchange={() => controller.commitInteraction()}
            />
            <span>%</span>
          </div>
        </label>
        <label class="field">
          <span>Alto</span>
          <div class="input-suffix">
            <input
              type="number"
              min="1"
              max="100"
              step="1"
              disabled={exportBusy}
              value={percent(selectedOverlay.height)}
              oninput={(event) => {
                const value = numberFrom(event)
                if (value !== null) patchOverlay({ height: value / 100 })
              }}
              onchange={() => controller.commitInteraction()}
            />
            <span>%</span>
          </div>
        </label>
      </div>

      {#if fillShape}
        <div class="field">
          <span>Relleno</span>
          <div class="segmented">
            <button
              type="button"
              class:active={hasFill}
              disabled={exportBusy}
              onclick={() => setShapeFill(true)}
            >
              Con relleno
            </button>
            <button
              type="button"
              class:active={!hasFill}
              disabled={exportBusy}
              onclick={() => setShapeFill(false)}
            >
              Sin relleno
            </button>
          </div>
        </div>
      {/if}

      {#if !fillShape || hasFill}
        <label class="field">
          <span>{fillShape ? 'Opacidad del relleno' : 'Opacidad'}</span>
          <div class="input-suffix">
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              disabled={exportBusy}
              value={percent(selectedOverlay.opacity)}
              oninput={(event) => {
                const value = numberFrom(event)
                if (value !== null) patchOverlay({ opacity: value / 100 })
              }}
              onchange={() => controller.commitInteraction()}
            />
            <span>{percent(selectedOverlay.opacity)}%</span>
          </div>
        </label>

        <div class="field">
          <span>{selectedOverlay.kind === 'text'
            ? 'Color del texto'
            : fillShape
              ? 'Color del relleno'
              : 'Color'}</span>
          <div class="swatches">
            {#each colors as color}
              <button
                type="button"
                class="swatch"
                class:active={selectedOverlay.color.toLowerCase() === color.toLowerCase()}
                style:background={color}
                aria-label={`Usar color ${color}`}
                disabled={exportBusy}
                onclick={() => patchOverlayDiscrete({ color })}
              ></button>
            {/each}
            <label
              class="color-picker"
              style={`--picker-color: ${colorInputValue(selectedOverlay.color)}`}
              title="Elegir un color personalizado"
            >
              <input
                type="color"
                value={colorInputValue(selectedOverlay.color)}
                aria-label="Selector de color personalizado"
                disabled={exportBusy}
                oninput={(event) =>
                  patchOverlay({
                    color: (event.currentTarget as HTMLInputElement).value,
                  })}
                onchange={() => controller.commitInteraction()}
              />
            </label>
            <input
              class="hex-input"
              type="text"
              maxlength="7"
              value={selectedOverlay.color}
              aria-label="Color hexadecimal"
              disabled={exportBusy}
              onchange={(event) =>
                patchOverlayDiscrete({
                  color: (event.currentTarget as HTMLInputElement).value,
                })}
            />
          </div>
        </div>
      {/if}

      {#if selectedOverlay.kind === 'rect'}
        <label class="field">
          <span>Radio</span>
          <input
            type="number"
            min="0"
            step="1"
            disabled={exportBusy}
            value={selectedOverlay.radius}
            oninput={(event) => {
              const value = numberFrom(event)
              if (value !== null) patchOverlay({ radius: value })
            }}
            onchange={() => controller.commitInteraction()}
          />
        </label>
      {/if}

      {#if selectedOverlay.kind === 'rect' || selectedOverlay.kind === 'ellipse' || selectedOverlay.kind === 'arrow'}
        {@render borderControls(selectedOverlay)}
      {/if}

      {#if selectedOverlay.kind === 'text'}
        <label class="field">
          <span>Texto</span>
          <textarea
            rows="3"
            disabled={exportBusy}
            value={selectedOverlay.text ?? ''}
            oninput={(event) =>
              patchOverlay({
                text: (event.currentTarget as HTMLTextAreaElement).value,
              })}
            onblur={() => controller.commitInteraction()}
          ></textarea>
        </label>
        <div class="field-grid two">
          <label class="field">
            <span>Tamaño</span>
            <input
              type="number"
              min="8"
              max="400"
              step="1"
              disabled={exportBusy}
              value={selectedOverlay.fontSize ?? 64}
              oninput={(event) => {
                const value = numberFrom(event)
                if (value !== null) patchOverlay({ fontSize: value })
              }}
              onchange={() => controller.commitInteraction()}
            />
          </label>
          <div class="field">
            <span>Peso</span>
            <div class="segmented">
              {#each [400, 600, 800] as weight}
                <button
                  type="button"
                  class:active={(selectedOverlay.fontWeight ?? 600) === weight}
                  disabled={exportBusy}
                  onclick={() => patchOverlayDiscrete({ fontWeight: weight })}
                >
                  {weight}
                </button>
              {/each}
            </div>
          </div>
        </div>
        <div class="field">
          <span>Alineación</span>
          <div class="segmented icons">
            {#each [
              { value: 'left', icon: AlignLeft, label: 'Izquierda' },
              { value: 'center', icon: AlignCenter, label: 'Centro' },
              { value: 'right', icon: AlignRight, label: 'Derecha' },
            ] as option}
              {@const Icon = option.icon}
              <button
                type="button"
                class:active={(selectedOverlay.align ?? 'left') === option.value}
                aria-label={option.label}
                disabled={exportBusy}
                onclick={() =>
                  patchOverlayDiscrete({
                    align: option.value as 'left' | 'center' | 'right',
                  })}
              >
                <Icon size={13} strokeWidth={1.9} />
              </button>
            {/each}
          </div>
        </div>
        {@render borderControls(selectedOverlay)}
      {/if}

      {#if selectedOverlay.kind === 'image' && imageAsset}
        <div class="media-note">
          <ImageIcon size={14} strokeWidth={1.8} />
          <div>
            <strong>{imageAsset.name}</strong>
            <span>{imageAsset.width} × {imageAsset.height} · {formatBytes(imageAsset.size)}</span>
          </div>
        </div>
      {/if}
    </section>
  {:else if selectedClip}
    <section class="inspector-section">
      <header class="section-head">
        <span class="section-kicker">Segmento</span>
        <span class="section-title">{selectedClip.mediaName}</span>
      </header>

      <dl class="clip-details">
        <div>
          <dt><Clock3 size={12} strokeWidth={1.8} /> En el origen</dt>
          <dd>{shortTime(selectedClip.clip.inPoint)} – {shortTime(selectedClip.clip.inPoint + selectedClip.clip.sourceSpan)}</dd>
        </div>
        <div>
          <dt><Film size={12} strokeWidth={1.8} /> En la timeline</dt>
          <dd>{shortTime(selectedClip.start)} – {shortTime(selectedClip.end)}</dd>
        </div>
      </dl>

      <div class="field">
        <span>Velocidad</span>
        <div class="speed-presets">
          {#each SPEED_PRESETS as speed}
            <button
              type="button"
              class:active={Math.abs(selectedClip.clip.speed - speed) < 0.001}
              disabled={exportBusy}
              onclick={() => controller.setSelectedSpeed(speed)}
            >
              {speed}×
            </button>
          {/each}
        </div>
      </div>

      <div class="field">
        <span>
          Volumen
          {#if selectedClip.clip.muted}
            <em class="muted-tag">Silenciado</em>
          {:else if selectedVolume <= 0}
            <em class="muted-tag">Sin audio</em>
          {/if}
        </span>
        <div class="input-suffix volume-control">
          {#if selectedClip.clip.muted || selectedVolume <= 0}
            <VolumeX size={14} strokeWidth={1.9} />
          {:else}
            <Volume2 size={14} strokeWidth={1.9} />
          {/if}
          <input
            type="range"
            min="0"
            max={Math.round(MAX_VOLUME * 100)}
            step="1"
            aria-label="Volumen del segmento"
            disabled={exportBusy}
            value={Math.round(selectedVolume * 100)}
            oninput={(event) => {
              const value = numberFrom(event)
              if (value !== null) {
                controller.setSelectedVolumeLive(value / 100)
              }
            }}
            onchange={() => controller.commitInteraction()}
          />
          <span class="volume-value">{Math.round(selectedVolume * 100)}%</span>
        </div>
      </div>
    </section>
  {:else}
    <section class="inspector-section inspector-hint">
      <Layers size={18} strokeWidth={1.8} />
      <p>Selecciona un segmento o un elemento para ajustar sus propiedades.</p>
      <span>Consejo: haz clic en el video para mover o redimensionar imágenes, formas y texto.</span>
    </section>
  {/if}

  {#if project}
    <section class="inspector-section project-section">
      <header class="section-head">
        <span class="section-kicker">Proyecto</span>
        <span class="section-title">Datos de salida</span>
      </header>
      <dl class="project-details">
        <div><dt>Resolución</dt><dd>{project.width} × {project.height}</dd></div>
        <div><dt>Fotogramas</dt><dd>{project.fps} FPS</dd></div>
        <div><dt>Formato</dt><dd>{project.container.toUpperCase()}</dd></div>
        <div><dt>Duración</dt><dd>{formatDuration(snapshot.duration * 1000)}</dd></div>
        <div><dt>Medios</dt><dd>{project.assets.length + 1}</dd></div>
        <div><dt>Espacio</dt><dd>{formatBytes(assetsSize)}</dd></div>
      </dl>
      <div class="save-note">
        <Save size={13} strokeWidth={1.8} />
        <span>El proyecto se guarda solo al pulsar Guardar.</span>
      </div>
    </section>
  {/if}
</aside>

<style>
  .inspector {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 0;
    padding: 6px 0 0;
    overflow-y: auto;
    background: var(--surface);
    border-left: 1px solid var(--border-soft);
    scrollbar-width: thin;
  }

  .inspector-section {
    padding: 14px 16px 16px;
    border-bottom: 1px solid var(--border-soft);
  }

  .inspector-section:last-child {
    border-bottom: 0;
  }

  .section-head {
    display: flex;
    align-items: center;
    gap: 7px;
    min-height: 20px;
    margin-bottom: 12px;
  }

  .section-kicker {
    color: var(--text-tertiary);
    font-size: 8.5px;
    font-weight: 650;
    letter-spacing: 0.075em;
    text-transform: uppercase;
  }

  .section-title {
    overflow: hidden;
    color: var(--text);
    font-size: 11.5px;
    font-weight: 570;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .section-delete {
    width: 26px;
    height: 26px;
    margin-left: auto;
    flex: 0 0 auto;
  }

  .section-delete:hover:not(:disabled) {
    color: var(--danger);
    background: var(--danger-soft);
    border-color: var(--danger-border);
  }

  .field-grid {
    display: grid;
    gap: 8px;
  }

  .field-grid.two {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .field {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 5px;
    margin-bottom: 9px;
  }

  .field > span {
    color: var(--text-tertiary);
    font-size: 9.5px;
    font-weight: 550;
    letter-spacing: 0.01em;
  }

  .field input[type='number'],
  .field input[type='text'],
  .field textarea,
  .hex-input {
    width: 100%;
    min-width: 0;
    height: 30px;
    padding: 0 8px;
    color: var(--text);
    background: var(--surface-inset);
    border: 1px solid var(--border);
    border-radius: 6px;
    outline: none;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .field textarea {
    height: auto;
    min-height: 58px;
    padding: 7px 8px;
    resize: vertical;
    font-family: inherit;
    line-height: 1.45;
  }

  .field input:focus,
  .field textarea:focus,
  .hex-input:focus {
    border-color: var(--primary-border);
    box-shadow: 0 0 0 2px var(--primary-soft);
  }

  .input-suffix {
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .input-suffix span {
    flex: 0 0 auto;
    color: var(--text-tertiary);
    font-size: 9.5px;
    font-variant-numeric: tabular-nums;
  }

  .input-suffix input[type='range'] {
    width: 100%;
    min-width: 0;
    accent-color: var(--primary);
  }

  .swatches {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }

  .swatch {
    width: 22px;
    height: 22px;
    padding: 0;
    flex: 0 0 auto;
    border: 1px solid var(--border-strong);
    border-radius: 5px;
    cursor: pointer;
  }

  .swatch.active {
    outline: 2px solid var(--primary);
    outline-offset: 1px;
  }

  .field input.hex-input {
    width: 64px;
    height: 24px;
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 9.5px;
  }

  .color-picker {
    position: relative;
    width: 22px;
    height: 22px;
    flex: 0 0 auto;
    overflow: hidden;
    background:
      linear-gradient(
          var(--picker-color, #ffffff),
          var(--picker-color, #ffffff)
        )
        padding-box,
      conic-gradient(
          from 0deg,
          #f06b76,
          #e5b05a,
          #5ad1a3,
          #4f7cf7,
          #b37cf7,
          #f06b76
        )
        border-box;
    border: 2px solid transparent;
    border-radius: 5px;
    cursor: pointer;
  }

  .color-picker input[type='color'] {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    padding: 0;
    background: transparent;
    border: 0;
    cursor: pointer;
    opacity: 0;
  }

  .color-picker:hover {
    filter: brightness(1.08);
  }

  .color-picker:focus-within {
    outline: 2px solid var(--primary);
    outline-offset: 1px;
  }

  .color-picker:has(input:disabled) {
    cursor: default;
    opacity: 0.5;
  }

  .stroke-controls {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .stroke-controls input.hex-input {
    width: 74px;
    height: 24px;
    margin-left: 0;
    flex: 0 0 auto;
  }

  .stroke-controls input[type='range'] {
    width: 100%;
    min-width: 0;
    flex: 1 1 auto;
    accent-color: var(--primary);
  }

  .field input.stroke-number {
    width: 40px;
    height: 24px;
    padding: 0 3px;
    flex: 0 0 40px;
    text-align: center;
  }

  .segmented {
    display: flex;
    gap: 2px;
    padding: 2px;
    background: var(--surface-inset);
    border: 1px solid var(--border-soft);
    border-radius: 6px;
  }

  .segmented button {
    flex: 1;
    height: 25px;
    padding: 0 4px;
    color: var(--text-tertiary);
    background: transparent;
    border: 0;
    border-radius: 4px;
    font-size: 9.5px;
    cursor: pointer;
  }

  .segmented.icons button {
    display: grid;
    place-items: center;
  }

  .segmented button.active {
    color: var(--text);
    background: var(--surface-active);
  }

  .speed-presets {
    display: flex;
    gap: 3px;
    flex-wrap: wrap;
  }

  .speed-presets button {
    height: 27px;
    padding: 0 7px;
    color: var(--text-tertiary);
    background: var(--surface-inset);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-family: var(--font-mono);
    font-size: 9.5px;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }

  .speed-presets button.active {
    color: var(--primary-ink);
    background: var(--primary-soft);
    border-color: var(--primary-border);
  }

  .speed-presets button:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--border-strong);
  }

  .muted-tag {
    margin-left: 5px;
    color: var(--warning);
    font-style: normal;
    font-weight: 550;
  }

  .volume-control {
    gap: 7px;
  }

  .volume-control :global(svg) {
    flex: 0 0 auto;
    color: var(--text-tertiary);
  }

  .volume-value {
    width: 31px;
    text-align: right;
    color: var(--text-secondary) !important;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }

  .clip-details {
    display: flex;
    flex-direction: column;
    gap: 7px;
    margin: 0 0 13px;
  }

  .clip-details div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .clip-details dt {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--text-tertiary);
    font-size: 9.5px;
    white-space: nowrap;
  }

  .clip-details dd {
    overflow: hidden;
    margin: 0;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 9.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .media-note {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
    padding: 8px 9px;
    color: var(--text-tertiary);
    background: var(--surface-inset);
    border: 1px solid var(--border-soft);
    border-radius: 7px;
  }

  .media-note div {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
  }

  .media-note strong {
    overflow: hidden;
    color: var(--text-secondary);
    font-size: 10px;
    font-weight: 550;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .media-note span {
    font-family: var(--font-mono);
    font-size: 8.5px;
    font-variant-numeric: tabular-nums;
  }

  .inspector-hint {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    color: var(--text-tertiary);
  }

  .inspector-hint p {
    color: var(--text-secondary);
    font-size: 11px;
    line-height: 1.5;
  }

  .inspector-hint span {
    font-size: 9.5px;
    line-height: 1.5;
  }

  .project-section {
    margin-top: auto;
  }

  .project-details {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 9px 12px;
    margin: 0;
  }

  .project-details div {
    min-width: 0;
  }

  .project-details dt {
    color: var(--text-tertiary);
    font-size: 8.5px;
    letter-spacing: 0.02em;
  }

  .project-details dd {
    overflow: hidden;
    margin: 2px 0 0;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 9.5px;
    font-variant-numeric: tabular-nums;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .save-note {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 13px;
    padding-top: 11px;
    color: var(--text-tertiary);
    border-top: 1px solid var(--border-soft);
    font-size: 9px;
    line-height: 1.45;
  }

  @media (max-width: 980px) {
    .inspector {
      border-top: 1px solid var(--border-soft);
      border-left: 0;
    }

    .inspector-section {
      padding: 12px 14px 14px;
    }
  }
</style>
