# -*- coding: utf-8 -*-
from PIL import Image
from collections import deque

src = r"d:\brower\build\icon.png"
img = Image.open(src).convert("RGBA")
w, h = img.size
px = img.load()


def is_bg(r, g, b, a):
    if a < 10:
        return True
    mx = max(r, g, b)
    mn = min(r, g, b)
    # nearly neutral and bright (flat studio bg)
    if mx - mn <= 30 and mn >= 170:
        return True
    if r >= 228 and g >= 228 and b >= 228:
        return True
    return False


visited = [[False] * w for _ in range(h)]
q = deque()
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
    if not is_bg(r, g, b, a):
        continue
    px[x, y] = (0, 0, 0, 0)
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        q.append((x + dx, y + dy))

# Soften leftover fringe near transparent pixels
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        if a == 0:
            continue
        # if mostly bg-like and adjacent to transparent, fade it
        if is_bg(r, g, b, a):
            near = False
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h and px[nx, ny][3] == 0:
                    near = True
                    break
            if near:
                px[x, y] = (0, 0, 0, 0)

out_png = r"d:\brower\build\icon.png"
img.save(out_png, "PNG")
print("saved", out_png, img.size)

sizes = [16, 24, 32, 48, 64, 128, 256]
icons = [img.resize((s, s), Image.LANCZOS) for s in sizes]
ico_path = r"d:\brower\build\icon.ico"
# Pillow ICO: save largest with sizes param
icons[-1].save(
    ico_path,
    format="ICO",
    sizes=[(s, s) for s in sizes],
)
print("saved", ico_path)
print("corner rgba", Image.open(out_png).convert("RGBA").getpixel((2, 2)))
print("center rgba", Image.open(out_png).convert("RGBA").getpixel((w // 2, h // 2)))
