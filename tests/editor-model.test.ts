import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  addClipFromAsset,
  addOverlay,
  cloneProject,
  createDefaultProject,
  createOverlay,
  deleteClip,
  EditorHistory,
  findClipAt,
  layoutTimeline,
  normalizeProject,
  projectDuration,
  projectHasAudio,
  removeOverlay,
  setClipMuted,
  setClipSpeed,
  setClipVolume,
  sourceTimeForView,
  splitAt,
  toggleMute,
  trimClip,
  updateOverlay,
} from '../src/lib/editor/model.ts'
import {
  hitTestOverlay,
  moveOverlay,
  resizeOverlay,
} from '../src/lib/editor/geometry.ts'

function makeProject() {
  return createDefaultProject({
    sourceId: 'recording-1',
    title: 'Demostración',
    source: {
      duration: 10,
      width: 1280,
      height: 720,
      fps: 30,
      container: 'mp4',
      hasAudio: true,
      extension: 'mp4',
    },
    now: '2026-11-01T00:00:00.000Z',
  })
}

function withSecondHalf(project) {
  return splitAt(project, 4)
}

test('creates a contiguous clip that covers the source', () => {
  const project = makeProject()
  assert.equal(project.clips.length, 1)
  assert.equal(project.clips[0].inPoint, 0)
  assert.equal(project.clips[0].sourceSpan, 10)
  const views = layoutTimeline(project)
  assert.equal(views[0].start, 0)
  assert.equal(views[0].end, 10)
  assert.equal(projectDuration(project), 10)
  assert.equal(findClipAt(project, 4)?.clip.id, project.clips[0].id)
  assert.equal(
    sourceTimeForView(views[0], 4),
    4,
  )
})

test('splits at the playhead preserving total duration', () => {
  const project = withSecondHalf(makeProject())
  assert.equal(project.clips.length, 2)
  assert.equal(project.clips[0].sourceSpan, 4)
  assert.equal(project.clips[1].inPoint, 4)
  assert.equal(project.clips[1].sourceSpan, 6)
  assert.equal(projectDuration(project), 10)
  const views = layoutTimeline(project)
  assert.equal(views[1].start, 4)
  assert.equal(views[1].end, 10)
})

test('speed changes the timeline duration and keeps source mapping', () => {
  let project = withSecondHalf(makeProject())
  const second = project.clips[1].id
  project = setClipSpeed(project, second, 2)
  assert.equal(projectDuration(project), 7)
  const view = layoutTimeline(project)[1]
  assert.equal(view.duration, 3)
  assert.equal(sourceTimeForView(view, 5), 6)
  assert.ok(Math.abs(sourceTimeForView(view, 7) - 10) < 1e-6)
})

test('trims clip edges and ripples following clips', () => {
  let project = withSecondHalf(makeProject())
  const first = project.clips[0].id
  const second = project.clips[1].id

  project = trimClip(project, first, 'end', -1)
  assert.equal(project.clips[0].sourceSpan, 3)
  assert.equal(projectDuration(project), 9)
  assert.equal(layoutTimeline(project)[1].start, 3)

  project = trimClip(project, second, 'start', 1)
  assert.equal(project.clips[1].inPoint, 5)
  assert.equal(project.clips[1].sourceSpan, 5)
  assert.equal(projectDuration(project), 8)

  project = trimClip(project, second, 'end', 10)
  assert.equal(project.clips[1].sourceSpan, 5)
})

test('clamps trims to the media and minimum duration', () => {
  let project = makeProject()
  const clipId = project.clips[0].id
  project = trimClip(project, clipId, 'start', -5)
  assert.equal(project.clips[0].inPoint, 0)
  project = trimClip(project, clipId, 'start', 100)
  assert.ok(project.clips[0].sourceSpan >= 0.1)
  assert.ok(project.clips[0].inPoint <= 10)
})

test('deleting a clip closes the gap', () => {
  let project = withSecondHalf(makeProject())
  const first = project.clips[0].id
  project = deleteClip(project, first)
  assert.equal(project.clips.length, 1)
  const view = layoutTimeline(project)[0]
  assert.equal(view.start, 0)
  assert.equal(view.end, 6)
})

test('toggles mute without touching duration', () => {
  const project = makeProject()
  const next = toggleMute(project, project.clips[0].id)
  assert.equal(next.clips[0].muted, true)
  assert.equal(projectDuration(next), 10)
  assert.equal(toggleMute(next, next.clips[0].id).clips[0].muted, false)
})

test('controls volume per clip and split copies the level', () => {
  let project = makeProject()
  const clipId = project.clips[0].id
  assert.equal(project.clips[0].volume, 1)

  project = setClipVolume(project, clipId, 0.4)
  assert.equal(project.clips[0].volume, 0.4)
  assert.equal(projectHasAudio(project), true)

  project = setClipVolume(project, clipId, 2)
  assert.equal(project.clips[0].volume, 1.5)
  project = setClipVolume(project, clipId, -1)
  assert.equal(project.clips[0].volume, 0)
  assert.equal(projectHasAudio(project), false)

  project = setClipVolume(project, clipId, 0.35)
  const split = splitAt(project, 4)
  assert.equal(split.clips[0].volume, 0.35)
  assert.equal(split.clips[1].volume, 0.35)

  const muted = setClipMuted(split, split.clips[0].id, true)
  assert.equal(muted.clips[0].muted, true)
  assert.equal(muted.clips[1].muted, false)
})

