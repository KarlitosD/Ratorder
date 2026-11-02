<script lang="ts">
  import { onMount } from 'svelte'
  import { MousePointer2 } from '@lucide/svelte'
  import type { EditorController } from '../../editor/controller'
  import {
    handleAtPoint,
    hitTestOverlay,
    moveOverlay,
    resizeOverlay,
    type OverlayHandle,
  } from '../../editor/geometry'
  import type {
    EditorContextMenuState,
    EditorOverlay,
    EditorSnapshot,
  } from '../../editor/types'

  interface Props {
    snapshot: EditorSnapshot
    controller: EditorController
    onContextMenu: (state: EditorContextMenuState) => void
  }

  let { snapshot, controller, onContextMenu }: Props = $props()

  let canvas = $state<HTMLCanvasElement | null>(null)
  let dragging = $state(false)
  let cursor = $state('default')

  let project = $derived(snapshot.project)
  let empty = $derived(!project || project.clips.length === 0)
  let exportBusy = $derived(
    ['preparing', 'exporting', 'finalizing'].includes(
      snapshot.exportState.phase,
    ),
  )
  let selectedOverlay = $derived.by(() => {
    if (!project || snapshot.selection?.type !== 'overlay') return null
    return (
      project.overlays.find(
        (overlay) => overlay.id === snapshot.selection?.id,
      ) ?? null
    )
  })

  interface DragState {
    kind: 'move' | 'resize'
    overlay: EditorOverlay
    handle: OverlayHandle | null
    start: { x: number; y: number }
  }

  let drag: DragState | null = null

  onMount(() => {
    if (canvas) controller.attachCanvas(canvas)
  })

  function activeOverlays(): EditorOverlay[] {
    if (!project) return []
    return project.overlays.filter(
      (overlay) =>
        snapshot.playhead + 1e-6 >= overlay.start &&
        snapshot.playhead < overlay.end,
    )
  }

  function contentRect() {
    if (!canvas || !project) {
      return { left: 0, top: 0, width: 1, height: 1 }
    }
    const rect = canvas.getBoundingClientRect()
    const projectAspect = project.width / Math.max(1, project.height)
    const rectAspect = rect.width / Math.max(1, rect.height)
    let width = rect.width
    let height = rect.height
    let left = 0
    let top = 0
    if (rectAspect > projectAspect) {
      width = rect.height * projectAspect
      left = (rect.width - width) / 2
    } else {
      height = rect.width / projectAspect
      top = (rect.height - height) / 2
    }
    return {
      left: rect.left + left,
      top: rect.top + top,
      width: Math.max(1, width),
      height: Math.max(1, height),
    }
  }

  function pointFromEvent(event: MouseEvent | PointerEvent) {
    const rect = contentRect()
    return {
      x: Math.min(
        1,
        Math.max(0, (event.clientX - rect.left) / rect.width),
      ),
      y: Math.min(
        1,
        Math.max(0, (event.clientY - rect.top) / rect.height),
      ),
    }
  }

  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0 || !canvas || !project || exportBusy) return
    const point = pointFromEvent(event)
    const rect = contentRect()
    const tolerance = 14 / Math.max(1, Math.min(rect.width, rect.height))
    const selected = selectedOverlay

    if (selected) {
      const handle = handleAtPoint(selected, point, tolerance)
      if (handle) {
        drag = {
          kind: 'resize',
          overlay: { ...selected },
          handle,
          start: point,
        }
        dragging = true
        cursor = handle === 'nw' || handle === 'se' ? 'nwse-resize' : 'nesw-resize'
        canvas.setPointerCapture(event.pointerId)
        event.preventDefault()
        return
      }
    }

    const hit = hitTestOverlay(activeOverlays(), point)
    if (hit) {
      controller.setSelection({ type: 'overlay', id: hit.id })
      drag = {
        kind: 'move',
        overlay: { ...hit },
        handle: null,
        start: point,
      }
      dragging = true
      cursor = 'grabbing'
      canvas.setPointerCapture(event.pointerId)
      event.preventDefault()
      return
    }

    controller.setSelection(null)
    cursor = 'default'
  }

  function onPointerMove(event: PointerEvent) {
    if (!canvas) return
    const point = pointFromEvent(event)
    if (!drag) {
      const rect = contentRect()
      const tolerance = 14 / Math.max(1, Math.min(rect.width, rect.height))
      if (selectedOverlay && handleAtPoint(selectedOverlay, point, tolerance)) {
        const handle = handleAtPoint(selectedOverlay, point, tolerance)
        cursor =
          handle === 'nw' || handle === 'se' ? 'nwse-resize' : 'nesw-resize'
      } else if (hitTestOverlay(activeOverlays(), point)) {
        cursor = 'grab'
      } else {
        cursor = 'default'
      }
      return
    }

    const dx = point.x - drag.start.x
    const dy = point.y - drag.start.y
    const next =
      drag.kind === 'move'
        ? moveOverlay(drag.overlay, dx, dy)
        : resizeOverlay(
            drag.overlay,
            drag.handle ?? 'se',
            dx,
            dy,
          )
    controller.updateOverlayLive(next.id, {
      x: next.x,
      y: next.y,
      width: next.width,
      height: next.height,
    })
  }

  function endDrag(event: PointerEvent) {
    if (!drag) return
    drag = null
    dragging = false
    cursor = 'grab'
    if (canvas?.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId)
    }
    controller.commitInteraction()
  }

  function togglePlayback() {
    if (exportBusy || empty) return
    void controller.togglePlayback()
  }

  function handleContextMenu(event: MouseEvent) {
    if (!canvas || !project || exportBusy) return
    event.preventDefault()
    const point = pointFromEvent(event)
    const hit = hitTestOverlay(activeOverlays(), point)
    if (hit) controller.setSelection({ type: 'overlay', id: hit.id })
    onContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: {
        kind: 'preview',
        overlayId: hit?.id ?? null,
        time: snapshot.playhead,
      },
    })
  }
