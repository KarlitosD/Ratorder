import { projectDuration } from './model'
import type { EditorOverlay, EditorProject } from './types'

export interface FrameImage {
  image: CanvasImageSource
  width: number
  height: number
}

export interface RenderFrameOptions {
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  width: number
  height: number
  project: EditorProject
  time: number
  overlays: EditorOverlay[]
  images: Map<string, ImageBitmap>
  frame: FrameImage | null
  selectedOverlayId?: string | null
  showSelection?: boolean
  /** Duración cacheada de la timeline; evita recalcularla por frame. */
  duration?: number
}

function drawImageContain(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  box: { x: number; y: number; width: number; height: number },
) {
  if (sourceWidth <= 0 || sourceHeight <= 0) return
  const scale = Math.min(box.width / sourceWidth, box.height / sourceHeight)
  const width = sourceWidth * scale
  const height = sourceHeight * scale
  ctx.drawImage(
    source,
    box.x + (box.width - width) / 2,
    box.y + (box.height - height) / 2,
    width,
    height,
  )
}

// Caché de wrapping tipográfico: última entrada por overlay. Clave: id del
// overlay; valor: huella (texto + maxWidth + fuente efectiva) y líneas.
// Acotada para no crecer con cada tamaño intermedio de un drag.
const WRAP_CACHE_LIMIT = 120
const textWrapCache = new Map<string, { fingerprint: string; lines: string[] }>()
let wrapFontGeneration = 0

function currentFontKey(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
): string {
  const font =
    typeof (ctx as CanvasRenderingContext2D).font === 'string'
      ? (ctx as CanvasRenderingContext2D).font
      : ''
  return `${wrapFontGeneration}|${font}`
}

export function invalidateTextWrapCache(): void {
  wrapFontGeneration += 1
  if (textWrapCache.size > 0) textWrapCache.clear()
}

export function pruneTextWrapCache(activeOverlayIds: Set<string>): void {
  for (const id of Array.from(textWrapCache.keys())) {
    if (!activeOverlayIds.has(id)) textWrapCache.delete(id)
  }
}

function wrapText(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  overlayId: string,
  text: string,
  maxWidth: number,
): string[] {
  const fingerprint = `${text}|${maxWidth.toFixed(2)}|${currentFontKey(ctx)}`
  const entry = textWrapCache.get(overlayId)
  if (entry && entry.fingerprint === fingerprint) return entry.lines
  const lines = wrapTextUncached(ctx, text, maxWidth)
  textWrapCache.set(overlayId, { fingerprint, lines })
  if (textWrapCache.size > WRAP_CACHE_LIMIT) {
    const oldest = textWrapCache.keys().next()
    if (!oldest.done) textWrapCache.delete(oldest.value)
  }
  return lines
}

function wrapTextUncached(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    if (!paragraph) {
      lines.push('')
      continue
    }
    const words = paragraph.split(/\s+/)
    let line = ''
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (line && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line)
        line = word
      } else {
        line = candidate
      }
    }
    if (line) lines.push(line)
  }
  return lines.length > 0 ? lines : ['']
}

function isVisible(overlay: EditorOverlay, time: number, duration: number): boolean {
  if (overlay.end <= overlay.start) return false
  if (time + 1e-6 < overlay.start) return false
  if (time < overlay.end) return true
  return Math.abs(time - duration) < 1e-6 && overlay.end >= duration
}

