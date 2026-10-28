# Prints what a merged PDF contains: each page's shown size, rotation, text, links, annotations,
# and colours sampled on a rendering. Saves page renders as <pdf>-<n>.png.
# usage: python check_output.py <merged.pdf>
import sys
import pymupdf

MM = 72 / 25.4
path = sys.argv[1]
doc = pymupdf.open(path)
print(f"{doc.page_count} pages, {len(open(path, 'rb').read()) // 1024} KB")
for i, p in enumerate(doc):
    r = p.rect  # shown size (rotation applied)
    text = " ".join(p.get_text().split())[:40]
    links = len(p.get_links())
    annots = [a.type[1] for a in p.annots()]
    widgets = len(list(p.widgets()))
    pix = p.get_pixmap(dpi=40)
    pix.save(f"{path}-{i+1}.png")
    def at(fx, fy):
        x = min(pix.width - 1, int(fx * pix.width)); y = min(pix.height - 1, int(fy * pix.height))
        return pix.pixel(x, y)
    reds = sum(1 for y in range(pix.height) for x in range(pix.width) if (lambda c: c[0] > 200 and c[1] < 60 and c[2] < 60)(pix.pixel(x, y)))
    print(f"{i+1:2}: {r.width/MM:6.1f}x{r.height/MM:6.1f}mm rot={p.rotation:3} text='{text}' links={links} annots={annots} widgets={widgets} "
          f"top={at(.5,.15)} mid={at(.5,.5)} bottom={at(.5,.85)} corner={at(.02,.02)} redpx={reds}")
