import Sortable from '../vendor/sortable.esm.js'
import { basePaper, placePage, shownSize, sizeName, norm, MM } from './layout.js'

const $ = (sel) => document.querySelector(sel)
const PDFJS = new URL('../vendor/pdfjs/', import.meta.url).href
const PDFJS_OPTIONS = {
  cMapUrl: PDFJS + 'cmaps/',
  cMapPacked: true,
  standardFontDataUrl: PDFJS + 'standard_fonts/',
  wasmUrl: PDFJS + 'wasm/',
  iccUrl: PDFJS + 'iccs/',
  enableXfa: false,
}
const THUMB_PX = 380 // long side of a page thumbnail
const RASTER_DPI = 200 // for PDFs that can only be copied as pictures
const MAX_CANVAS = 16_000_000 // iOS Safari canvas limit is 16.7 MP
const STAGE = 0.78 // width / height of the box each thumbnail sits in
const COLORS = ['#2f6fed', '#e5484d', '#2f9e44', '#f2711c', '#7c5cdb', '#0c9488', '#d6409f', '#c29200']

let pdfjsPromise
const getPdfjs = () => (pdfjsPromise ??= import('../vendor/pdfjs/pdf.min.mjs').then((m) => {
  m.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs'
  return m
}))
let mergePromise
const getMerge = () => (mergePromise ??= import('./merge.js'))

/* ── state ─────────────────────────────────────────── */

const DEFAULTS = { size: 'A4', customW: 210, customH: 297, orient: 'auto', fit: 'contain', margin: 0, upscale: true, name: '합본' }
const SETTINGS_KEY = 'pdf-merge:settings'
const settings = { ...DEFAULTS }
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')) } catch {}
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) } catch {} }

/** Sources: { id, name, kind: 'pdf'|'image', color, pages: [{w, h, rot}], thumbs: [url], ready, lib, raster, ... } */
let files = []
/** Output order: { id, src, index, rot } — rot is the user's extra turn in degrees (kept cumulative for the UI). */
let pages = []
let seq = 0
let colorSeq = 0
let busy = false

const cards = new Map() // page id -> <li>

/* ── adding files ──────────────────────────────────── */

const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
const isImage = (f) => f.type.startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif)$/i.test(f.name)

let addQueue = Promise.resolve()
function addFiles(list) {
  const all = [...list]
  const ok = all.filter((f) => isPdf(f) || isImage(f))
  const skipped = all.length - ok.length
  if (skipped) toast(`PDF나 사진이 아닌 파일 ${skipped}개는 뺐어요.`)
  // One at a time, in the order chosen, so pages come in the order of the files.
  for (const f of ok) addQueue = addQueue.then(() => addOne(f))
  return addQueue
}

async function addOne(file) {
  const src = {
    id: `f${++seq}`, name: file.name, kind: isPdf(file) ? 'pdf' : 'image',
    color: COLORS[colorSeq++ % COLORS.length], pages: [], thumbs: [], loading: true,
  }
  files.push(src)
  renderFiles()
  try {
    if (src.kind === 'pdf') await loadPdf(src, file)
    else await loadImage(src, file)
  } catch (err) {
    files = files.filter((f) => f !== src)
    disposeSource(src)
    renderFiles()
    if (!src.cancelled) toast(`"${file.name}"을(를) 열지 못했어요. ${err?.userMessage ?? '손상됐거나 지원하지 않는 파일이에요.'}`)
    else toast(`비밀번호를 넣지 않아 "${file.name}"은(는) 뺐어요.`)
    console.warn(file.name, err)
    return
  }
  src.loading = false
  for (let i = 0; i < src.pages.length; i++) pages.push({ id: `p${++seq}`, src, index: i, rot: 0 })
  changed()
}

