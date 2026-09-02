# -*- coding: utf-8 -*-
"""Knock out the solid black canvas behind the rounded app icon."""
from collections import deque
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "build" / "icon.png"
OUT_PNG = ROOT / "build" / "icon.png"
OUT_ICO = ROOT / "build" / "icon.ico"
INSTALLER_ICO = ROOT / "build" / "installerIcon.ico"
PAGE_PNG = ROOT / "server" / "download-page" / "app-icon.png"
ANDROID_PNG = ROOT / "android" / "app" / "src" / "main" / "res" / "drawable" / "ic_launcher.png"
ICO_SIZES = [(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64), (128, 128), (256, 256)]


def is_black_canvas(r: int, g: int, b: int, a: int) -> bool:
    if a < 10:
        return True
    # Exported studio canvas is near-black; the green squircle starts much brighter.
    return r <= 10 and g <= 10 and b <= 10


def knockout(img: Image.Image) -> Image.Image:
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()
    visited = [[False] * w for _ in range(h)]
    q: deque[tuple[int, int]] = deque()

    for x in range(w):
        q.append((x, 0))
        q.append((x, h - 1))
    for y in range(h):
        q.append((0, y))
        q.append((w - 1, y))

    while q:
        x, y = q.popleft()
        if x < 0 or y < 0 or x >= w or y >= h or visited[y][x]:
            continue
        visited[y][x] = True
        r, g, b, a = px[x, y]
        if not is_black_canvas(r, g, b, a):
            continue
        px[x, y] = (0, 0, 0, 0)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            q.append((x + dx, y + dy))

    # Drop the 1px silhouette that was anti-aliased against black.
    # Compare each edge pixel to a neighbor toward the center so the
    # designed dark-green bottom of the icon is kept.
    cx, cy = w / 2, h / 2
    to_clear: list[tuple[int, int]] = []
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            near_clear = False
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h and px[nx, ny][3] == 0:
                    near_clear = True
                    break
            if not near_clear:
                continue
            vx, vy = cx - x, cy - y
            dist = (vx * vx + vy * vy) ** 0.5 or 1
            ix = int(round(x + 3 * vx / dist))
            iy = int(round(y + 3 * vy / dist))
            if not (0 <= ix < w and 0 <= iy < h):
                continue
            ir, ig, ib, ia = px[ix, iy]
            if ia < 200:
                continue
            if g < ig * 0.72 and (r + g + b) < (ir + ig + ib) * 0.72:
                to_clear.append((x, y))
    for x, y in to_clear:
        px[x, y] = (0, 0, 0, 0)
    return img


def save_ico(img: Image.Image, path: Path) -> None:
    frames = [img.resize(size, Image.Resampling.LANCZOS) for size in ICO_SIZES]
    frames[-1].save(path, format="ICO", sizes=ICO_SIZES, append_images=frames[:-1])


def main() -> None:
    src = Image.open(SRC)
    knocked = knockout(src)
    knocked.save(OUT_PNG, "PNG")
    save_ico(knocked, OUT_ICO)
    save_ico(knocked, INSTALLER_ICO)
    knocked.save(PAGE_PNG, "PNG")
    knocked.resize((512, 512), Image.Resampling.LANCZOS).save(ANDROID_PNG, "PNG")

    w, h = knocked.size
    print("saved", OUT_PNG, knocked.size)
    print("saved", OUT_ICO)
    print("corner rgba", knocked.getpixel((2, 2)))
    print("edge mid rgba", knocked.getpixel((w // 2, 0)))
    print("center rgba", knocked.getpixel((w // 2, h // 2)))


if __name__ == "__main__":
    main()
