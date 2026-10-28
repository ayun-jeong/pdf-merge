// E2E: open the site, choose settings, add files, merge, and save the downloaded PDF.
// usage: node tests/e2e.mjs <url> <out dir> '<settings json>' <file> [file ...]
//   settings json: {"size":"A4","orient":"auto","fit":"contain","margin":0,"upscale":true,"password":"1234","width":1280}
import fs from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const [url, out, json, ...files] = process.argv.slice(2)
const opt = JSON.parse(json || '{}')
fs.mkdirSync(out, { recursive: true })
for (const f of fs.readdirSync(out)) if (f.endsWith('.pdf')) fs.rmSync(path.join(out, f))

const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const page = await browser.newPage()
await page.setViewport({ width: opt.width ?? 1280, height: 900, deviceScaleFactor: opt.dpr ?? 1, isMobile: !!opt.mobile, hasTouch: !!opt.mobile })
const logs = []
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`))
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))
page.on('requestfailed', (r) => logs.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`))
const cdp = await page.createCDPSession()
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: path.resolve(out), eventsEnabled: true })

await page.goto(url, { waitUntil: 'networkidle0' })
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle0' })
await page.screenshot({ path: path.join(out, '0-empty.png') })

if (opt.size) await page.select('#size', opt.size)
if (opt.customW) { await page.$eval('#customW', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }, String(opt.customW)) }
if (opt.customH) { await page.$eval('#customH', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }, String(opt.customH)) }
if (opt.orient) await page.click(`input[name="orient"][value="${opt.orient}"]`)
if (opt.fit) await page.click(`input[name="fit"][value="${opt.fit}"]`)
if (opt.margin != null) await page.$eval('#margin', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }, String(opt.margin))
if (opt.upscale === false) await page.click('#upscale')

const t0 = Date.now()
await (await page.$('#input')).uploadFile(...files.map((f) => path.resolve(f)))
// Answer the password prompt if one appears, until every file has finished opening.
for (;;) {
  const state = await page.evaluate(() => ({
    dialog: document.querySelector('#pwDialog').open,
    loading: window.__pdfMerge.files.some((f) => f.loading),
    files: window.__pdfMerge.files.length,
  }))
  if (state.dialog) {
    await page.type('#pwInput', opt.password ?? '')
    await page.click('#pwForm button[type="submit"]')
  } else if (!state.loading && state.files) break
  await new Promise((r) => setTimeout(r, 150))
}
// Thumbnails render lazily (near the viewport), so wait for the first dozen only.
await page.waitForFunction(() => [...document.querySelectorAll('.place')].slice(0, 12).every((p) => p.classList.contains('loaded')), { timeout: 60000, polling: 200 })
console.log('opened in', ((Date.now() - t0) / 1000).toFixed(1), 's')
console.log(await page.evaluate(() => [...document.querySelectorAll('.file')].map((f) => f.innerText.replace(/\s+/g, ' ').trim()).join('\n')))
await page.screenshot({ path: path.join(out, '1-pages.png'), fullPage: true })

if (opt.actions) {
  // e.g. [["rotate", 2], ["delete", 0], ["move", 3, -1]]
  for (const [act, i, d] of opt.actions) {
    await page.evaluate((act, i, d) => {
      const cards = [...document.querySelectorAll('.card-page')]
      const el = cards[i]
      if (act === 'move') {
        el.focus()
        el.dispatchEvent(new KeyboardEvent('keydown', { key: d < 0 ? 'ArrowLeft' : 'ArrowRight', altKey: true, bubbles: true }))
      } else el.querySelector(`[data-act="${act}"]`).click()
    }, act, i, d)
  }
  await page.screenshot({ path: path.join(out, '2-edited.png'), fullPage: true })
}

const tm = Date.now()
await page.click('#merge')
let pdf
for (let i = 0; i < 600; i++) {
  pdf = fs.readdirSync(out).find((x) => x.endsWith('.pdf'))
  if (pdf) break
  await new Promise((r) => setTimeout(r, 100))
}
await page.waitForFunction(() => !document.querySelector('#result').hidden, { timeout: 60000 })
console.log('result:', await page.$eval('#result', (el) => el.innerText.replace(/\s+/g, ' ')))
await page.screenshot({ path: path.join(out, '3-done.png'), fullPage: true })
console.log('downloaded:', pdf, 'merge took', ((Date.now() - tm) / 1000).toFixed(1), 's')
const errors = logs.filter((l) => /error|failed/i.test(l))
console.log(errors.length ? errors.join('\n') : 'no console errors')
await browser.close()