async function loadPdf(src, file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const pdfjs = await getPdfjs()
  const task = pdfjs.getDocument({ data: bytes.slice(), ...PDFJS_OPTIONS })
  src.task = task
  task.onPassword = async (update, reason) => {
    const pw = await askPassword(file.name, reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD)
    if (pw === null) {
      src.cancelled = true
      task.destroy()
    } else update(pw)
  }
  const doc = await task.promise
  src.pdfjs = doc
  const n = doc.numPages
  for (let start = 1; start <= n; start += 64) {
    const batch = []
    for (let i = start; i < Math.min(n + 1, start + 64); i++) batch.push(doc.getPage(i))
    for (const pg of await Promise.all(batch)) {
      const [x0, y0, x1, y1] = pg.view
      src.pages.push({ w: Math.abs(x1 - x0), h: Math.abs(y1 - y0), rot: pg.rotate })
    }
  }
  src.thumbs = new Array(n)
  // pdf-lib copies pages as vectors; if it can't read the file (protected or unusual), pages go in as pictures.
  src.ready = (async () => {
    try {
      const { openForCopy } = await getMerge()
      const lib = await openForCopy(bytes)
      if (lib.getPageCount() !== n) throw new Error('page count differs')
      src.lib = lib
    } catch (err) {
      src.lib = null
      src.raster = /encrypt/i.test(String(err?.message)) ? '보호된 PDF라서 페이지를 그림으로 넣어요. 글자 선택·검색은 안 돼요.' : '구조가 특이한 PDF라서 페이지를 그림으로 넣어요. 글자 선택·검색은 안 돼요.'
      renderFiles()
    }
  })()
}

async function loadImage(src, file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const url = URL.createObjectURL(file)
  src.url = url
  const img = new Image()
  img.src = url
  try {
    await img.decode()
  } catch {
    const heic = /\.(heic|heif)$/i.test(file.name) || /hei[cf]/.test(file.type)
    throw Object.assign(new Error('decode'), {
      userMessage: heic ? '이 브라우저는 HEIC 사진을 못 읽어요. JPG로 바꿔서 넣어 주세요 (아이폰: 설정 › 카메라 › 포맷 › 높은 호환성).' : '이 브라우저가 읽을 수 없는 그림이에요.',
    })
  }
  src.img = img
  // Browsers show JPEGs turned by their EXIF orientation; the PDF gets the original JPEG plus the same turn.
  const nw = img.naturalWidth, nh = img.naturalHeight
  let image = null
  let rot = 0
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const info = jpegInfo(bytes)
    const turn = { 1: 0, 3: 180, 6: 90, 8: 270 }[info.orientation || 1]
    if (turn !== undefined && info.width) {
      const [sw, sh] = turn % 180 ? [info.height, info.width] : [info.width, info.height]
      if (sw === nw && sh === nh) {
        image = { type: 'jpg', bytes, w: info.width * 0.75, h: info.height * 0.75 }
        rot = turn
      }
    }
    if (!image) image = { type: 'jpg', bytes: await encodeImage(img, 'image/jpeg'), w: nw * 0.75, h: nh * 0.75 }
  } else if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    image = { type: 'png', bytes, w: nw * 0.75, h: nh * 0.75 }
  } else {
    image = { type: 'png', bytes: await encodeImage(img, 'image/png'), w: nw * 0.75, h: nh * 0.75 }
  }
  src.image = image
  src.pages = [{ w: image.w, h: image.h, rot }]
  src.thumbs = [await thumbFrom(img, nw, nh)]
  src.ready = Promise.resolve()
}

/** Orientation and pixel size from a JPEG header. */
function jpegInfo(b) {
  const out = { orientation: 0, width: 0, height: 0 }
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let p = 2
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) { p++; continue }
    const marker = b[p + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue }
    if (marker === 0xd9 || marker === 0xda) break
    const len = dv.getUint16(p + 2)
    if (marker === 0xe1 && !out.orientation && dv.getUint32(p + 4) === 0x45786966) { // "Exif"
      const t = p + 10
      const le = dv.getUint16(t) === 0x4949
      const ifd = t + dv.getUint32(t + 4, le)
      if (ifd + 2 <= b.length) {
        const count = dv.getUint16(ifd, le)
        for (let i = 0; i < count; i++) {
          const e = ifd + 2 + i * 12
          if (e + 12 > b.length) break
          if (dv.getUint16(e, le) === 0x0112) { out.orientation = dv.getUint16(e + 8, le); break }
        }
      }
    }
    if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      out.height = dv.getUint16(p + 5)
      out.width = dv.getUint16(p + 7)
    }
    p += 2 + len
  }
  return out
}

function canvasFor(w, h) {
  const scale = Math.min(1, Math.sqrt(MAX_CANVAS / (w * h)))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w * scale))
  c.height = Math.max(1, Math.round(h * scale))
  return c
}
const toBlob = (canvas, type, q) => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), type, q))

