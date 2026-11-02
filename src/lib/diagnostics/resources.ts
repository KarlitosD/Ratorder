// Counters never retain the resources themselves, so diagnostics cannot keep them alive.
type Resource = 'writer' | 'objectUrl' | 'audioContext' | 'mixedTrack' | 'thumbnailUrl' | 'playbackUrl' | 'downloadUrl' | 'editorUrl' | 'editorInput'
const counts: Record<Resource, number> = { writer: 0, objectUrl: 0, audioContext: 0, mixedTrack: 0, thumbnailUrl: 0, playbackUrl: 0, downloadUrl: 0, editorUrl: 0, editorInput: 0 }

export function trackResource(kind: Resource): () => void {
  counts[kind]++
  let released = false
  return () => {
    if (released) return
    released = true
    counts[kind]--
  }
}

export function getResourceCounts(): Record<Resource, number> {
  return { ...counts }
}

export function checkWriters() {
  return counts.writer > 0
    ? { kind: 'writer_not_closed' as const, count: counts.writer }
    : null
}

const urls = new Map<string, () => void>()
export function createDiagnosticUrl(blob: Blob, kind: 'thumbnailUrl' | 'playbackUrl' | 'downloadUrl' | 'editorUrl'): string {
  const url = URL.createObjectURL(blob)
  const releaseTotal = trackResource('objectUrl')
  const releaseKind = trackResource(kind)
  urls.set(url, () => { releaseTotal(); releaseKind() })
  return url
}

export function revokeDiagnosticUrl(url: string): void {
  URL.revokeObjectURL(url)
  urls.get(url)?.()
  urls.delete(url)
}
