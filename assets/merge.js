// Builds the merged PDF with pdf-lib. PDF pages are copied as vectors (text stays selectable, links keep working);
// only protected or unreadable PDFs come in as rendered images.
import {
  PDFDocument, PDFName, PDFNumber, PDFArray, PDFDict, PDFStream, degrees,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, rectangle, clip, endPath, drawObject,
} from '../vendor/pdf-lib.esm.min.js'
import { basePaper, placePage, norm } from './layout.js'

/** Opens a PDF for copying pages. Throws for encrypted or broken files (the caller then rasterises instead). */
export async function openForCopy(bytes) {
  return PDFDocument.load(bytes, { updateMetadata: false })
}

const tick = () => new Promise((r) => setTimeout(r, 0))

const N = (name) => PDFName.of(name)
const num = (v) => (v instanceof PDFNumber ? v.asNumber() : null)

/** The visible box of a page (CropBox inside MediaBox), normalised so x0 < x1 and y0 < y1. */
function visibleBox(page) {
  const box = (r) => {
    const x0 = Math.min(r.x, r.x + r.width), x1 = Math.max(r.x, r.x + r.width)
    const y0 = Math.min(r.y, r.y + r.height), y1 = Math.max(r.y, r.y + r.height)
    return { x0, y0, x1, y1 }
  }
  const mb = box(page.getMediaBox())
  const cb = box(page.getCropBox())
  const x0 = Math.max(mb.x0, cb.x0), y0 = Math.max(mb.y0, cb.y0)
  const x1 = Math.min(mb.x1, cb.x1), y1 = Math.min(mb.y1, cb.y1)
  return x1 - x0 > 1 && y1 - y0 > 1 ? { x0, y0, x1, y1 } : mb
}

/**
 * Draws form-field widgets into the page content and removes them, so filled-in forms look the same after merging
 * (the merged file has no form of its own for them to belong to). Appearance placement follows PDF 32000 §12.5.5.
 */
function flattenWidgets(page) {
  const node = page.node
  const annots = node.Annots()
  if (!annots) return
  const keep = []
  const ops = []
  for (let i = 0; i < annots.size(); i++) {
    const ref = annots.get(i)
    const a = annots.lookup(i)
    if (!(a instanceof PDFDict) || a.lookup(N('Subtype')) !== N('Widget')) {
      keep.push(ref)
      continue
    }
    const flags = num(a.lookup(N('F'))) ?? 0
    if (flags & (2 | 32)) continue // Hidden / NoView
    const ap = a.lookup(N('AP'))
    if (!(ap instanceof PDFDict)) continue
    let apRef = ap.get(N('N'))
    let apObj = ap.lookup(N('N'))
    if (apObj instanceof PDFDict && !(apObj instanceof PDFStream)) {
      const state = a.lookup(N('AS'))
      apRef = state ? apObj.get(state) : undefined
      apObj = state ? apObj.lookup(state) : undefined
    }
    if (!(apObj instanceof PDFStream) || !apRef) continue
    const rect = a.lookup(N('Rect'))
    const bbox = apObj.dict.lookup(N('BBox'))
    if (!(rect instanceof PDFArray) || !(bbox instanceof PDFArray)) continue
    const r = [0, 1, 2, 3].map((k) => num(rect.lookup(k)) ?? 0)
    const b = [0, 1, 2, 3].map((k) => num(bbox.lookup(k)) ?? 0)
    const mArr = apObj.dict.lookup(N('Matrix'))
    const m = mArr instanceof PDFArray ? [0, 1, 2, 3, 4, 5].map((k) => num(mArr.lookup(k)) ?? 0) : [1, 0, 0, 1, 0, 0]
    const pts = [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]])
    const bx0 = Math.min(...pts.map((p) => p[0])), bx1 = Math.max(...pts.map((p) => p[0]))
    const by0 = Math.min(...pts.map((p) => p[1])), by1 = Math.max(...pts.map((p) => p[1]))
    const rx0 = Math.min(r[0], r[2]), rx1 = Math.max(r[0], r[2])
    const ry0 = Math.min(r[1], r[3]), ry1 = Math.max(r[1], r[3])
    if (bx1 - bx0 < 1e-6 || by1 - by0 < 1e-6) continue
    const sx = (rx1 - rx0) / (bx1 - bx0)
    const sy = (ry1 - ry0) / (by1 - by0)
    const name = node.newXObject('FlatWidget', apRef)
    ops.push(pushGraphicsState(), concatTransformationMatrix(sx, 0, 0, sy, rx0 - bx0 * sx, ry0 - by0 * sy), drawObject(name), popGraphicsState())
  }
  if (keep.length === annots.size()) return
  node.set(N('Annots'), page.doc.context.obj(keep))
  if (ops.length) {
    const stream = page.doc.context.register(page.createContentStream(...ops))
    node.Contents().push(stream)
  }
}

/** Moves the remaining annotations (links, comments, highlights) along with the content. */
function moveAnnots(page, s, tx, ty) {
  const annots = page.node.Annots()
  if (!annots) return
  const mapPairs = (arr) => {
    for (let j = 0; j + 1 < arr.size(); j += 2) {
      const x = num(arr.lookup(j)), y = num(arr.lookup(j + 1))
      if (x === null || y === null) continue
      arr.set(j, PDFNumber.of(x * s + tx))
      arr.set(j + 1, PDFNumber.of(y * s + ty))
    }
  }
  for (let i = 0; i < annots.size(); i++) {
    const a = annots.lookup(i)
    if (!(a instanceof PDFDict)) continue
    for (const key of ['Rect', 'QuadPoints', 'Vertices', 'L', 'CL']) {
      const arr = a.lookup(N(key))
      if (arr instanceof PDFArray) mapPairs(arr)
    }
    const ink = a.lookup(N('InkList'))
    if (ink instanceof PDFArray) for (let j = 0; j < ink.size(); j++) {
      const arr = ink.lookup(j)
      if (arr instanceof PDFArray) mapPairs(arr)
    }
    const rd = a.lookup(N('RD'))
    if (rd instanceof PDFArray) for (let j = 0; j < rd.size(); j++) {
      const v = num(rd.lookup(j))
      if (v !== null) rd.set(j, PDFNumber.of(v * s))
    }
  }
}

