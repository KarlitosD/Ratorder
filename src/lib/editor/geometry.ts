import type { EditorOverlay } from './types'

export interface Point {
  x: number
  y: number
}

export type OverlayHandle = 'nw' | 'ne' | 'sw' | 'se'

export interface Size {
  width: number
  height: number
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

export function normalizePoint(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
): Point {
  const width = Math.max(1, rect.width)
  const height = Math.max(1, rect.height)
  return {
    x: clamp01((clientX - rect.left) / width),
    y: clamp01((clientY - rect.top) / height),
  }
}

export function overlayContains(overlay: EditorOverlay, point: Point): boolean {
  return (
    point.x >= overlay.x &&
    point.x <= overlay.x + overlay.width &&
    point.y >= overlay.y &&
    point.y <= overlay.y + overlay.height
  )
}

export function hitTestOverlay(
  overlays: EditorOverlay[],
  point: Point,
): EditorOverlay | null {
  for (let index = overlays.length - 1; index >= 0; index -= 1) {
    if (overlayContains(overlays[index], point)) return overlays[index]
  }
  return null
}

export function handleAtPoint(
  overlay: EditorOverlay,
  point: Point,
  tolerance: number,
): OverlayHandle | null {
  const right = overlay.x + overlay.width
  const bottom = overlay.y + overlay.height
  const handles: Array<{ handle: OverlayHandle; x: number; y: number }> = [
    { handle: 'nw', x: overlay.x, y: overlay.y },
    { handle: 'ne', x: right, y: overlay.y },
    { handle: 'sw', x: overlay.x, y: bottom },
    { handle: 'se', x: right, y: bottom },
  ]
  for (const handle of handles) {
    if (
      Math.abs(point.x - handle.x) <= tolerance &&
      Math.abs(point.y - handle.y) <= tolerance
    ) {
      return handle.handle
    }
  }
  return null
}

export function moveOverlay(
  overlay: EditorOverlay,
  dx: number,
  dy: number,
): EditorOverlay {
  return {
    ...overlay,
    x: Math.min(Math.max(0, 1 - overlay.width), Math.max(0, overlay.x + dx)),
    y: Math.min(Math.max(0, 1 - overlay.height), Math.max(0, overlay.y + dy)),
  }
}

export function resizeOverlay(
  overlay: EditorOverlay,
  handle: OverlayHandle,
  dx: number,
  dy: number,
  minSize = 0.02,
): EditorOverlay {
  let left = overlay.x
  let top = overlay.y
  let right = overlay.x + overlay.width
  let bottom = overlay.y + overlay.height

  if (handle === 'nw' || handle === 'sw') {
    left = Math.min(right - minSize, Math.max(0, left + dx))
  } else {
    right = Math.max(left + minSize, Math.min(1, right + dx))
  }
  if (handle === 'nw' || handle === 'ne') {
    top = Math.min(bottom - minSize, Math.max(0, top + dy))
  } else {
    bottom = Math.max(top + minSize, Math.min(1, bottom + dy))
  }

  return {
    ...overlay,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  }
}

export function overlayRectPixels(
  overlay: EditorOverlay,
  size: Size,
): { x: number; y: number; width: number; height: number } {
  return {
    x: overlay.x * size.width,
    y: overlay.y * size.height,
    width: overlay.width * size.width,
    height: overlay.height * size.height,
  }
}

export function timeToX(
  time: number,
  pixelsPerSecond: number,
  scrollLeft = 0,
): number {
  return time * pixelsPerSecond - scrollLeft
}
