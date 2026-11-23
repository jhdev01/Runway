#!/usr/bin/env python3
"""Draws the artwork behind the icons in the mounted DMG window.

Writes build/dmg-background.png (640 x 660) and build/dmg-background@2x.png
(1280 x 1320). make-dmg.sh combines them into one Retina-aware TIFF with
`tiffutil`. Both PNGs are committed, so CI never runs this script; run it by
hand after changing the layout:

    python3 build/make-dmg-background.py

Needs Pillow plus the Inter and JetBrains Mono fonts (paths below; pass
--fonts DIR to look somewhere else).

Layout, in top-down points. Icon centres must match make-dmg.sh:
  Runway.app           (160, 190)
  Applications link    (480, 190)
  Install Help.html    (320, 450)
The window opens 660 tall so the bottom icon still fits when Finder shows
its path bar and status bar (about 90 pt between them).
"""

import argparse
import os

from PIL import Image, ImageDraw, ImageFont

W, H = 640, 660
HERE = os.path.dirname(os.path.abspath(__file__))

FONT_FILES = {
    "regular": ["Inter-Regular.otf", "Inter-Regular.ttf"],
    "semibold": ["Inter-SemiBold.otf", "Inter-SemiBold.ttf"],
    "bold": ["Inter-Bold.otf", "Inter-Bold.ttf"],
    "mono": ["JetBrainsMono-Medium.ttf"],
}
FONT_DIRS = [
    "/usr/share/fonts/opentype/inter",
    "/usr/share/fonts/truetype/jetbrains-mono",
    os.path.expanduser("~/Library/Fonts"),
    "/Library/Fonts",
]

BG_TOP = (10, 15, 26)
BG_BOTTOM = (5, 8, 13)
TEAL_STRIPE = (21, 184, 166)
TEAL_TEXT = (102, 235, 217)
ARROW = (77, 217, 199)
WHITE = (255, 255, 255)
SOFT = (199, 207, 211)
DIM = (140, 150, 156)
CODE = (153, 242, 235)
CODE_BOX = (3, 5, 8)
RULE = (34, 42, 48)
TARGET = (45, 120, 110)


def find_font(kind, extra_dirs):
    for d in extra_dirs + FONT_DIRS:
        for name in FONT_FILES[kind]:
            p = os.path.join(d, name)
            if os.path.exists(p):
                return p
    raise SystemExit(f"Font for '{kind}' not found; pass --fonts DIR")


def render(scale, fonts):
    s = scale
    img = Image.new("RGB", (W * s, H * s))
    d = ImageDraw.Draw(img)

    # vertical gradient
    for y in range(H * s):
        t = y / (H * s - 1)
        c = tuple(round(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3))
        d.line([(0, y), (W * s, y)], fill=c)
    d.rectangle([0, 0, W * s, 3 * s - 1], fill=TEAL_STRIPE)

    def font(kind, size):
        return ImageFont.truetype(fonts[kind], size * s)

    def centred(text, y_top, f, fill, tracking=0):
        if tracking:
            # letter-spaced caps: draw glyph by glyph
            widths = [d.textlength(ch, font=f) for ch in text]
            total = sum(widths) + tracking * s * (len(text) - 1)
            x = (W * s - total) / 2
            for ch, w in zip(text, widths):
                d.text((x, y_top * s), ch, font=f, fill=fill)
                x += w + tracking * s
        else:
            w = d.textlength(text, font=f)
            d.text(((W * s - w) / 2, y_top * s), text, font=f, fill=fill)

    centred("Install Runway", 22, font("bold", 24), WHITE)
    centred("Two steps, about a minute. Only needed once per new version.", 58, font("regular", 12), DIM)

    centred("STEP 1   DRAG RUNWAY ONTO APPLICATIONS", 98, font("semibold", 12), TEAL_TEXT, tracking=1.2)

    # arrow at icon-centre height
    y = 190 * s
    d.line([(240 * s, y), (400 * s, y)], fill=ARROW, width=round(2.5 * s))
    d.polygon([(412 * s, y), (398 * s, y - 7 * s), (398 * s, y + 7 * s)], fill=ARROW)

    # drop-target outline around the Applications icon and its label
    d.rounded_rectangle(
        [(480 - 62) * s, 128 * s, (480 + 62) * s, 274 * s],
        radius=16 * s, outline=TARGET, width=round(1.5 * s),
    )

    # divider between the steps
    d.line([(60 * s, 292 * s), ((W - 60) * s, 292 * s)], fill=RULE, width=s)

    centred("STEP 2   CLEAR THE DOWNLOAD BLOCK", 310, font("semibold", 12), TEAL_TEXT, tracking=1.2)
    centred("Open Install Help below and click Copy, then paste into Terminal:", 334, font("regular", 12), SOFT)

    d.rounded_rectangle([150 * s, 356 * s, 490 * s, 386 * s], radius=7 * s, fill=CODE_BOX)
    centred("xattr -cr /Applications/Runway.app", 363, font("mono", 13), CODE)

    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fonts", action="append", default=[], help="extra font directory")
    args = ap.parse_args()
    fonts = {k: find_font(k, args.fonts) for k in FONT_FILES}
    render(1, fonts).save(os.path.join(HERE, "dmg-background.png"), dpi=(72, 72))
    render(2, fonts).save(os.path.join(HERE, "dmg-background@2x.png"), dpi=(144, 144))
    print("[dmg-bg] wrote dmg-background.png and dmg-background@2x.png")


if __name__ == "__main__":
    main()
