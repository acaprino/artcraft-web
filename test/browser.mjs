// Opens each engine's document in the demo (Web Worker + wasm) in headless Edge/Chromium and checks the rendered page.
// Usage: node test/browser.mjs [engine ...]   Env: PLAYWRIGHT_CHROMIUM_EXECUTABLE overrides the system Edge.
import { chromium } from 'playwright-core'
import { parseEngines, root } from '../scripts/common.mjs'
import { FIXTURES, SAMPLE_TEXT } from './fixtures.mjs'
import { startServer } from './server.mjs'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const { server, port } = await startServer()
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : { channel: 'msedge' })
const shots = join(root, '.cache/screenshots')
mkdirSync(shots, { recursive: true })
let failed = false

for (const engine of parseEngines(process.argv.slice(2))) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1100 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()) })
  try {
    await page.goto(`http://127.0.0.1:${port}/`)
    await page.evaluate(([bytes, name]) => window.__openBytes(new Uint8Array(bytes).buffer, name), [[...FIXTURES[engine]()], engine])
    await page.waitForFunction(() => document.getElementById('page-image').naturalWidth > 0 || document.getElementById('status').dataset.error !== undefined, null, { timeout: 90_000 })
    const result = await page.evaluate(() => {
      const image = document.getElementById('page-image')
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0)
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data
      let dark = 0
      for (let i = 0; i < data.length; i += 4) if (data[i] < 200) dark++
      return { width: canvas.width, height: canvas.height, status: document.getElementById('status').textContent, error: document.getElementById('status').dataset.error !== undefined, text: document.getElementById('text').textContent, dark, craft: window.__craft }
    })
    await page.screenshot({ path: join(shots, `${engine}.png`) })
    const ok = !errors.length && !result.error && result.dark > 100 && result.text.includes(SAMPLE_TEXT)
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${engine}: ${result.width}x${result.height}, ${result.dark} dark px, ${result.craft?.ms} ms, status "${result.status}"${errors.length ? `, errors ${JSON.stringify(errors)}` : ''}`)
    if (!ok) failed = true
  } catch (error) {
    console.log(`FAIL ${engine}: ${error.message}`)
    failed = true
  }
  await page.close()
}
await browser.close()
server.close()
if (failed) process.exitCode = 1
