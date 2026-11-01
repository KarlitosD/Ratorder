import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { after, before, test } from 'node:test'
import puppeteer from 'puppeteer-core'
import { createServer } from 'vite'

let server, browser, origin
before(async () => {
  const executablePath = process.env.CHROMIUM_PATH ?? ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync)
  assert.ok(executablePath, 'Install Chromium or set CHROMIUM_PATH')
  server = await createServer({ server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  origin = server.resolvedUrls.local[0]
  browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
})
after(async () => { await browser?.close(); await server?.close() })

test('does not retain thumbnail URLs when the library closes during loading', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(origin)
    const result = await page.evaluate(async () => {
      const { mount, unmount, tick } = await import('/node_modules/.vite/deps/svelte.js')
      const { default: LibraryView } = await import('/src/lib/components/LibraryView.svelte')
      let resolveThumbnail
      const pending = new Promise(resolve => { resolveThumbnail = resolve })
      let created = 0
      const original = URL.createObjectURL
      URL.createObjectURL = (...args) => { created++; return original(...args) }
      const component = mount(LibraryView, { target: document.createElement('div'), props: {
        recordings: [{ id: 'one', thumbnail: 'thumb', title: 'Test', sourceLabel: '', createdAt: new Date().toISOString(), size: 1, durationMs: 1 }],
        loading: false, error: null, onGetThumbnail: () => pending,
      } })
      await tick()
      await unmount(component)
      resolveThumbnail(new File(['thumbnail'], 'thumbnail.png'))
      await new Promise(resolve => setTimeout(resolve, 0))
      return created
    })
    assert.equal(result, 0)
  } finally { await page.close() }
})

test('terminates the writer worker when opening fails', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(origin)
    const terminated = await page.evaluate(async () => {
      let terminated = false
      window.Worker = class {
        listeners = {}
        addEventListener(type, callback) { this.listeners[type] = callback }
        postMessage(message) { queueMicrotask(() => this.listeners.message({ data: { id: message.id, ok: false, error: 'open failed' } })) }
        terminate() { terminated = true }
      }
      const { OpfsStreamWriter } = await import('/src/lib/storage/opfs-stream-writer.ts')
      await OpfsStreamWriter.open('test', 'webm').catch(() => {})
      return terminated
    })
    assert.equal(terminated, true)
  } finally { await page.close() }
})

test('releases thumbnail URLs after repeatedly opening and closing the library', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(origin)
    const result = await page.evaluate(async () => {
      const { mount, unmount, tick } = await import('/node_modules/.vite/deps/svelte.js')
      const { default: LibraryView } = await import('/src/lib/components/LibraryView.svelte')
      const { getResourceCounts } = await import('/src/lib/diagnostics/resources.ts')
      const baseline = getResourceCounts().thumbnailUrl
      for (let i = 0; i < 20; i++) {
        const component = mount(LibraryView, { target: document.createElement('div'), props: {
          recordings: [{ id: 'one', thumbnail: 'thumb', title: 'Test', sourceLabel: '', createdAt: new Date().toISOString(), size: 1, durationMs: 1 }],
          loading: false, error: null, onGetThumbnail: async () => new File(['thumbnail'], 'thumbnail.png'),
        } })
        await tick()
        await new Promise(resolve => setTimeout(resolve, 0))
        await unmount(component)
      }
      return { baseline, final: getResourceCounts().thumbnailUrl }
    })
    assert.equal(result.final, result.baseline)
  } finally { await page.close() }
})

test('keeps diagnostics inside advanced recording settings', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(origin)
    assert.equal(await page.$('summary::-p-text(Diagnóstico)'), null)
    await page.locator('button::-p-text(Opciones avanzadas)').click()
    const summary = await page.$('summary::-p-text(Diagnóstico)')
    assert.ok(summary)
    assert.equal(await page.$eval('details.diagnostics-disclosure', el => el.open), false)
    await summary.click()
    assert.equal(await page.$eval('details.diagnostics-disclosure', el => el.open), true)
    assert.ok(await page.$('button::-p-text(Ver informe local)'))
  } finally { await page.close() }
})