async function encodeImage(img, type) {
  const c = canvasFor(img.naturalWidth, img.naturalHeight)
  const ctx = c.getContext('2d')
  if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height) }
  ctx.drawImage(img, 0, 0, c.width, c.height)
  const blob = await toBlob(c, type, 0.92)
  c.width = c.height = 0
  return new Uint8Array(await blob.arrayBuffer())
}

async function thumbFrom(source, w, h) {
  const k = Math.min(1, THUMB_PX / Math.max(w, h))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w * k))
  c.height = Math.max(1, Math.round(h * k))
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.drawImage(source, 0, 0, c.width, c.height)
  return URL.createObjectURL(await toBlob(c, 'image/jpeg', 0.82))
}

/* ── thumbnails (rendered lazily, visible pages first) ── */

const thumbWanted = []
let thumbRunning = 0

function wantThumb(src, index) {
  if (src.thumbs[index] || !src.pdfjs) return
  const key = `${src.id}:${index}`
  if (thumbWanted.some((t) => t.key === key) || src.rendering?.has(index)) return
  thumbWanted.unshift({ key, src, index })
  pumpThumbs()
}

function pumpThumbs() {
  while (thumbRunning < 2 && thumbWanted.length) {
    const { src, index } = thumbWanted.shift()
    if (!files.includes(src)) continue
    thumbRunning++
    ;(src.rendering ??= new Set()).add(index)
    renderThumb(src, index)
      .then((url) => {
        src.thumbs[index] = url
        for (const p of pages) if (p.src === src && p.index === index) showThumb(cards.get(p.id), url)
      })
      .catch((err) => console.warn('thumb', err))
      .finally(() => { thumbRunning--; src.rendering.delete(index); pumpThumbs() })
  }
}

async function renderThumb(src, index) {
  const pdfjs = await getPdfjs()
  const pg = await src.pdfjs.getPage(index + 1)
  const v1 = pg.getViewport({ scale: 1 })
  const viewport = pg.getViewport({ scale: THUMB_PX / Math.max(v1.width, v1.height) })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  await pg.render({ canvas, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise
  const url = URL.createObjectURL(await toBlob(canvas, 'image/jpeg', 0.82))
  canvas.width = canvas.height = 0
  return url
}

const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue
    const p = pages.find((x) => x.id === e.target.dataset.id)
    if (p) wantThumb(p.src, p.index)
  }
}, { rootMargin: '600px 0px' })

/* ── rendering ─────────────────────────────────────── */

const ICONS = {
  grip: '<svg class="grip" viewBox="0 0 10 16" aria-hidden="true"><g fill="currentColor"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></g></svg>',
  close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  rotate: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M12.6 1.8v3h-3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function renderFiles() {
  const ul = $('#files')
  ul.innerHTML = files.map((f) => {
    const n = pages.filter((p) => p.src === f).length
    const meta = f.loading ? '<span class="spin" aria-label="여는 중"></span>' : `<span class="fmeta">${n}쪽</span>`
    const badge = f.raster ? `<span class="badge" title="${esc(f.raster)}">그림으로 들어감</span>` : ''
    return `<li class="file" data-id="${f.id}" style="--c:${f.color}">${ICONS.grip}<i class="dot"></i>
      <span class="fname-big" title="${esc(f.name)}">${esc(f.name)}</span>${badge}${meta}
      <button class="icon-btn del" type="button" data-remove="${f.id}" aria-label="${esc(f.name)} 빼기" title="파일 빼기">${ICONS.close}</button></li>`
  }).join('')
  $('#fileCount').textContent = files.length ? `${files.length}개` : ''
  $('#filesBox').hidden = !files.length
  document.body.classList.toggle('has-files', files.length > 0)
}

function makeCard(p) {
  const li = document.createElement('li')
  li.className = 'card-page'
  li.dataset.id = p.id
  li.tabIndex = 0
  li.innerHTML = `<div class="stage"><div class="paper"><div class="area"><div class="place"><img alt="" draggable="false"></div></div></div><span class="orig"></span></div>
    <div class="meta"><span class="num"></span><span class="from"><i class="dot"></i><span class="fname"></span></span></div>
    <div class="tools">
      <button class="icon-btn" type="button" data-act="rotate" title="오른쪽으로 돌리기 (R)" aria-label="오른쪽으로 돌리기">${ICONS.rotate}</button>
      <button class="icon-btn del" type="button" data-act="delete" title="이 페이지 빼기 (Delete)" aria-label="이 페이지 빼기">${ICONS.close}</button>
    </div>`
  const url = p.src.thumbs[p.index]
  if (url) showThumb(li, url)
  io.observe(li)
  return li
}

function showThumb(li, url) {
  if (!li) return
  const img = li.querySelector('img')
  if (img.getAttribute('src') === url) return
  img.onload = () => li.querySelector('.place').classList.add('loaded')
  img.src = url
}

/** Puts the cards in page order (reusing existing elements so Sortable and focus are undisturbed). */
function syncGrid() {
  const grid = $('#grid')
  const keep = new Set(pages.map((p) => p.id))
  for (const [id, el] of cards) if (!keep.has(id)) { io.unobserve(el); el.remove(); cards.delete(id) }
  pages.forEach((p, i) => {
    let el = cards.get(p.id)
    if (!el) cards.set(p.id, (el = makeCard(p)))
    if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] ?? null)
  })
  layoutCards()
}

