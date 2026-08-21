#!/usr/bin/env python3
"""Generate the full PWA icon set for TV Time Revival.

Brand: gold (#f5c518) tile, dark "tv" wordmark — matching the in-app mark.

Produces two variants per size, per the maskable-icon spec:
  - icon-<n>.png           rounded tile on transparency   (purpose "any")
  - icon-maskable-<n>.png  full-bleed gold, glyph in the   (purpose "maskable")
                           center 80% safe zone
Plus favicon.ico (multi-size) and apple-touch-icon-180.png.

Everything is rendered at 4x and downscaled with LANCZOS for crisp edges.
Run: python3 tools/gen-icons.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
PUBLIC = os.path.join(PROJECT, "public")
ICONS = os.path.join(PUBLIC, "icons")

GOLD = (245, 197, 24, 255)   # #f5c518
DARK = (26, 22, 0, 255)      # #1a1600
FONT_PATH = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
SIZES = [72, 96, 128, 144, 152, 192, 384, 512]
SS = 4  # supersample factor
TEXT = "tv"


def load_font(px: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_PATH, px)


def fit_font(draw: ImageDraw.ImageDraw, target_w: float) -> ImageFont.FreeTypeFont:
    """Binary-search a font size whose 'tv' width ~= target_w."""
    lo, hi = 8, 4000
    best = load_font(lo)
    for _ in range(40):
        mid = (lo + hi) // 2
        f = load_font(mid)
        w = draw.textlength(TEXT, font=f)
        if w <= target_w:
            best = f
            lo = mid + 1
        else:
            hi = mid - 1
    return best


def draw_glyph(img: Image.Image, box: int) -> None:
    """Center the 'tv' wordmark, sized to `box` px width, on `img`."""
    d = ImageDraw.Draw(img)
    font = fit_font(d, box)
    # measure with real bbox for true vertical centering
    l, t, r, b = d.textbbox((0, 0), TEXT, font=font)
    tw, th = r - l, b - t
    x = (img.width - tw) / 2 - l
    y = (img.height - th) / 2 - t
    d.text((x, y), TEXT, font=font, fill=DARK)


def rounded_mask(size: int, radius: int) -> Image.Image:
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def make_any(size: int) -> Image.Image:
    s = size * SS
    tile = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    # gold rounded tile with a hair of padding so the round corners breathe
    pad = int(s * 0.04)
    inner = s - 2 * pad
    gold = Image.new("RGBA", (inner, inner), GOLD)
    mask = rounded_mask(inner, radius=int(inner * 0.23))
    tile.paste(gold, (pad, pad), mask)
    draw_glyph(tile, box=inner * 0.52)  # glyph ~52% of tile width
    return tile.resize((size, size), Image.LANCZOS)


def make_maskable(size: int) -> Image.Image:
    s = size * SS
    # full-bleed gold; glyph kept inside the central 80% safe zone
    img = Image.new("RGBA", (s, s), GOLD)
    draw_glyph(img, box=s * 0.44)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(ICONS, exist_ok=True)
    for n in SIZES:
        make_any(n).save(os.path.join(ICONS, f"icon-{n}.png"))
        make_maskable(n).save(os.path.join(ICONS, f"icon-maskable-{n}.png"))

    # Apple touch icon — iOS masks it itself, so use the full-bleed variant at 180.
    make_maskable(180).save(os.path.join(ICONS, "apple-touch-icon.png"))

    # favicon.ico — multi-resolution, rounded variant
    fav = make_any(64)
    fav.save(
        os.path.join(PUBLIC, "favicon.ico"),
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64)],
    )

    made = [f"icon-{n}.png / icon-maskable-{n}.png" for n in SIZES]
    print("Generated PWA icon set:")
    for m in made:
        print("  ", m)
    print("   apple-touch-icon.png (180)")
    print("   favicon.ico (16/32/48/64)")


if __name__ == "__main__":
    main()