/** Resizes a copied PDF page in place: scales and centres its content on the new paper, clipped to what was visible. */
function fitVectorPage(page, place, rot) {
  const node = page.node
  const ctx = page.doc.context
  if (!node.Contents()) node.set(N('Contents'), ctx.obj([]))
  node.normalize()
  flattenWidgets(page)
  page.setRotation(degrees(rot))
  if (place.original) return

  const box = visibleBox(page)
  const { W, H, s, m } = place
  const [UW, UH] = rot % 180 ? [H, W] : [W, H]
  const cw = (box.x1 - box.x0) * s
  const ch = (box.y1 - box.y0) * s
  const ox = (UW - cw) / 2
  const oy = (UH - ch) / 2
  const tx = ox - box.x0 * s
  const ty = oy - box.y0 * s
  const cx0 = Math.max(ox, m), cy0 = Math.max(oy, m)
  const cx1 = Math.min(ox + cw, UW - m), cy1 = Math.min(oy + ch, UH - m)

  const start = ctx.register(page.createContentStream(
    pushGraphicsState(),
    rectangle(cx0, cy0, Math.max(0, cx1 - cx0), Math.max(0, cy1 - cy0)), clip(), endPath(),
    concatTransformationMatrix(s, 0, 0, s, tx, ty),
  ))
  const end = ctx.register(page.createContentStream(popGraphicsState()))
  node.wrapContentStreams(start, end)
  moveAnnots(page, s, tx, ty)

  page.setMediaBox(0, 0, UW, UH)
  for (const key of ['CropBox', 'BleedBox', 'TrimBox', 'ArtBox']) node.delete(N(key))
}

/** A new page holding one image of (unrotated) size iw × ih points. */
function addImagePage(out, image, iw, ih, place, rot) {
  const { W, H, s, m } = place
  const [UW, UH] = rot % 180 ? [H, W] : [W, H]
  const page = out.addPage([UW, UH])
  page.setRotation(degrees(rot))
  const cw = iw * s
  const ch = ih * s
  const x = (UW - cw) / 2
  const y = (UH - ch) / 2
  const cx0 = Math.max(x, m), cy0 = Math.max(y, m)
  const cx1 = Math.min(x + cw, UW - m), cy1 = Math.min(y + ch, UH - m)
  page.pushOperators(pushGraphicsState(), rectangle(cx0, cy0, Math.max(0, cx1 - cx0), Math.max(0, cy1 - cy0)), clip(), endPath())
  page.drawImage(image, { x, y, width: cw, height: ch })
  page.pushOperators(popGraphicsState())
}

/**
 * items: [{ src, index, rot }] in output order. src is one of:
 *   { kind: 'pdf', lib: PDFDocument, pages: [{w, h, rot}] }           — copied as vectors
 *   { kind: 'pdf', lib: null, pages }                                 — rendered via hooks.raster(src, index)
 *   { kind: 'image', image: { type: 'jpg'|'png', bytes, w, h }, pages } — w, h = unrotated size in points
 * hooks.raster resolves to { bytes: JPEG, w, h } with w × h the page's shown size in points (page /Rotate applied).
 */
export async function buildPdf(items, settings, { title, raster, reencode, onProgress }) {
  const out = await PDFDocument.create()
  out.setTitle(title)
  out.setCreator('PDF 합치기')
  out.setProducer('pdf-lib')

  const infos = items.map((it) => {
    const p = it.src.pages[it.index]
    return { w: p.w, h: p.h, rot: norm(p.rot + it.rot) }
  })
  const paper = basePaper(settings, infos)

  // Copy every page a source contributes in one call, so fonts and images it shares are stored only once.
  const copied = new Map()
  for (const it of items) {
    if (it.src.kind !== 'pdf' || !it.src.lib) continue
    if (!copied.has(it.src)) copied.set(it.src, [])
    copied.get(it.src).push(it.index)
  }
  for (const [src, indices] of copied) {
    const pages = await out.copyPages(src.lib, indices)
    copied.set(src, new Map(indices.map((ix, k) => [ix, pages[k]])))
    await tick()
  }

  const images = new Map()
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const place = placePage(infos[i], settings, paper)
    if (it.src.kind === 'pdf' && it.src.lib) {
      const page = copied.get(it.src).get(it.index)
      fitVectorPage(page, place, norm(page.getRotation().angle + it.rot))
      out.addPage(page)
    } else if (it.src.kind === 'pdf') {
      const r = await raster(it.src, it.index)
      const image = await out.embedJpg(r.bytes)
      addImagePage(out, image, r.w, r.h, place, norm(it.rot))
    } else {
      const img = it.src.image
      if (!images.has(it.src)) {
        let embedded
        try {
          embedded = img.type === 'jpg' ? await out.embedJpg(img.bytes) : await out.embedPng(img.bytes)
        } catch {
          // pdf-lib reads most PNG/JPEG variants but not all; the browser's own decoder is the fallback.
          embedded = await out.embedPng(await reencode(it.src))
        }
        images.set(it.src, embedded)
      }
      addImagePage(out, images.get(it.src), img.w, img.h, place, norm(it.src.pages[0].rot + it.rot))
    }
    onProgress?.(i + 1, items.length)
    await tick()
  }
  return out.save({ useObjectStreams: true })
}
