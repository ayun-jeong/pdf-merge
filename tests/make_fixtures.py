# Builds test inputs with known shapes and colours.
# usage: python make_fixtures.py <out dir>   (needs pymupdf, pillow)
import sys, os, io
import pymupdf
from PIL import Image

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
A4 = (595.28, 841.89)

def border(page, rect, color, width=6):
    page.draw_rect(rect, color=color, width=width)

# 1. A4 portrait, 2 pages: blue border, text, a link and a highlight.
doc = pymupdf.open()
for i in range(2):
    p = doc.new_page(width=A4[0], height=A4[1])
    border(p, p.rect + (3, 3, -3, -3), (0, 0, 1))
    p.insert_text((60, 120), f"A4 page {i+1}", fontsize=40)
    if i == 0:
        p.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(60, 200, 300, 240), "uri": "https://example.com/"})
        p.insert_text((62, 230), "example link", fontsize=20, color=(0, 0, 1))
        p.add_highlight_annot(pymupdf.Rect(60, 90, 400, 130))
doc.save(f"{out}/a4.pdf")

# 2. Letter landscape: green border.
doc = pymupdf.open()
p = doc.new_page(width=792, height=612)
border(p, p.rect + (3, 3, -3, -3), (0, 0.6, 0))
p.insert_text((60, 120), "Letter landscape", fontsize=40)
doc.save(f"{out}/letter-land.pdf")

# 3. A4 with /Rotate 90: shown as landscape. Orange border, text along the unrotated page.
doc = pymupdf.open()
p = doc.new_page(width=A4[0], height=A4[1])
border(p, p.rect + (3, 3, -3, -3), (1, 0.5, 0))
p.insert_text((60, 120), "Rotate 90", fontsize=40)
p.set_rotation(90)
doc.save(f"{out}/rotated.pdf")

# 4. CropBox smaller than MediaBox: red outside the crop must never show.
doc = pymupdf.open()
p = doc.new_page(width=800, height=800)
p.draw_rect(p.rect, color=None, fill=(1, 0, 0))
crop = pymupdf.Rect(100, 100, 500, 700)
p.draw_rect(crop, color=None, fill=(1, 1, 1))
border(p, crop + (3, 3, -3, -3), (0.5, 0, 0.8))
p.insert_text((130, 200), "Cropped", fontsize=40)
p.set_cropbox(crop)
doc.save(f"{out}/crop.pdf")

# 5. Filled form: a text field and a ticked checkbox.
doc = pymupdf.open()
p = doc.new_page(width=A4[0], height=A4[1])
border(p, p.rect + (3, 3, -3, -3), (0.3, 0.3, 0.3))
w = pymupdf.Widget(); w.field_type = pymupdf.PDF_WIDGET_TYPE_TEXT; w.field_name = "who"
w.rect = pymupdf.Rect(60, 100, 400, 140); w.field_value = "Filled value"; w.text_fontsize = 20
p.add_widget(w)
c = pymupdf.Widget(); c.field_type = pymupdf.PDF_WIDGET_TYPE_CHECKBOX; c.field_name = "ok"
c.rect = pymupdf.Rect(60, 160, 100, 200); c.field_value = True
p.add_widget(c)
doc.save(f"{out}/form.pdf")

# 6. Receipt, 80 x 200 mm.
doc = pymupdf.open()
p = doc.new_page(width=80 * 72 / 25.4, height=200 * 72 / 25.4)
border(p, p.rect + (2, 2, -2, -2), (0.6, 0, 0.6), 4)
p.insert_text((15, 60), "Receipt", fontsize=24)
doc.save(f"{out}/receipt.pdf")

# 7. Protected (owner password only: opens without asking) and 8. user password "1234".
for name, user in (("protected.pdf", ""), ("userpw.pdf", "1234")):
    doc = pymupdf.open()
    p = doc.new_page(width=A4[0], height=A4[1])
    border(p, p.rect + (3, 3, -3, -3), (0, 0.5, 0.5))
    p.insert_text((60, 120), name, fontsize=36)
    doc.save(f"{out}/{name}", encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw=user,
             permissions=pymupdf.PDF_PERM_PRINT)

# 9. JPEG stored sideways with EXIF orientation 6: raw 400x300, left half red / right half blue.
#    Shown upright it is 300x400 with red on top and blue at the bottom.
im = Image.new("RGB", (400, 300), (255, 0, 0))
im.paste((0, 0, 255), (200, 0, 400, 300))
exif = Image.Exif(); exif[0x0112] = 6
im.save(f"{out}/photo-exif6.jpg", quality=92, exif=exif)

# 10. PNG with transparency, landscape 600x400: green with a transparent left third.
im = Image.new("RGBA", (600, 400), (0, 170, 0, 255))
im.paste((0, 0, 0, 0), (0, 0, 200, 400))
im.save(f"{out}/pic.png")

# 11. WebP (browser decodes it, then it goes in as PNG): yellow 300x300.
Image.new("RGB", (300, 300), (240, 200, 0)).save(f"{out}/pic.webp")
print("fixtures in", out)