test('normalizes old projects without volume to full volume', () => {
  const project = makeProject()
  const old = cloneProject(project)
  delete old.clips[0].volume
  const result = normalizeProject(old, {
    sourceInfo: project.source,
    mediaDurations: { source: 10 },
    availableAssets: [],
  })
  assert.equal(result.project.clips[0].volume, 1)
})

test('imports another video as an appended clip', () => {
  const project = makeProject()
  const withAsset: any = {
    ...project,
    assets: [
      {
        id: 'asset-1',
        kind: 'video',
        name: 'extra.mp4',
        storedName: 'asset-1.mp4',
        extension: 'mp4',
        mimeType: 'video/mp4',
        size: 1000,
        duration: 5,
        width: 640,
        height: 360,
        hasAudio: true,
      },
    ],
  }
  const next = addClipFromAsset(withAsset, 'asset-1')
  assert.equal(next.clips.length, 2)
  assert.equal(next.clips[1].mediaId, 'asset-1')
  assert.equal(projectDuration(next), 15)
})

test('creates overlays, clamps them and updates them', () => {
  let project = makeProject()
  const overlay = createOverlay(project, 'text', 9)
  assert.equal(overlay.start, 9)
  assert.equal(overlay.end, 10)
  project = addOverlay(project, overlay)
  assert.equal(project.overlays.length, 1)

  project = updateOverlay(project, overlay.id, {
    start: 20,
    end: 30,
    x: 2,
    y: -1,
    opacity: 3,
  })
  const updated = project.overlays[0]
  assert.ok(updated.start >= 0 && updated.start <= 10)
  assert.ok(updated.end <= 10)
  assert.ok(updated.x >= 0 && updated.x <= 1)
  assert.ok(updated.y >= 0 && updated.y <= 1)
  assert.equal(updated.opacity, 1)

  project = removeOverlay(project, overlay.id)
  assert.equal(project.overlays.length, 0)
})

test('text overlays support a custom letter outline', () => {
  let project = makeProject()
  const overlay = createOverlay(project, 'text', 0)
  assert.equal(overlay.strokeColor, '#171A21')
  assert.equal(overlay.strokeWidth, 0)

  project = addOverlay(project, overlay)
  project = updateOverlay(project, overlay.id, {
    strokeColor: '#F06B76',
    strokeWidth: 6,
  })
  const updated = project.overlays[0]
  assert.equal(updated.strokeColor, '#F06B76')
  assert.equal(updated.strokeWidth, 6)
})

test('shape overlays can hide their fill and keep their border', () => {
  const project = makeProject()
  const rect = createOverlay(project, 'rect', 0)
  assert.equal(rect.strokeColor, '#171A21')
  assert.equal(rect.filled, true)

  const withRect = addOverlay(project, rect)
  const updated = updateOverlay(withRect, rect.id, { filled: false })
  assert.equal(updated.overlays[0].filled, false)
})

test('undo and redo restore project snapshots', () => {
  const initial = makeProject()
  const history = new EditorHistory(initial)
  const changed = setClipSpeed(initial, initial.clips[0].id, 2)
  history.commit(changed)
  assert.equal(history.canUndo, true)
  const undone = history.undo()
  assert.equal(projectDuration(undone), 10)
  assert.equal(history.canRedo, true)
  const redone = history.redo()
  assert.equal(projectDuration(redone), 5)
})

test('normalizeProject repairs invalid clips and overlays', () => {
  const project = makeProject()
  const broken: any = (cloneProject as any)(project)
  broken.clips.push({
    id: 'broken',
    mediaId: 'missing',
    inPoint: 0,
    sourceSpan: 2,
    speed: 4,
    muted: false,
  })
  broken.clips[0].sourceSpan = 999
  broken.overlays = [
    {
      ...createOverlay(project, 'image', 1),
      assetId: 'missing-image',
    },
  ]
  const result = normalizeProject(broken, {
    sourceInfo: project.source,
    mediaDurations: { source: 10 },
    availableAssets: [],
  })
  assert.equal(result.project.clips.length, 1)
  assert.ok(result.project.clips[0].sourceSpan <= 10)
  assert.equal(result.project.overlays.length, 0)
  assert.ok(result.repairs.length > 0)
})

test('overlay hit testing, move and resize stay inside the canvas', () => {
  const project = makeProject()
  const overlay = createOverlay(project, 'rect', 0)
  assert.equal(hitTestOverlay([overlay], {
    x: overlay.x + overlay.width / 2,
    y: overlay.y + overlay.height / 2,
  })?.id, overlay.id)
  assert.equal(hitTestOverlay([overlay], { x: 0.99, y: 0.99 }), null)

  const moved = moveOverlay(overlay, 10, 10)
  assert.ok(moved.x <= 1 - moved.width)
  assert.ok(moved.y <= 1 - moved.height)

  const resized = resizeOverlay(overlay, 'se', 10, 10)
  assert.ok(resized.x + resized.width <= 1.0001)
  assert.ok(resized.y + resized.height <= 1.0001)
  assert.ok(resized.width >= 0.02)
  assert.ok(resized.height >= 0.02)
})