/** Sizes every card's paper and page picture to match what the PDF will be. */
function layoutCards() {
  const infos = pages.map((p) => ({ w: p.src.pages[p.index].w, h: p.src.pages[p.index].h, rot: norm(p.src.pages[p.index].rot + p.rot) }))
  const paper = basePaper(settings, infos)
  pages.forEach((p, i) => {
    const el = cards.get(p.id)
    const info = infos[i]
    const pl = placePage(info, settings, paper)
    const [dw, dh] = shownSize(info.w, info.h, info.rot)
    const A = pl.W / pl.H
    const paperEl = el.querySelector('.paper')
    paperEl.style.width = A < STAGE ? `${(A / STAGE) * 92}%` : '92%'
    paperEl.style.height = A < STAGE ? '92%' : `${(STAGE / A) * 92}%`
    const area = el.querySelector('.area')
    area.style.inset = `${(pl.m / pl.H) * 100}% ${(pl.m / pl.W) * 100}%`
    el.classList.toggle('margin-on', pl.m > 0)
    const place = el.querySelector('.place')
    place.style.width = `${((dw * pl.s) / (pl.W - 2 * pl.m)) * 100}%`
    place.style.height = `${((dh * pl.s) / (pl.H - 2 * pl.m)) * 100}%`
    place.classList.toggle('odd', norm(p.rot) % 180 !== 0)
    place.querySelector('img').style.setProperty('--r', `${p.rot}deg`)

    el.querySelector('.num').textContent = i + 1
    el.style.setProperty('--c', p.src.color)
    el.querySelector('.fname').textContent = p.src.pages.length > 1 ? `${p.src.name} · ${p.index + 1}` : p.src.name
    const orig = sizeName(dw, dh)
    el.querySelector('.orig').textContent = orig
    el.title = `${p.src.name}${p.src.pages.length > 1 ? ` ${p.index + 1}쪽` : ''} · 원래 크기 ${orig}`
    el.setAttribute('aria-label', `${i + 1}번째 페이지: ${el.title}`)
  })
}

function renderSummary() {
  const n = pages.length
  $('#pageCount').textContent = n ? `${n}쪽` : ''
  $('#pagesBox').hidden = !n
  const mergeBtn = $('#merge')
  mergeBtn.disabled = !n || busy || files.some((f) => f.loading)
  mergeBtn.textContent = n ? `합쳐서 받기 · ${n}쪽` : '합쳐서 받기'
}

/** Call after any change to files, pages or settings. */
function changed() {
  // A file with no pages left has nothing to contribute.
  files = files.filter((f) => f.loading || pages.some((p) => p.src === f))
  renderFiles()
  syncGrid()
  renderSummary()
  clearResult()
}

/* ── settings panel ────────────────────────────────── */