function drawOverlay(
  options: RenderFrameOptions,
  overlay: EditorOverlay,
  scale: number,
) {
  const { ctx, width, height, images } = options
  const left = overlay.x * width
  const top = overlay.y * height
  const boxWidth = overlay.width * width
  const boxHeight = overlay.height * height

  ctx.save()
  const shapeFill = overlay.kind === 'rect' || overlay.kind === 'ellipse'
  ctx.globalAlpha = shapeFill ? 1 : overlay.opacity
  ctx.fillStyle = overlay.color || '#FFFFFF'
  ctx.strokeStyle = overlay.strokeColor || overlay.color || '#FFFFFF'
  const strokeWidth = Math.max(0, overlay.strokeWidth * scale)

  switch (overlay.kind) {
    case 'rect': {
      const radius = Math.max(0, overlay.radius * scale)
      ctx.beginPath()
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(left, top, boxWidth, boxHeight, radius)
      } else {
        ctx.rect(left, top, boxWidth, boxHeight)
      }
      if (overlay.filled !== false) {
        ctx.globalAlpha = overlay.opacity
        ctx.fill()
        ctx.globalAlpha = 1
      }
      if (strokeWidth > 0) {
        ctx.lineWidth = strokeWidth
        ctx.stroke()
      }
      break
    }
    case 'ellipse': {
      ctx.beginPath()
      ctx.ellipse(
        left + boxWidth / 2,
        top + boxHeight / 2,
        boxWidth / 2,
        boxHeight / 2,
        0,
        0,
        Math.PI * 2,
      )
      if (overlay.filled !== false) {
        ctx.globalAlpha = overlay.opacity
        ctx.fill()
        ctx.globalAlpha = 1
      }
      if (strokeWidth > 0) {
        ctx.lineWidth = strokeWidth
        ctx.stroke()
      }
      break
    }
    case 'arrow': {
      const startX = left
      const startY = top
      const endX = left + boxWidth
      const endY = top + boxHeight
      const angle = Math.atan2(endY - startY, endX - startX)
      const head = Math.max(10 * scale, strokeWidth * 2.4)
      ctx.lineWidth = Math.max(1, strokeWidth)
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(startX, startY)
      ctx.lineTo(endX, endY)
      ctx.lineTo(
        endX - head * Math.cos(angle - Math.PI / 6),
        endY - head * Math.sin(angle - Math.PI / 6),
      )
      ctx.moveTo(endX, endY)
      ctx.lineTo(
        endX - head * Math.cos(angle + Math.PI / 6),
        endY - head * Math.sin(angle + Math.PI / 6),
      )
      ctx.stroke()
      break
    }
    case 'text': {
      const fontSize = Math.max(8, (overlay.fontSize ?? 64) * scale)
      const weight = overlay.fontWeight ?? 600
      ctx.font = `${weight} ${fontSize}px "Inter Variable", Inter, system-ui, sans-serif`
      ctx.textBaseline = 'top'
      ctx.textAlign = overlay.align ?? 'left'
      const lines = wrapText(ctx, overlay.id, overlay.text ?? '', boxWidth)
      const lineHeight = fontSize * 1.25
      const x =
        overlay.align === 'center'
          ? left + boxWidth / 2
          : overlay.align === 'right'
            ? left + boxWidth
            : left
      ctx.beginPath()
      ctx.rect(left, top, boxWidth, boxHeight)
      ctx.clip()
      const textStroke = Math.max(0, overlay.strokeWidth * scale)
      ctx.strokeStyle = overlay.strokeColor || '#171A21'
      ctx.lineJoin = 'round'
      lines.forEach((line, index) => {
        const lineY = top + index * lineHeight
        if (textStroke > 0) {
          // El trazo queda centrado en el glifo; duplicarlo deja el borde
          // visible con el grosor indicado por el usuario.
          ctx.lineWidth = textStroke * 2
          ctx.strokeText(line, x, lineY)
        }
        ctx.fillText(line, x, lineY)
      })
      break
    }
    case 'image': {
      const bitmap = overlay.assetId ? images.get(overlay.assetId) : undefined
      if (bitmap) {
        drawImageContain(ctx, bitmap, bitmap.width, bitmap.height, {
          x: left,
          y: top,
          width: boxWidth,
          height: boxHeight,
        })
      }
      break
    }
  }
  ctx.restore()
}

function drawSelection(
  options: RenderFrameOptions,
  overlay: EditorOverlay,
) {
  const { ctx, width, height } = options
  const left = overlay.x * width
  const top = overlay.y * height
  const boxWidth = overlay.width * width
  const boxHeight = overlay.height * height
  const lineWidth = Math.max(1, width / 1280 * 1.5)
  const handle = Math.max(6, width * 0.007)
  ctx.save()
  ctx.globalAlpha = 1
  ctx.strokeStyle = '#4F7CF7'
  ctx.lineWidth = lineWidth
  ctx.strokeRect(left, top, boxWidth, boxHeight)
  ctx.fillStyle = '#FFFFFF'
  for (const [x, y] of [
    [left, top],
    [left + boxWidth, top],
    [left, top + boxHeight],
    [left + boxWidth, top + boxHeight],
  ]) {
    ctx.beginPath()
    ctx.rect(
      x - handle / 2,
      y - handle / 2,
      handle,
      handle,
    )
    ctx.fill()
    ctx.stroke()
  }
  ctx.restore()
}

export function renderFrame(options: RenderFrameOptions): void {
  const { ctx, width, height, frame, overlays, project, time } = options
  ctx.save()
  ctx.globalAlpha = 1
  ctx.fillStyle = '#090B0F'
  ctx.fillRect(0, 0, width, height)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  if (frame && frame.width > 0 && frame.height > 0) {
    drawImageContain(ctx, frame.image, frame.width, frame.height, {
      x: 0,
      y: 0,
      width,
      height,
    })
  }
  ctx.restore()

  const scale = width / Math.max(1, project.width)
  const duration = options.duration ?? projectDuration(project)
  for (const overlay of overlays) {
    if (!isVisible(overlay, time, duration)) continue
    drawOverlay(options, overlay, scale)
  }

  if (options.showSelection && options.selectedOverlayId) {
    const selected = overlays.find(
      (overlay) => overlay.id === options.selectedOverlayId,
    )
    if (selected) {
      drawSelection(options, selected)
    }
  }
}

export function canvasThumbnail(
  source: HTMLCanvasElement,
  width = 720,
  height = 405,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (context) {
    context.fillStyle = '#090B0F'
    context.fillRect(0, 0, width, height)
    const scale = Math.min(width / source.width, height / source.height)
    const drawWidth = source.width * scale
    const drawHeight = source.height * scale
    context.drawImage(
      source,
      (width - drawWidth) / 2,
      (height - drawHeight) / 2,
      drawWidth,
      drawHeight,
    )
  }
  return canvas
}
