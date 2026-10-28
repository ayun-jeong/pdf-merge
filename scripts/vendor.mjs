// Copies the browser builds of the libraries into vendor/ so the site runs as plain static files (no build step).
// Run after changing versions in package.json: npm run vendor
import fs from 'node:fs'
import path from 'node:path'

const NM = 'node_modules'
const OUT = 'vendor'
fs.rmSync(OUT, { recursive: true, force: true })

function copy(from, to) {
  const dest = path.join(OUT, to)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(path.join(NM, from), dest, { recursive: true })
}

copy('pdf-lib/dist/pdf-lib.esm.min.js', 'pdf-lib.esm.min.js')
copy('sortablejs/modular/sortable.esm.js', 'sortable.esm.js')
copy('pdfjs-dist/legacy/build/pdf.min.mjs', 'pdfjs/pdf.min.mjs')
copy('pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'pdfjs/pdf.worker.min.mjs')
copy('pdfjs-dist/cmaps', 'pdfjs/cmaps')
copy('pdfjs-dist/standard_fonts', 'pdfjs/standard_fonts')
copy('pdfjs-dist/iccs', 'pdfjs/iccs')
for (const f of ['openjpeg.wasm', 'jbig2.wasm', 'qcms_bg.wasm']) copy(`pdfjs-dist/wasm/${f}`, `pdfjs/wasm/${f}`)

// Licenses get a .txt extension so GitHub Pages shows them instead of downloading them.
const licenses = {
  'pdf-lib.txt': 'pdf-lib/LICENSE.md',
  'sortablejs.txt': 'sortablejs/LICENSE',
  'pdfjs.txt': 'pdfjs-dist/LICENSE',
  'pdfjs-iccs.txt': 'pdfjs-dist/iccs/LICENSE',
}
for (const name of fs.readdirSync(path.join(NM, 'pdfjs-dist/wasm')).filter((f) => f.startsWith('LICENSE'))) {
  licenses[`pdfjs-wasm-${name.replace('LICENSE_', '').toLowerCase()}.txt`] = `pdfjs-dist/wasm/${name}`
}
for (const [to, from] of Object.entries(licenses)) copy(from, `licenses/${to}`)
fs.rmSync(path.join(OUT, 'pdfjs/iccs/LICENSE'), { force: true })

// GitHub Pages has no directory listings, so the footer link needs an index page.
const pkg = (name) => JSON.parse(fs.readFileSync(path.join(NM, name, 'package.json'), 'utf8')).version
const rows = Object.keys(licenses).sort().map((f) => `<li><a href="${f}">${f}</a></li>`).join('\n')
fs.writeFileSync(path.join(OUT, 'licenses/index.html'), `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>오픈소스 라이선스</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.6;color:#1c1c1e;background:#fff}
@media (prefers-color-scheme:dark){body{color:#ececee;background:#141416}a{color:#7090ff}}</style></head>
<body><h1>오픈소스 라이선스</h1>
<p>이 사이트는 아래 라이브러리를 그대로 포함해 씁니다: pdf-lib ${pkg('pdf-lib')} (MIT), PDF.js ${pkg('pdfjs-dist')} (Apache-2.0), SortableJS ${pkg('sortablejs')} (MIT).</p>
<ul>
${rows}
</ul>
<p><a href="../../">← PDF 합치기로 돌아가기</a></p>
</body></html>
`)
console.log('vendor/ ready')
