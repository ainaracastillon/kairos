"""Genera los iconos PNG de Kairos con la misma geometría que public/logo.svg (cuadrícula de 32×32)."""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'icons')
NAVY, GOLD, WHITE = (20, 33, 61, 255), (252, 163, 17, 255), (255, 255, 255, 255)
SS = 8  # supermuestreo para bordes suaves
STAR = [(24.8, 4.6), (25.5, 6.3), (27.2, 7.0), (25.5, 7.7), (24.8, 9.4), (24.1, 7.7), (22.4, 7.0), (24.1, 6.3)]


def draw_mark(d, s, o, ink=WHITE, accent=GOLD, star=True):
    P = lambda x, y: (o + x * s, o + y * s)

    def stroke(points, width, color):
        pts = [P(*p) for p in points]
        w = width * s
        d.line(pts, fill=color, width=round(w))
        for x, y in pts:
            d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=color)

    cx, cy = P(16, 16)
    r = 11.5 * s  # el trazo del SVG (2) va centrado en el radio 10,5
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=ink, width=round(2 * s))
    stroke([(15.2, 9.05), (15.2, 11.35)], 1, ink)
    stroke([(16.8, 9.05), (15.45, 10.2), (16.8, 11.35)], 1, ink)
    stroke([(16, 17), (21.2, 12.6)], 2.6, accent)
    x, y = P(16, 17)
    rr = 1.8 * s
    d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=accent)
    if star:
        d.polygon([P(*p) for p in STAR], fill=accent)


def make(size, kind):
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if kind == 'rounded':
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=8 * S / 32, fill=NAVY)
        draw_mark(d, S / 32, 0)
    elif kind == 'square':
        d.rectangle([0, 0, S, S], fill=NAVY)
        draw_mark(d, S / 32, 0)
    elif kind == 'maskable':
        d.rectangle([0, 0, S, S], fill=NAVY)
        s = S * 0.8 / 32
        draw_mark(d, s, (S - 32 * s) / 2)
    elif kind == 'badge':
        s = S / 32
        draw_mark(d, s, 0, ink=WHITE, accent=WHITE, star=False)
    return img.resize((size, size), Image.LANCZOS)


for name, size, kind in [('icon-192', 192, 'rounded'), ('icon-512', 512, 'rounded'), ('maskable-512', 512, 'maskable'),
                         ('apple-touch-icon', 180, 'square'), ('badge-96', 96, 'badge')]:
    make(size, kind).save(os.path.join(OUT, f'{name}.png'), optimize=True)
print('ok')
