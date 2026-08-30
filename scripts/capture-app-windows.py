"""Capture visible JianXing windows via PrintWindow."""
import ctypes
import sys
from ctypes import wintypes
from pathlib import Path

from PIL import Image

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

PW_RENDERFULLCONTENT = 0x00000002
SRCCOPY = 0x00CC0020

WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


def window_title(hwnd: int) -> str:
    n = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def window_class(hwnd: int) -> str:
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def window_pid(hwnd: int) -> int:
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return int(pid.value)


def jianxing_pids():
    import subprocess
    out = subprocess.check_output(
        'tasklist /FI "IMAGENAME eq JianXingBrowser.exe" /FO CSV /NH',
        shell=True,
        universal_newlines=True,
    )
    pids = set()
    for line in out.splitlines():
        parts = [p.strip().strip('"') for p in line.split(",")]
        if len(parts) >= 2 and parts[1].isdigit():
            pids.add(int(parts[1]))
    return pids


def list_jianxing():
    pids = jianxing_pids()
    found = []

    def cb(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        pid = window_pid(hwnd)
        if pid not in pids:
            return True
        title = window_title(hwnd)
        cls = window_class(hwnd)
        found.append((int(hwnd), pid, cls, title or "(no-title)"))
        return True

    user32.EnumWindows(WNDENUMPROC(cb), 0)
    extra = []
    for hwnd, pid, cls, title in list(found):
        def child_cb(child, _lparam):
            r = RECT()
            user32.GetClientRect(child, ctypes.byref(r))
            cw = r.right - r.left
            chh = r.bottom - r.top
            if cw >= 400 and chh >= 200:
                extra.append(
                    (int(child), pid, window_class(child), (title or "") + "-view")
                )
            return True

        user32.EnumChildWindows(hwnd, WNDENUMPROC(child_cb), 0)
    found.extend(extra)
    return found


def capture(hwnd):
    rect = RECT()
    user32.GetClientRect(hwnd, ctypes.byref(rect))
    w = rect.right - rect.left
    h = rect.bottom - rect.top
    if w < 200 or h < 150:
        return None

    hwnd_dc = user32.GetDC(hwnd)
    mem_dc = gdi32.CreateCompatibleDC(hwnd_dc)
    bmp = gdi32.CreateCompatibleBitmap(hwnd_dc, w, h)
    gdi32.SelectObject(mem_dc, bmp)

    ok = user32.PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT)
    if not ok:
        ok = user32.PrintWindow(hwnd, mem_dc, 0)

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [
            ("biSize", ctypes.c_uint32),
            ("biWidth", ctypes.c_int32),
            ("biHeight", ctypes.c_int32),
            ("biPlanes", ctypes.c_uint16),
            ("biBitCount", ctypes.c_uint16),
            ("biCompression", ctypes.c_uint32),
            ("biSizeImage", ctypes.c_uint32),
            ("biXPelsPerMeter", ctypes.c_int32),
            ("biYPelsPerMeter", ctypes.c_int32),
            ("biClrUsed", ctypes.c_uint32),
            ("biClrImportant", ctypes.c_uint32),
        ]

    class BITMAPINFO(ctypes.Structure):
        _fields_ = [("bmiHeader", BITMAPINFOHEADER)]

    info = BITMAPINFO()
    info.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    info.bmiHeader.biWidth = w
    info.bmiHeader.biHeight = -h
    info.bmiHeader.biPlanes = 1
    info.bmiHeader.biBitCount = 32
    info.bmiHeader.biCompression = 0
    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(mem_dc, bmp, 0, h, buf, ctypes.byref(info), 0)

    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mem_dc)
    user32.ReleaseDC(hwnd, hwnd_dc)

    img = Image.frombuffer("RGBA", (w, h), buf, "raw", "BGRA", 0, 1)
    return img.convert("RGB")


def slug(title: str) -> str:
    mapping = [
        ("家长", "parent"),
        ("历史", "history"),
        ("书签", "bookmarks"),
        ("下载", "downloads"),
        ("密码", "passwords"),
        ("更新", "update"),
        ("简行浏览器", "browser"),
    ]
    for key, name in mapping:
        if key in title:
            return name
    return "window"


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else r"D:\brower\server\download-page\assets")
    out.mkdir(parents=True, exist_ok=True)
    rows = list_jianxing()
    print("windows:")
    for hwnd, pid, cls, title in rows:
        rect = RECT()
        user32.GetClientRect(hwnd, ctypes.byref(rect))
        print(
            "  %s pid=%s %s %r client=%sx%s"
            % (hwnd, pid, cls, title, rect.right - rect.left, rect.bottom - rect.top)
        )
        img = capture(hwnd)
        if img is None:
            print("    skip small")
            continue
        name = slug(title)
        path = out / f"{name}.png"
        # avoid overwrite if two same slugs
        if path.exists():
            path = out / f"{name}-{hwnd}.png"
        img.save(path, "PNG")
        print(f"    saved {path} {img.size}")


if __name__ == "__main__":
    main()