</script>

<section class="preview-panel" aria-label="Vista previa de la edición">
  <div class="preview-heading">
    <span class="preview-label">
      <MousePointer2 size={13} strokeWidth={1.9} />
      Vista previa
    </span>
    {#if project}
      <span class="preview-meta">{project.width} × {project.height} · {project.fps} FPS</span>
    {/if}
  </div>

  <div
    class="preview-shell"
    class:empty
    style={`--project-aspect: ${project ? `${project.width} / ${project.height}` : '16 / 9'}`}
  >
    <canvas
      bind:this={canvas}
      class="preview-canvas"
      class:dragging
      style:cursor
      aria-label="Lienzo de la edición"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={endDrag}
      onpointercancel={endDrag}
      oncontextmenu={handleContextMenu}
      ondblclick={togglePlayback}
    ></canvas>

    {#if empty}
      <div class="preview-empty">
        <p class="empty-title">No hay segmentos.</p>
        <p class="empty-subtitle">
          Importa un video o deshaz el último cambio para volver a empezar.
        </p>
      </div>
    {/if}
  </div>
</section>

<style>
  .preview-panel {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex: 1;
    flex-direction: column;
    padding: 14px 16px;
    background: var(--surface);
  }

  .preview-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    margin-bottom: 10px;
  }

  .preview-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text-secondary);
    font-size: 11px;
    font-weight: 550;
  }

  .preview-meta {
    overflow: hidden;
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    font-size: 9.5px;
    font-variant-numeric: tabular-nums;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .preview-shell {
    position: relative;
    display: flex;
    min-height: 0;
    flex: 1;
    align-items: center;
    justify-content: center;
    width: 100%;
    overflow: hidden;
    background: var(--canvas);
    border: 1px solid var(--border-soft);
    border-radius: 10px;
  }

  .preview-canvas {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    touch-action: none;
    user-select: none;
  }

  .preview-canvas.dragging {
    cursor: grabbing !important;
  }

  .preview-empty {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 24px;
    text-align: center;
    pointer-events: none;
  }

  .empty-title {
    color: var(--text);
    font-size: 19px;
    font-weight: 580;
    letter-spacing: -0.035em;
  }

  .empty-subtitle {
    max-width: 36ch;
    margin-top: 6px;
    color: var(--text-tertiary);
    font-size: 11.5px;
    line-height: 1.55;
  }

  @media (max-width: 980px) {
    .preview-panel {
      flex: none;
      padding: 12px;
    }

    .preview-shell {
      flex: none;
      aspect-ratio: var(--project-aspect, 16 / 9);
    }
  }
</style>
