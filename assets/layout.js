// Page size math shared by the preview cards and the PDF writer, so what you see is what you get.
// All sizes are in PDF points (1/72 inch). "Shown" sizes are after rotation, as a viewer displays the page.

export const MM = 72 / 25.4

/** Paper sizes as [short, long] in mm. */
export const PAPERS = {
  A4: [210, 297],
  A3: [297, 420],
  A5: [148, 210],
  B4: [257, 364],
  B5: [182, 257],
  Letter: [215.9, 279.4],
  Legal: [215.9, 355.6],
}

export const PAPER_LABELS = {
  A4: 'A4 (210×297mm)',
  A3: 'A3 (297×420mm)',
  A5: 'A5 (148×210mm)',
  B4: 'B4 (257×364mm)',
  B5: 'B5 (182×257mm)',
  Letter: 'Letter (8.5×11in)',
  Legal: 'Legal (8.5×14in)',
}

export const norm = (deg) => ((Math.round(deg / 90) * 90) % 360 + 360) % 360

/** Size of a page as shown, given its unrotated box and total rotation. */
export function shownSize(w, h, rot) {
  return norm(rot) % 180 ? [h, w] : [w, h]
}

/** "A4", "Letter", or "123×45mm" for a size in points (either orientation). */
export function sizeName(w, h) {
  const a = Math.min(w, h) / MM
  const b = Math.max(w, h) / MM
  for (const [name, [s, l]] of Object.entries(PAPERS)) {
    if (Math.abs(a - s) < 1.5 && Math.abs(b - l) < 1.5) return name
  }
  return `${Math.round(w / MM)}×${Math.round(h / MM)}mm`
}

/**
 * The paper every page goes onto, as [short, long] in points, or null for "keep each page's own size".
 * `pages` are {w, h, rot} in shown order (needed for "same as first" and "most common").
 */
export function basePaper(settings, pages) {
  const { size } = settings
  if (size === 'original') return null
  if (PAPERS[size]) return PAPERS[size].map((v) => v * MM)
  if (size === 'custom') {
    const a = Math.max(10, Number(settings.customW) || 210) * MM
    const b = Math.max(10, Number(settings.customH) || 297) * MM
    return [Math.min(a, b), Math.max(a, b)]
  }
  if (!pages.length) return PAPERS.A4.map((v) => v * MM)
  if (size === 'first') {
    const [w, h] = shownSize(pages[0].w, pages[0].h, pages[0].rot)
    return [Math.min(w, h), Math.max(w, h)]
  }
  // 'common': the size (ignoring orientation) shared by the most pages; ties go to the earliest.
  const counts = new Map()
  for (const p of pages) {
    const key = `${Math.round(Math.min(p.w, p.h))}x${Math.round(Math.max(p.w, p.h))}`
    const c = counts.get(key) ?? { n: 0, dims: [Math.min(p.w, p.h), Math.max(p.w, p.h)] }
    c.n++
    counts.set(key, c)
  }
  let best = null
  for (const c of counts.values()) if (!best || c.n > best.n) best = c
  return best.dims
}

/**
 * Where one page lands on the output paper.
 * Returns the shown output size [W, H], the content scale `s`, and the margin `m` (points).
 * The content (shown size w*s × h*s) is always centred; in "fill" mode it is clipped to the area inside the margin.
 */
export function placePage(page, settings, paper) {
  const [dw, dh] = shownSize(page.w, page.h, page.rot)
  if (!paper) return { W: dw, H: dh, s: 1, m: 0, original: true }
  const [short, long] = paper
  const landscape = settings.orient === 'landscape' || (settings.orient === 'auto' && dw > dh)
  const W = landscape ? long : short
  const H = landscape ? short : long
  const m = Math.min(Math.max(0, Number(settings.margin) || 0) * MM, Math.min(W, H) / 2 - 1)
  const aw = W - 2 * m
  const ah = H - 2 * m
  let s = settings.fit === 'fill' ? Math.max(aw / dw, ah / dh) : Math.min(aw / dw, ah / dh)
  if (settings.fit !== 'fill' && !settings.upscale) s = Math.min(s, 1)
  return { W, H, s, m, original: false }
}
