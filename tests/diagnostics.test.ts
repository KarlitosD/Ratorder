import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import { createServer } from 'vite'

let server: any, diagnostics: any
beforeAll(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' })
  diagnostics = await server.ssrLoadModule('/src/lib/diagnostics/resources.ts')
})
afterAll(async () => { await server?.close() })

test('tracks resources idempotently without retaining their objects', () => {
  const release = diagnostics.trackResource('writer')
  assert.equal(diagnostics.getResourceCounts().writer, 1)
  release()
  release()
  assert.equal(diagnostics.getResourceCounts().writer, 0)
})

test('records a bounded diagnostic only when writers remain after cleanup', () => {
  const release = diagnostics.trackResource('writer')
  const issue = diagnostics.checkWriters()
  assert.equal(issue?.kind, 'writer_not_closed')
  assert.equal(issue?.count, 1)
  release()
  assert.equal(diagnostics.checkWriters(), null)
})

test('does not transmit diagnostic issues without explicit consent', async () => {
  const reporting = await server.ssrLoadModule('/src/lib/diagnostics/reporting.ts')
  let calls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { calls++; return new Response() }
  const release = diagnostics.trackResource('writer')
  try {
    assert.equal(reporting.telemetryEnabled(), false)
    assert.equal(reporting.inspectAfterRecording(), true)
    assert.equal(calls, 0)
  } finally {
    release()
    globalThis.fetch = originalFetch
  }
})

test('returns tracked resources to baseline across repeated lifecycles', () => {
  const baseline = diagnostics.getResourceCounts()
  for (let i = 0; i < 100; i++) {
    const releases = ['writer', 'audioContext', 'mixedTrack', 'thumbnailUrl', 'playbackUrl', 'downloadUrl'].map((k: any) => diagnostics.trackResource(k))
    for (const release of releases) (release as any)()
  }
  assert.deepEqual(diagnostics.getResourceCounts(), baseline)
})

test('keeps only ten local observations and reports memory samples when available', async () => {
  const reporting = await server.ssrLoadModule('/src/lib/diagnostics/reporting.ts')
  const previousWindow = globalThis.window
  const previousMemory = (performance as any).measureUserAgentSpecificMemory
  globalThis.window = { crossOriginIsolated: true } as any
  (performance as any).measureUserAgentSpecificMemory = async () => ({ bytes: 1234 })
  const release = diagnostics.trackResource('writer')
  try {
    for (let i = 0; i < 12; i++) reporting.inspectAfterRecording()
    const report = JSON.parse(await reporting.createLocalReport())
    assert.equal(report.history.length, 10)
    assert.equal(report.memoryBytes, 1234)
    assert.equal(report.memorySamples.length, 10)
  } finally {
    release()
    if (previousWindow === undefined) delete (globalThis as any).window
    else globalThis.window = previousWindow
    if (previousMemory === undefined) delete (performance as any).measureUserAgentSpecificMemory
    else (performance as any).measureUserAgentSpecificMemory = previousMemory
  }
})
