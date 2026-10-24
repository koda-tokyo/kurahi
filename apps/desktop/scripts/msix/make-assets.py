#!/usr/bin/env python3
"""Generate the MSIX visual assets for Kurahi Desktop from one large square PNG of the mark.

    python3 make-assets.py <mark-1024.png> <out-dir>

Writes two sets:
  <out-dir>/Assets/           unqualified names, scale-100 sizes. Used by the Linux-packed MSIX,
                              which has no resources.pri (makepri is Windows only), so Windows
                              loads exactly the file the manifest names.
  <out-dir>/Assets-scaled/    scale-100/200 and targetsize/altform-unplated variants. Used by
                              pack-msix.ps1 on Windows, which indexes them with makepri.
"""
import sys
from pathlib import Path

from PIL import Image

# name -> (width, height) at scale-100
TILES = {
    "Square44x44Logo": (44, 44),
    "Square150x150Logo": (150, 150),
    "Wide310x150Logo": (310, 150),
    "StoreLogo": (50, 50),
}
SCALES = (100, 200)
TARGET_SIZES = (16, 24, 32, 48, 256)  # taskbar / Start / file explorer icon sizes


def render(mark: Image.Image, w: int, h: int, fill: float) -> Image.Image:
    """The mark centred on a transparent canvas, its side `fill` of the shorter edge."""
    side = max(1, round(min(w, h) * fill))
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    m = mark.resize((side, side), Image.LANCZOS)
    canvas.paste(m, ((w - side) // 2, (h - side) // 2), m)
    return canvas


def fill_for(name: str) -> float:
    # The mark already has a 2/48 margin. Tiles get extra padding so it does not touch the
    # tile edge; the app-list icon and store logo use nearly the full square.
    return {"Square150x150Logo": 0.66, "Wide310x150Logo": 0.66}.get(name, 1.0)


def main() -> None:
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    mark = Image.open(src).convert("RGBA")
    plain, scaled = out / "Assets", out / "Assets-scaled"
    plain.mkdir(parents=True, exist_ok=True)
    scaled.mkdir(parents=True, exist_ok=True)
    for name, (w, h) in TILES.items():
        f = fill_for(name)
        render(mark, w, h, f).save(plain / f"{name}.png", optimize=True)
        for s in SCALES:
            render(mark, w * s // 100, h * s // 100, f).save(
                scaled / f"{name}.scale-{s}.png", optimize=True
            )
    for t in TARGET_SIZES:
        img = render(mark, t, t, 1.0)
        img.save(scaled / f"Square44x44Logo.targetsize-{t}.png", optimize=True)
        img.save(scaled / f"Square44x44Logo.targetsize-{t}_altform-unplated.png", optimize=True)
    for p in sorted(out.rglob("*.png")):
        with Image.open(p) as im:
            print(f"{p.relative_to(out)}  {im.size[0]}x{im.size[1]}")


if __name__ == "__main__":
    main()
