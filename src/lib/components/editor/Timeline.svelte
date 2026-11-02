<script lang="ts">
  import { onMount } from 'svelte'
  import {
    ArrowUpRight,
    Circle,
    Image as ImageIcon,
    Minus,
    Plus,
    Square,
    Type,
    VolumeX,
  } from '@lucide/svelte'
  import type { EditorController } from '../../editor/controller'
  import {
    clamp,
    layoutTimeline,
    MAX_VOLUME,
    trimClip,
    visibleTicks,
  } from '../../editor/model'
  import type {
    EditorContextMenuState,
    EditorOverlay,
    EditorOverlayKind,
    EditorProject,
    EditorSnapshot,
    TimelineClipView,
  } from '../../editor/types'

  interface Props {
    snapshot: EditorSnapshot
    controller: EditorController
    onContextMenu: (state: EditorContextMenuState) => void
  }

  let { snapshot, controller, onContextMenu }: Props = $props()

  let scroller = $state<HTMLDivElement | null>(null)
  let content = $state<HTMLDivElement | null>(null)
  let waveCanvas = $state<HTMLCanvasElement | null>(null)
  let didFit = $state(false)
  // Viewport para virtualizar ticks y rasterizar la waveform visible.
  let scrollLeft = $state(0)
  let viewportWidth = $state(0)
  let waveRaf = 0

  const AUDIO_TRACK_HEIGHT = 52

  let project = $derived(snapshot.project)
  let duration = $derived(snapshot.duration)
  let pps = $derived(Math.max(1, snapshot.zoom))
  let views = $derived(project ? layoutTimeline(project) : [])
  let contentWidth = $derived(Math.max(1, duration * pps + 8))
  let exportBusy = $derived(
    ['preparing', 'exporting', 'finalizing'].includes(
      snapshot.exportState.phase,
    ),
  )

  let tickStep = $derived.by(() => {
    if (pps >= 80) return 1
    if (pps >= 40) return 2
    if (pps >= 20) return 5
    if (pps >= 8) return 10
    return 30
  })
  let ticks = $derived.by(() => {
    return visibleTicks(duration, pps, tickStep, scrollLeft, viewportWidth)
  })
  let overlayLayout = $derived.by(() => {
    const lanes: number[] = []
    const rows: Array<{ overlay: EditorOverlay; lane: number }> = []
    for (const overlay of [...(project?.overlays ?? [])].sort(
      (left, right) => left.start - right.start,
    )) {
      let lane = lanes.findIndex((end) => end <= overlay.start + 1e-6)
      if (lane < 0) {
        lane = lanes.length
        lanes.push(overlay.end)
      } else {
        lanes[lane] = overlay.end
      }
      rows.push({ overlay, lane })
    }
    return { rows, laneCount: Math.max(1, lanes.length) }
  })
  let overlayTrackHeight = $derived(6 + overlayLayout.laneCount * 28)
  let audioState = $derived.by(() => {
    if (!project) return null
    if (project.clips.length === 0) return null
    let hasAudioMedia = false
    let loading = false
    let hasBins = false
    const mediaIds = new Set(project.clips.map((clip) => clip.mediaId))
    for (const mediaId of mediaIds) {
      const mediaHasAudio =
        mediaId === 'source'
          ? project.source.hasAudio
          : (project.assets.find((asset) => asset.id === mediaId)?.hasAudio ??
            false)
      if (!mediaHasAudio) continue
      hasAudioMedia = true
      const waveform = snapshot.waveforms[mediaId]
      if (!waveform || waveform.loading) {
        loading = true
      } else if (waveform.bins.length > 0) {
        hasBins = true
      }
    }
    if (!hasAudioMedia) return 'Sin audio'
    if (loading && !hasBins) return 'Analizando audio…'
    if (!loading && !hasBins) return 'Sin audio disponible'
    return null
  })

  let lastWaveSignature = ''
  let lastWaveSize = ''
  // Solo rango, zoom, tamaño/DPR, bins y props de audio invalidan el audio;
  // ni el playhead ni ediciones de texto/forma repintan la waveform.
  $effect(() => {
    const clipsKey =
      snapshot.project?.clips
        .map(
          (clip) =>
            `${clip.id}:${clip.mediaId}:${clip.inPoint.toFixed(4)}:${clip.sourceSpan.toFixed(4)}:${clip.speed}:${clip.volume ?? 1}:${clip.muted ? 1 : 0}`,
        )
        .join('|') ?? ''
    const key = `${snapshot.waveformRevision}|${snapshot.zoom}|${contentWidth}|${Math.round(scrollLeft)}|${Math.round(viewportWidth)}|${clipsKey}`
    if (key === lastWaveSignature) return
    lastWaveSignature = key
    if (waveRaf) cancelAnimationFrame(waveRaf)
    waveRaf = requestAnimationFrame(() => {
      waveRaf = 0
      drawWaveforms()
    })
  })

  function drawWaveforms() {
    const canvas = waveCanvas
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    const width = Math.max(1, viewportWidth || scroller?.clientWidth || 1)
    const margin = 80
    const visibleLeft = Math.max(0, scrollLeft - margin)
    const visibleRight = Math.min(
      contentWidth,
      scrollLeft + width + margin,
    )
    const span = Math.max(1, visibleRight - visibleLeft)
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const backingWidth = Math.round(span * dpr)
    const backingHeight = Math.round(AUDIO_TRACK_HEIGHT * dpr)
    const sizeKey = `${backingWidth}x${backingHeight}`
    // No cambiar el backing store si no cambió su tamaño.
    if (lastWaveSize !== sizeKey) {
      canvas.width = backingWidth
      canvas.height = backingHeight
      lastWaveSize = sizeKey
    }
    // Posiciona el canvas sobre el rango visible con un pequeño margen.
    canvas.style.left = `${visibleLeft}px`
    canvas.style.width = `${span}px`
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, span, AUDIO_TRACK_HEIGHT)
    const center = AUDIO_TRACK_HEIGHT / 2
    context.strokeStyle = 'rgba(130, 137, 150, 0.24)'
    context.lineWidth = 1
    context.beginPath()
    context.moveTo(0, center + 0.5)
    context.lineTo(span, center + 0.5)
    context.stroke()

    for (const view of views) {
      if (view.end * 1 < visibleLeft / pps || view.start > visibleRight / pps) {
        continue
      }
      const waveform = snapshot.waveforms[view.clip.mediaId]
      if (!waveform || waveform.bins.length === 0 || waveform.duration <= 0) {
        continue
      }
      const startX = view.start * pps - visibleLeft
      const endX = view.end * pps - visibleLeft
      const drawStart = Math.max(0, Math.floor(startX))
      const drawEnd = Math.min(span, Math.ceil(endX))
      const clipWidth = endX - startX
      if (drawEnd <= drawStart || clipWidth <= 0) continue
      const gain = view.clip.muted
        ? 0
        : Math.min(MAX_VOLUME, view.clip.volume ?? 1)
      const silent = gain <= 0
      context.fillStyle = silent
        ? 'rgba(130, 137, 150, 0.42)'
        : 'rgba(79, 124, 247, 0.92)'
      const halfHeight = center - 4
      for (let x = drawStart; x < drawEnd; x += 1) {
        const ratio = clamp((x - startX) / clipWidth, 0, 1)
        const sourceTime = view.clip.inPoint + ratio * view.clip.sourceSpan
        const bin = Math.min(
          waveform.bins.length - 1,
          Math.max(
            0,
            Math.floor(
              (sourceTime / waveform.duration) * waveform.bins.length,
            ),
          ),
        )
        const rms = Math.max(0, waveform.bins[bin] ?? 0)
        const level = silent
          ? Math.min(1, Math.sqrt(rms) * 0.72)
          : Math.min(1, Math.sqrt(rms * gain) * 1.3)
        const height = Math.max(0.5, level * halfHeight)
        if (level < 0.002) continue
        context.fillRect(x, center - height, 1, height * 2)
      }
    }
  }

  interface TrimDrag {
    clipId: string
    edge: 'start' | 'end'
    startX: number
    startProject: EditorProject
  }

  interface OverlayDrag {
    overlay: EditorOverlay
    startX: number
    startProject: EditorProject
  }

  let trimDrag: TrimDrag | null = null
  let overlayDrag: OverlayDrag | null = null
  let scrubbing = $state(false)

  onMount(() => {
    const updateViewport = () => {
      if (!scroller) return
      scrollLeft = scroller.scrollLeft
      viewportWidth = scroller.clientWidth
    }
    updateViewport()
    const observer =
      typeof ResizeObserver !== 'undefined' && scroller
        ? new ResizeObserver(updateViewport)
        : null
    if (observer && scroller) observer.observe(scroller)
    const onScroll = () => {
      if (!scroller) return
      scrollLeft = scroller.scrollLeft
    }
    scroller?.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', updateViewport)
    return () => {
      stopTrim()
      stopOverlayDrag()
      stopScrub()
      observer?.disconnect()
      scroller?.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', updateViewport)
      if (waveRaf) cancelAnimationFrame(waveRaf)
    }
  })

  $effect(() => {
    if (didFit || !scroller || snapshot.status !== 'ready' || duration <= 0) {
      return
    }
    didFit = true
    fit()
  })

  $effect(() => {
    const playhead = snapshot.playhead
    const zoom = snapshot.zoom
    const playing = snapshot.playing
    if (!playing || !scroller) return
    const x = playhead * zoom
    const left = scroller.scrollLeft
    const width = scroller.clientWidth
    if (x < left + 48 || x > left + width - 96) {
      scroller.scrollLeft = Math.max(0, x - width * 0.4)
    }
  })

  function fit() {
    if (!scroller) return
    const width = Math.max(280, scroller.clientWidth - 32)
    controller.setZoom(
      duration > 0 ? clamp(width / duration, 12, 240) : 80,
    )
  }

  function zoomBy(factor: number) {
    controller.setZoom(pps * factor)
  }

  function timeAt(clientX: number): number {
    if (!content) return 0
    const rect = content.getBoundingClientRect()
    return clamp((clientX - rect.left) / pps, 0, duration)
  }

  function beginScrub(event: PointerEvent) {
    if (
      event.button !== 0 ||
      !content ||
      duration <= 0 ||
      exportBusy
    ) {
      return
    }
    event.preventDefault()
    scrubbing = true
    controller.seek(timeAt(event.clientX))
    window.addEventListener('pointermove', onScrubMove)
    window.addEventListener('pointerup', stopScrub, { once: true })
  }

  function onScrubMove(event: PointerEvent) {
    if (!scrubbing) return
    controller.seek(timeAt(event.clientX))
  }

  function stopScrub() {
    scrubbing = false
    window.removeEventListener('pointermove', onScrubMove)
    window.removeEventListener('pointerup', stopScrub)
  }

  function beginTrim(
    event: PointerEvent,
    clipId: string,
    edge: 'start' | 'end',
  ) {
    if (event.button !== 0 || !project || exportBusy) return
    event.preventDefault()
    event.stopPropagation()
    trimDrag = {
      clipId,
      edge,
      startX: event.clientX,
      startProject: project,
    }
    controller.selectClip(clipId)
    window.addEventListener('pointermove', onTrimMove)
    window.addEventListener('pointerup', stopTrim, { once: true })
  }

  function onTrimMove(event: PointerEvent) {
    if (!trimDrag) return
    const delta = (event.clientX - trimDrag.startX) / pps
    controller.updateProjectLive(
      trimClip(
        trimDrag.startProject,
        trimDrag.clipId,
        trimDrag.edge,
        delta,
      ),
    )
  }

  function stopTrim() {
    if (!trimDrag) return
    trimDrag = null
    window.removeEventListener('pointermove', onTrimMove)
    window.removeEventListener('pointerup', stopTrim)
    controller.commitInteraction()
  }

  function beginOverlayDrag(event: PointerEvent, overlay: EditorOverlay) {
    if (event.button !== 0 || !project || exportBusy) return
    event.preventDefault()
    event.stopPropagation()
    overlayDrag = {
      overlay: { ...overlay },
      startX: event.clientX,
      startProject: project,
    }
    controller.selectOverlay(overlay.id)
    window.addEventListener('pointermove', onOverlayMove)
    window.addEventListener('pointerup', stopOverlayDrag, { once: true })
  }

  function onOverlayMove(event: PointerEvent) {
    if (!overlayDrag) return
    const span = overlayDrag.overlay.end - overlayDrag.overlay.start
    const delta = (event.clientX - overlayDrag.startX) / pps
    const start = clamp(overlayDrag.overlay.start + delta, 0, duration - span)
    controller.updateOverlayLive(overlayDrag.overlay.id, {
      start,
      end: start + span,
    })
  }

  function stopOverlayDrag() {
    if (!overlayDrag) return
    overlayDrag = null
    window.removeEventListener('pointermove', onOverlayMove)
    window.removeEventListener('pointerup', stopOverlayDrag)
    controller.commitInteraction()
  }

  function openClipContext(event: MouseEvent, clipId: string) {
    if (exportBusy) return
    event.preventDefault()
    event.stopPropagation()
    controller.selectClip(clipId)
    onContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: { kind: 'clip', clipId, time: timeAt(event.clientX) },
    })
  }

  function openOverlayContext(event: MouseEvent, overlayId: string) {
    if (exportBusy) return
    event.preventDefault()
    event.stopPropagation()
    controller.selectOverlay(overlayId)
    onContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: {
        kind: 'overlay',
        overlayId,
        time: timeAt(event.clientX),
      },
    })
  }

  function openTimelineContext(event: MouseEvent) {
    if (exportBusy) return
    event.preventDefault()
    event.stopPropagation()
    onContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: { kind: 'timeline', time: timeAt(event.clientX) },
    })
  }

  function shortTime(seconds: number): string {
    const safe = Math.max(0, seconds)
    const hours = Math.floor(safe / 3600)
    const minutes = Math.floor((safe % 3600) / 60)
    const rest = Math.floor(safe % 60)
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
      : `${minutes}:${String(rest).padStart(2, '0')}`
  }

  function clipLabel(view: TimelineClipView): string {
    const speed = view.clip.speed
    return `${view.mediaName}${speed !== 1 ? ` · ${speed}×` : ''}`
  }

  function overlayLabel(overlay: EditorOverlay): string {
    if (overlay.kind === 'text') return overlay.text?.trim() || 'Texto'
    if (overlay.kind === 'image') {
      const asset = project?.assets.find((item) => item.id === overlay.assetId)
      return asset?.name ?? 'Imagen'
    }
    if (overlay.kind === 'rect') return 'Rectángulo'
    if (overlay.kind === 'ellipse') return 'Elipse'
    return 'Flecha'
  }

  function overlayIcon(kind: EditorOverlayKind) {
    if (kind === 'text') return Type
    if (kind === 'image') return ImageIcon
    if (kind === 'ellipse') return Circle
    if (kind === 'rect') return Square
    return ArrowUpRight
  }