function bindSettings() {
  const size = $('#size')
  size.value = settings.size
  $('#customW').value = settings.customW
  $('#customH').value = settings.customH
  for (const r of document.querySelectorAll('input[name="orient"]')) r.checked = r.value === settings.orient
  for (const r of document.querySelectorAll('input[name="fit"]')) r.checked = r.value === settings.fit
  $('#margin').value = settings.margin
  $('#upscale').checked = settings.upscale
  $('#name').value = settings.name

  const update = () => {
    settings.size = size.value
    settings.customW = $('#customW').value
    settings.customH = $('#customH').value
    settings.orient = document.querySelector('input[name="orient"]:checked').value
    settings.fit = document.querySelector('input[name="fit"]:checked').value
    settings.margin = Number($('#margin').value)
    settings.upscale = $('#upscale').checked
    saveSettings()
    reflectSettings()
    layoutCards()
    clearResult()
  }
  for (const el of document.querySelectorAll('.settings select, .settings input:not(#name)')) el.addEventListener('input', update)
  $('#name').addEventListener('input', () => { settings.name = $('#name').value; saveSettings() })
  reflectSettings()
}

function reflectSettings() {
  const panel = $('.settings')
  panel.classList.toggle('is-original', settings.size === 'original')
  panel.classList.toggle('is-fill', settings.fit === 'fill')
  $('#custom').hidden = settings.size !== 'custom'
  $('#marginOut').textContent = `${settings.margin}mm`
  const notes = {
    first: '첫 페이지 크기에 나머지를 맞춰요.',
    common: '여러 페이지가 쓰는 크기에 나머지를 맞춰요.',
    original: '페이지 크기는 그대로 두고 순서대로 합치기만 해요.',
  }
  $('#sizeNote').textContent = notes[settings.size] ?? ''
  document.querySelector('[data-note="orient"]').textContent = {
    auto: '가로로 긴 페이지는 같은 크기의 가로 용지에 놓여요.',
    portrait: '모든 페이지를 세로 용지에 놓아요.',
    landscape: '모든 페이지를 가로 용지에 놓아요.',
  }[settings.orient]
  document.querySelector('[data-note="fit"]').textContent = settings.fit === 'fill'
    ? '빈틈 없이 채우고, 넘치는 가장자리는 잘라요.'
    : '내용이 잘리지 않게 비율을 지켜 넣어요.'
}

/* ── actions ───────────────────────────────────────── */

let undo = null // { files, pages, timer }

function withUndo(message, mutate) {
  finishUndo()
  const before = { files: [...files], pages: [...pages] }
  mutate()
  changed()
  undo = before
  toast(message, { label: '되돌리기', run: () => {
    if (undo !== before) return
    // Files still being opened were added after the snapshot; keep them.
    files = [...before.files, ...files.filter((f) => f.loading && !before.files.includes(f))]
    pages = before.pages
    undo = null
    changed()
  } }, () => { if (undo === before) finishUndo() })
}

/** Frees sources that were removed and can no longer come back. */
function finishUndo() {
  if (!undo) return
  const gone = undo.files.filter((f) => !files.includes(f))
  undo = null
  gone.forEach(disposeSource)
}

function disposeSource(src) {
  src.task?.destroy()
  for (const url of src.thumbs) if (url) URL.revokeObjectURL(url)
  if (src.url) URL.revokeObjectURL(src.url)
}

function deletePage(id) {
  const p = pages.find((x) => x.id === id)
  if (!p) return
  const i = pages.indexOf(p)
  withUndo(`${i + 1}번째 페이지를 뺐어요.`, () => { pages = pages.filter((x) => x !== p) })
  focusCard(Math.min(i, pages.length - 1))
}

function removeFile(id) {
  const f = files.find((x) => x.id === id)
  if (!f || f.loading) return
  withUndo(`"${f.name}"을(를) 뺐어요.`, () => {
    pages = pages.filter((p) => p.src !== f)
    files = files.filter((x) => x !== f)
  })
}

function rotatePage(id, by = 90) {
  const p = pages.find((x) => x.id === id)
  if (!p) return
  p.rot += by
  layoutCards()
  clearResult()
}

function movePage(id, delta) {
  const i = pages.findIndex((x) => x.id === id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= pages.length) return
  const [p] = pages.splice(i, 1)
  pages.splice(j, 0, p)
  syncGrid()
  clearResult()
  cards.get(id).focus()
}

function focusCard(i) {
  const p = pages[i]
  if (p) cards.get(p.id)?.focus()
}

