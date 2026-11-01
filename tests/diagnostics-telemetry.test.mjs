import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server, reporting, resources
let originalFetch, originalStorage
const calls = []
const values = new Map()

before(async () => {
  process.env.VITE_POSTHOG_TOKEN = 'test-public-token'
  process.env.VITE_POSTHOG_REGION = 'eu'
  originalFetch = globalThis.fetch
  originalStorage = globalThis.localStorage
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  }
  globalThis.fetch = async (...args) => { calls.push(args); return new Response() }
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' })
  reporting = await server.ssrLoadModule('/src/lib/diagnostics/reporting.ts')
  resources = await server.ssrLoadModule('/src/lib/diagnostics/resources.ts')
})
after(async () => {
  await server?.close()
  globalThis.fetch = originalFetch
  if (originalStorage === undefined) delete globalThis.localStorage
  else globalThis.localStorage = originalStorage
  delete process.env.VITE_POSTHOG_TOKEN
  delete process.env.VITE_POSTHOG_REGION
})

test('sends only a bounded diagnostic after consent and stops after opt-out', () => {
  const release = resources.trackResource('writer')
  try {
    assert.equal(reporting.isTelemetryConfigured(), true)
    assert.equal(reporting.telemetryEnabled(), false)
    reporting.inspectAfterRecording()
    assert.equal(calls.length, 0)
    assert.equal(reporting.setTelemetryEnabled(true), true)
    reporting.inspectAfterRecording()
    reporting.inspectAfterRecording()
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], 'https://eu.i.posthog.com/i/v0/e/')
    const payload = JSON.parse(calls[0][1].body)
    assert.equal(payload.event, 'diagnostic_resource_suspected')
    assert.deepEqual(Object.keys(payload.properties).sort(), ['$process_person_profile', 'count', 'distinct_id', 'issue', 'operation', 'version'])
    assert.equal(reporting.setTelemetryEnabled(false), false)
    reporting.inspectAfterRecording()
    assert.equal(calls.length, 1)
  } finally { release() }
})