</script>

<section class="timeline" aria-label="Línea de tiempo de la edición">
  <header class="timeline-head">
    <div class="timeline-heading">
      <h2>Línea de tiempo</h2>
      <span>{shortTime(duration)}</span>
    </div>
    <div class="zoom-controls">
      <button
        type="button"
        class="icon-button tiny"
        aria-label="Alejar línea de tiempo"
        disabled={pps <= 12}
        onclick={() => zoomBy(0.75)}
      >
        <Minus size={13} strokeWidth={2} />
      </button>
      <button type="button" class="fit-button" onclick={fit}>
        Ajustar
      </button>
      <button
        type="button"
        class="icon-button tiny"
        aria-label="Acercar línea de tiempo"
        disabled={pps >= 240}
        onclick={() => zoomBy(1.33)}
      >
        <Plus size={13} strokeWidth={2} />
      </button>
    </div>
  </header>

  <div class="timeline-body">
    <div class="track-labels" aria-hidden="true">
      <span class="ruler-spacer"></span>
      <span class="track-label video">Video</span>
      <span class="track-label audio">Audio</span>
      <span
        class="track-label elements"
        style:height={`${overlayTrackHeight}px`}
      >Elementos</span>
    </div>

    <div class="timeline-scroll" bind:this={scroller}>
      <div
        bind:this={content}
        class="timeline-content"
        style:width={`${contentWidth}px`}
      >
        <div
          class="ruler"
          role="slider"
          tabindex="0"
          aria-label="Cabezal de reproducción"
          aria-valuemin="0"
          aria-valuemax={duration}
          aria-valuenow={snapshot.playhead}
          onpointerdown={beginScrub}
          oncontextmenu={openTimelineContext}
          onkeydown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault()
              event.stopPropagation()
              controller.step(-1)
            } else if (event.key === 'ArrowRight') {
              event.preventDefault()
              event.stopPropagation()
              controller.step(1)
            }
          }}
        >
          {#each ticks as tick}
            <span class="tick" style:left={`${tick * pps}px`}>
              <span class="tick-line"></span>
              <span class="tick-label">{shortTime(tick)}</span>
            </span>
          {/each}
        </div>

        <div
          class="track video-track"
          role="group"
          aria-label="Pista de video"
          onpointerdown={(event) => {
            if (event.target === event.currentTarget) beginScrub(event)
          }}
          oncontextmenu={openTimelineContext}
        >
          {#if views.length === 0}
            <span class="track-empty">Sin segmentos</span>
          {/if}
          {#each views as view (view.clip.id)}
            <div
              class="clip"
              class:selected={snapshot.selection?.type === 'clip' &&
                snapshot.selection.id === view.clip.id}
              class:muted={view.clip.muted}
              style:left={`${view.start * pps}px`}
              style:width={`${Math.max(14, view.duration * pps)}px`}
              role="group"
              aria-label={clipLabel(view)}
              oncontextmenu={(event) =>
                openClipContext(event, view.clip.id)}
            >
              <button
                type="button"
                class="clip-body"
                title={clipLabel(view)}
                onclick={() => controller.selectClip(view.clip.id)}
              >
                <span class="clip-name">{view.mediaName}</span>
                <span class="clip-meta">
                  {shortTime(view.duration)}
                  {#if view.clip.speed !== 1}
                    <span class="speed-badge">{view.clip.speed}×</span>
                  {/if}
                  {#if !view.clip.muted && Math.abs((view.clip.volume ?? 1) - 1) > 0.001}
                    <span class="volume-badge"
                      >{Math.round((view.clip.volume ?? 1) * 100)}%</span
                    >
                  {/if}
                  {#if view.clip.muted}
                    <VolumeX size={11} strokeWidth={2} />
                  {/if}
                </span>
              </button>
              <button
                type="button"
                class="trim-handle start"
                aria-label="Recortar el inicio del segmento"
                onpointerdown={(event) =>
                  beginTrim(event, view.clip.id, 'start')}
              ></button>
              <button
                type="button"
                class="trim-handle end"
                aria-label="Recortar el final del segmento"
                onpointerdown={(event) =>
                  beginTrim(event, view.clip.id, 'end')}
              ></button>
            </div>
          {/each}
        </div>

        <div
          class="track audio-track"
          role="group"
          aria-label="Pista de audio"
          onpointerdown={(event) => {
            if (event.target === event.currentTarget) beginScrub(event)
          }}
          oncontextmenu={openTimelineContext}
        >
          <canvas
            bind:this={waveCanvas}
            class="waveform-canvas"
            aria-hidden="true"
          ></canvas>
          {#if audioState}
            <span class="track-empty audio-state">{audioState}</span>
          {/if}
        </div>

        <div
          class="track overlay-track"
          role="group"
          aria-label="Pista de elementos"
          style:height={`${overlayTrackHeight}px`}
          onpointerdown={(event) => {
            if (event.target === event.currentTarget) beginScrub(event)
          }}
          oncontextmenu={openTimelineContext}
        >
          {#if project && project.overlays.length === 0}
            <span class="track-empty">Sin elementos superpuestos</span>
          {/if}
          {#each overlayLayout.rows as { overlay, lane } (overlay.id)}
            {@const Icon = overlayIcon(overlay.kind)}
            <div
              class="overlay-block"
              class:selected={snapshot.selection?.type === 'overlay' &&
                snapshot.selection.id === overlay.id}
              style:left={`${overlay.start * pps}px`}
              style:top={`${6 + lane * 28}px`}
              style:width={`${Math.max(16, (overlay.end - overlay.start) * pps)}px`}
              role="group"
              aria-label={overlayLabel(overlay)}
              oncontextmenu={(event) =>
                openOverlayContext(event, overlay.id)}
            >
              <button
                type="button"
                class="overlay-body"
                title={overlayLabel(overlay)}
                onpointerdown={(event) => beginOverlayDrag(event, overlay)}
              >
                <Icon size={11} strokeWidth={2} />
                <span>{overlayLabel(overlay)}</span>
              </button>
            </div>
          {/each}
        </div>

        <div
          class="playhead"
          class:scrubbing
          style:left={`${snapshot.playhead * pps}px`}
          aria-hidden="true"
        >
          <span class="playhead-grip"></span>
        </div>
      </div>
    </div>
  </div>
</section>

<style>
  .timeline {
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border-top: 1px solid var(--border-soft);
  }

  .timeline-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    min-height: 40px;
    padding: 6px 16px 4px;
  }

  .timeline-heading {
    display: flex;
    align-items: baseline;
    gap: 9px;
    min-width: 0;
  }

  .timeline-heading h2 {
    color: var(--text);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.01em;
  }

  .timeline-heading span {
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    font-size: 9.5px;
    font-variant-numeric: tabular-nums;
  }

  .zoom-controls {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .icon-button.tiny {
    width: 25px;
    height: 25px;
  }

  .fit-button {
    height: 25px;
    padding: 0 7px;
    color: var(--text-tertiary);
    background: transparent;
    border: 1px solid var(--border-soft);
    border-radius: 6px;
    font-size: 10px;
    cursor: pointer;
  }

  .fit-button:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }

  .timeline-body {
    display: flex;
    gap: 0;
    min-height: 0;
    padding-bottom: 6px;
  }

  .track-labels {
    display: flex;
    width: 78px;
    flex: 0 0 auto;
    flex-direction: column;
    padding-top: 0;
    color: var(--text-tertiary);
    font-size: 8.5px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .ruler-spacer {
    height: 27px;
    flex: 0 0 auto;
  }

  .track-label {
    display: flex;
    align-items: center;
    padding-left: 16px;
    border-top: 1px solid var(--border-soft);
  }

  .track-label.video {
    height: 59px;
  }

  .track-label.audio {
    height: 52px;
  }

  .track-label.elements {
    height: 38px;
  }

  .timeline-scroll {
    min-width: 0;
    flex: 1;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong) transparent;
  }

  .timeline-content {
    position: relative;
    min-height: 130px;
    padding: 0;
  }

  .ruler {
    position: relative;
    height: 27px;
    cursor: ew-resize;
    touch-action: none;
  }

  .tick {
    position: absolute;
    top: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    height: 27px;
    pointer-events: none;
  }

  .tick-line {
    width: 1px;
    height: 9px;
    margin-top: 18px;
    background: var(--border-strong);
  }

  .tick-label {
    position: absolute;
    top: 1px;
    left: 4px;
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    font-size: 8.5px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .track {
    position: relative;
    display: flex;
    align-items: center;
    border-top: 1px solid var(--border-soft);
  }

  .video-track {
    height: 59px;
  }

  .audio-track {
    height: 52px;
    overflow: hidden;
  }

  .waveform-canvas {
    position: absolute;
    top: 0;
    bottom: 0;
    display: block;
    height: 100%;
    pointer-events: none;
  }

  .audio-state {
    position: absolute;
    top: 50%;
    left: 12px;
    padding: 0;
    transform: translateY(-50%);
    pointer-events: none;
  }

  .overlay-track {
    height: 38px;
  }

  .track-empty {
    padding-left: 12px;
    color: var(--text-tertiary);
    font-size: 10px;
    opacity: 0.7;
  }

  .clip {
    position: absolute;
    top: 6px;
    height: 46px;
    min-width: 14px;
    overflow: hidden;
    background: var(--primary-soft);
    border: 1px solid var(--primary-border);
    border-radius: 6px;
    transition:
      border-color var(--fast),
      background-color var(--fast);
  }

  .clip.selected {
    background: var(--primary-soft);
    border-color: var(--primary);
    box-shadow: 0 0 0 2px var(--primary-softer);
  }

  .clip.muted {
    background: var(--surface-inset);
    border-color: var(--border-strong);
    border-style: dashed;
  }

  .clip-body {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 3px;
    width: 100%;
    height: 100%;
    min-width: 0;
    padding: 0 10px;
    color: var(--text);
    text-align: left;
    background: transparent;
    border: 0;
    cursor: pointer;
  }

  .clip-name {
    overflow: hidden;
    font-size: 10.5px;
    font-weight: 560;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .clip-meta {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    font-size: 8.5px;
    font-variant-numeric: tabular-nums;
  }

  .speed-badge,
  .volume-badge {
    display: inline-flex;
    align-items: center;
    height: 13px;
    padding: 0 4px;
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 8px;
  }

  .speed-badge {
    color: var(--primary-ink);
    background: var(--primary-softer);
    border: 1px solid var(--primary-border);
  }

  .volume-badge {
    color: var(--text-tertiary);
    background: var(--surface-inset);
    border: 1px solid var(--border);
  }

  .trim-handle {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 8px;
    padding: 0;
    background: transparent;
    border: 0;
    cursor: ew-resize;
    touch-action: none;
  }

  .trim-handle.start {
    left: 0;
  }

  .trim-handle.end {
    right: 0;
  }

  .trim-handle::after {
    position: absolute;
    top: 9px;
    bottom: 9px;
    left: 3px;
    width: 2px;
    content: '';
    background: var(--primary);
    border-radius: 2px;
    opacity: 0;
    transition: opacity var(--fast);
  }

  .clip:hover .trim-handle::after,
  .clip.selected .trim-handle::after {
    opacity: 0.9;
  }

  .overlay-block {
    position: absolute;
    top: 6px;
    height: 26px;
    min-width: 16px;
    overflow: hidden;
    background: var(--surface-raised);
    border: 1px solid var(--border-strong);
    border-radius: 5px;
  }

  .overlay-block.selected {
    background: var(--primary-softer);
    border-color: var(--primary);
  }

  .overlay-body {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    height: 100%;
    min-width: 0;
    padding: 0 7px;
    color: var(--text-secondary);
    text-align: left;
    background: transparent;
    border: 0;
    cursor: grab;
    touch-action: none;
  }

  .overlay-body:active {
    cursor: grabbing;
  }

  .overlay-body span {
    overflow: hidden;
    font-size: 9.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .playhead {
    position: absolute;
    top: 18px;
    bottom: 0;
    z-index: 6;
    width: 1px;
    background: var(--primary);
    pointer-events: none;
    transform: translateX(-0.5px);
  }

  .playhead-grip {
    position: absolute;
    top: -5px;
    left: 50%;
    width: 9px;
    height: 9px;
    background: var(--primary);
    border-radius: 50%;
    transform: translateX(-50%);
  }

  .playhead.scrubbing {
    background: var(--primary-hover);
  }

  @media (max-width: 720px) {
    .track-labels {
      width: 58px;
    }

    .track-label {
      padding-left: 10px;
      font-size: 8px;
    }

    .timeline-head {
      padding: 5px 12px 3px;
    }

    .timeline-content {
      padding-right: 0;
    }
  }
</style>