/** Regroups pages by file order, keeping each file's own page order. */
function regroupByFiles() {
  const rank = new Map(files.map((f, i) => [f, i]))
  pages = pages.map((p, i) => [p, i]).sort((a, b) => rank.get(a[0].src) - rank.get(b[0].src) || a[1] - b[1]).map(([p]) => p)
}

function bindActions() {
  const input = $('#input')
  $('#pick').addEventListener('click', () => input.click())
  $('#more').addEventListener('click', () => input.click())
  $('#drop').addEventListener('click', (e) => { if (e.target === e.currentTarget) input.click() })
  input.addEventListener('change', () => { addFiles(input.files); input.value = '' })

  $('#files').addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]')
    if (b) removeFile(b.dataset.remove)
  })
  $('#grid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]')
    if (!b) return
    const id = b.closest('.card-page').dataset.id
    if (b.dataset.act === 'rotate') rotatePage(id)
    else deletePage(id)
  })
  $('#grid').addEventListener('keydown', (e) => {
    const li = e.target.closest('.card-page')
    if (!li || e.target !== li) return
    const id = li.dataset.id
    const i = pages.findIndex((p) => p.id === id)
    const cols = getComputedStyle($('#grid')).gridTemplateColumns.split(' ').length
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key]
    if (step && e.altKey) { e.preventDefault(); movePage(id, step) }
    else if (step) { e.preventDefault(); focusCard(Math.max(0, Math.min(pages.length - 1, i + step))) }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deletePage(id) }
    else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); rotatePage(id, e.shiftKey ? -90 : 90) }
  })

  $('#sortName').addEventListener('click', () => {
    const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' })
    files = [...files].sort((a, b) => collator.compare(a.name, b.name))
    regroupByFiles()
    changed()
  })
  $('#rotateAll').addEventListener('click', () => {
    for (const p of pages) p.rot += 90
    layoutCards()
    clearResult()
  })
  $('#clearAll').addEventListener('click', () => {
    withUndo('모두 비웠어요.', () => { pages = []; files = files.filter((f) => f.loading) })
  })
  $('#merge').addEventListener('click', merge)

  Sortable.create($('#grid'), {
    animation: 160,
    delay: 160,
    delayOnTouchOnly: true,
    filter: '.tools',
    preventOnFilter: false,
    onEnd: () => {
      const order = [...$('#grid').children].map((el) => el.dataset.id)
      const byId = new Map(pages.map((p) => [p.id, p]))
      pages = order.map((id) => byId.get(id)).filter(Boolean)
      layoutCards()
      clearResult()
    },
  })
  Sortable.create($('#files'), {
    animation: 160,
    delay: 160,
    delayOnTouchOnly: true,
    filter: '[data-remove]',
    preventOnFilter: false,
    onEnd: () => {
      const order = [...$('#files').children].map((el) => el.dataset.id)
      files = order.map((id) => files.find((f) => f.id === id)).filter(Boolean)
      regroupByFiles()
      changed()
    },
  })

  // Dropping files anywhere on the page.
  const overlay = $('#dropOverlay')
  let depth = 0
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files')
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; overlay.hidden = false } })
  window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; overlay.hidden = true } })
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault() })
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth = 0
    overlay.hidden = true
    addFiles(e.dataTransfer.files)
  })
  // Pasting files (e.g. a copied screenshot).
  window.addEventListener('paste', (e) => {
    const list = [...(e.clipboardData?.files ?? [])]
    if (list.length) addFiles(list)
  })
}

/* ── merging ───────────────────────────────────────── */

let resultUrl = null

async function rasterPage(src, index) {
  const pdfjs = await getPdfjs()
  const pg = await src.pdfjs.getPage(index + 1)
  const v1 = pg.getViewport({ scale: 1 })
  const scale = Math.min(RASTER_DPI / 72, Math.sqrt(MAX_CANVAS / (v1.width * v1.height)), 8000 / Math.max(v1.width, v1.height))
  const viewport = pg.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  await pg.render({ canvas, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise
  const blob = await toBlob(canvas, 'image/jpeg', 0.9)
  canvas.width = canvas.height = 0
  pg.cleanup()
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w: v1.width, h: v1.height }
}

const reencode = (src) => encodeImage(src.img, 'image/png')

function fileName() {
  const base = (settings.name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\.pdf$/i, '').trim() || '합본'
  return `${base}.pdf`
}

async function merge() {
  if (busy || !pages.length) return
  busy = true
  renderSummary()
  clearResult()
  const progress = $('#progress')
  const bar = progress.querySelector('i')
  const text = progress.querySelector('.ptext')
  progress.hidden = false
  bar.style.width = '0%'
  text.textContent = '준비하는 중…'
  const items = pages.map((p) => ({ src: p.src, index: p.index, rot: p.rot }))
  const name = fileName()
  try {
    const { buildPdf } = await getMerge()
    await Promise.all(files.map((f) => f.ready))
    const bytes = await buildPdf(items, settings, {
      title: name.replace(/\.pdf$/, ''),
      raster: rasterPage,
      reencode,
      onProgress: (done, total) => {
        bar.style.width = `${(done / total) * 95}%`
        text.textContent = done < total ? `${done} / ${total}쪽 넣는 중…` : '파일로 묶는 중…'
      },
    })
    bar.style.width = '100%'
    if (resultUrl) URL.revokeObjectURL(resultUrl)
    resultUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
    download(resultUrl, name)
    showResult(name, items, bytes.length)
  } catch (err) {
    console.error(err)
    toast(`합치다가 문제가 생겼어요. (${err?.message ?? err})`)
  } finally {
    busy = false
    progress.hidden = true
    renderSummary()
  }
}

function download(url, name) {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
}

function showResult(name, items, size) {
  const raster = new Set(items.filter((it) => it.src.kind === 'pdf' && !it.src.lib).map((it) => it.src))
  const mb = size / 1024 / 1024
  const box = $('#result')
  box.innerHTML = `<div><strong>다 됐어요 ✓</strong>${esc(name)} · ${items.length}쪽 · ${mb >= 1 ? mb.toFixed(1) + 'MB' : Math.max(1, Math.round(size / 1024)) + 'KB'}</div>
    <div class="actions"><button class="btn small" type="button" data-r="save">다시 받기</button><a class="btn small" href="${resultUrl}" target="_blank" rel="noopener">새 탭에서 보기</a></div>
    ${raster.size ? `<p class="warn">보호되거나 특이한 PDF ${raster.size}개는 페이지가 그림으로 들어갔어요 (글자 선택 안 됨).</p>` : ''}`
  box.querySelector('[data-r="save"]').addEventListener('click', () => download(resultUrl, name))
  box.hidden = false
}

function clearResult() {
  $('#result').hidden = true
}

/* ── small UI helpers ──────────────────────────────── */

let toastTimer
let toastOnClose
function toast(message, action, onClose) {
  const el = $('#toast')
  clearTimeout(toastTimer)
  toastOnClose?.()
  toastOnClose = onClose
  el.innerHTML = ''
  const span = document.createElement('span')
  span.textContent = message
  el.append(span)
  el.classList.toggle('solo', !action)
  if (action) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = action.label
    b.addEventListener('click', () => { toastOnClose = null; hide(); action.run() })
    el.append(b)
  }
  el.hidden = false
  const hide = () => { el.hidden = true; const f = toastOnClose; toastOnClose = null; f?.() }
  toastTimer = setTimeout(hide, action ? 7000 : 5000)
}

function askPassword(name, retry) {
  const dlg = $('#pwDialog')
  const input = $('#pwInput')
  $('#pwMsg').textContent = retry ? '비밀번호가 맞지 않아요. 다시 입력해 주세요.' : `"${name}"을(를) 열려면 비밀번호가 필요해요.`
  input.value = ''
  return new Promise((resolve) => {
    const done = (v) => { dlg.removeEventListener('close', onClose); $('#pwCancel').onclick = null; resolve(v) }
    const onClose = () => done(dlg.returnValue === 'ok' && input.value ? input.value : null)
    dlg.addEventListener('close', onClose)
    $('#pwCancel').onclick = () => { dlg.returnValue = ''; dlg.close() }
    dlg.returnValue = ''
    dlg.showModal()
    input.focus()
  })
}

bindSettings()
bindActions()
renderFiles()
renderSummary()
// For tests and the console.
window.__pdfMerge = { get files() { return files }, get pages() { return pages }, settings, MM }
