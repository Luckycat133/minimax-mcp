#!/usr/bin/env python3
"""
mac_gui.py — macOS 原生 GUI 控制工具（纯 ctypes，零依赖）

依赖系统框架：CoreGraphics / ApplicationServices
所需权限：辅助功能（鼠标键盘）+ 屏幕录制（截图）

用法：
  python3 mac_gui.py windows                 列出所有可见窗口
  python3 mac_gui.py front                   当前前台窗口
  python3 mac_gui.py pos                     当前鼠标位置
  python3 mac_gui.py move X Y                移动鼠标
  python3 mac_gui.py click X Y [left|right]  单击
  python3 mac_gui.py dclick X Y              双击
  python3 mac_gui.py drag X1 Y1 X2 Y2        拖拽
  python3 mac_gui.py scroll N                滚动（正数向上）
  python3 mac_gui.py type "文本"             输入文本（支持中文）
  python3 mac_gui.py key KEY [MOD,...]       按键，如: key return / key t cmd
  python3 mac_gui.py shot [name]             截图（自动缩放到 1600px 便于查看）
  python3 mac_gui.py activate PID            把某进程窗口切到前台
  python3 mac_gui.py axlist PID              列出某进程的 AX 元素树（浅层）
  python3 mac_gui.py axclick PID xpath       点击 AX 元素（如 "0/1/2"）

坐标系：全局屏幕坐标，单位是「点」(point)，原点在左上角。
Retina 屏幕上截图是 2 倍像素，所以 像素坐标 / 2 = 点坐标。
"""
import ctypes
import ctypes.util
import subprocess
import sys
import time
from pathlib import Path

# ---------------- 框架加载 ----------------
cg = ctypes.CDLL(ctypes.util.find_library("CoreGraphics"))
cf = ctypes.CDLL(ctypes.util.find_library("CoreFoundation"))
ax = ctypes.CDLL(
    ctypes.util.find_library("ApplicationServices")
    or "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"
)


class CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]


class CGSize(ctypes.Structure):
    _fields_ = [("width", ctypes.c_double), ("height", ctypes.c_double)]


class CGRect(ctypes.Structure):
    _fields_ = [("origin", CGPoint), ("size", CGSize)]


# CoreGraphics 事件
cg.CGEventCreate.restype = ctypes.c_void_p
cg.CGEventCreate.argtypes = [ctypes.c_void_p]
cg.CGEventGetLocation.restype = CGPoint
cg.CGEventGetLocation.argtypes = [ctypes.c_void_p]
cg.CGEventCreateMouseEvent.restype = ctypes.c_void_p
cg.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, CGPoint, ctypes.c_uint32]
cg.CGEventCreateKeyboardEvent.restype = ctypes.c_void_p
cg.CGEventCreateKeyboardEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint16, ctypes.c_bool]
cg.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
cg.CGEventSetFlags.argtypes = [ctypes.c_void_p, ctypes.c_uint64]
cg.CGEventKeyboardSetUnicodeString.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p]
cg.CGEventCreateScrollWheelEvent.restype = ctypes.c_void_p
cg.CGEventCreateScrollWheelEvent.argtypes = [
    ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_int32,
]

# 窗口列表
cg.CGWindowListCopyWindowInfo.restype = ctypes.c_void_p
cg.CGWindowListCopyWindowInfo.argtypes = [ctypes.c_uint32, ctypes.c_uint32]

cf.CFArrayGetCount.restype = ctypes.c_long
cf.CFArrayGetCount.argtypes = [ctypes.c_void_p]
cf.CFArrayGetValueAtIndex.restype = ctypes.c_void_p
cf.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, ctypes.c_long]
cf.CFDictionaryGetValue.restype = ctypes.c_void_p
cf.CFDictionaryGetValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
cf.CFStringCreateWithCString.restype = ctypes.c_void_p
cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
cf.CFStringGetCString.restype = ctypes.c_bool
cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
cf.CFNumberGetValue.restype = ctypes.c_bool
cf.CFNumberGetValue.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
cf.CFRelease.argtypes = [ctypes.c_void_p]
cf.CFGetTypeID.restype = ctypes.c_ulong
cf.CFGetTypeID.argtypes = [ctypes.c_void_p]
cf.CFStringGetTypeID.restype = ctypes.c_ulong
cf.CFStringGetTypeID.argtypes = []
cf.CFBooleanGetTypeID.restype = ctypes.c_ulong
cf.CFBooleanGetTypeID.argtypes = []

# Accessibility
ax.AXIsProcessTrusted.restype = ctypes.c_bool
ax.AXUIElementCreateApplication.restype = ctypes.c_void_p
ax.AXUIElementCreateApplication.argtypes = [ctypes.c_int]
ax.AXUIElementCopyAttributeValue.restype = ctypes.c_int
ax.AXUIElementCopyAttributeValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
ax.AXUIElementPerformAction.restype = ctypes.c_int
ax.AXUIElementPerformAction.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
ax.AXUIElementSetAttributeValue.restype = ctypes.c_int
ax.AXUIElementSetAttributeValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
ax.AXValueGetValue.restype = ctypes.c_bool
ax.AXValueGetValue.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p]

cf.kCFBooleanTrue = None
cf.CFBooleanGetTrue = None
try:
    CFBOOLEAN_TRUE = ctypes.c_void_p.in_dll(cf, "kCFBooleanTrue")
except ValueError:
    CFBOOLEAN_TRUE = None

SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)


# ---------------- 基础工具 ----------------
def cfstr(s: str):
    return cf.CFStringCreateWithCString(None, s.encode("utf-8"), 0x08000100)  # kCFStringEncodingUTF8


def cfnum(val):
    out = ctypes.c_double()
    cf.CFNumberGetValue(val, 13, ctypes.byref(out))  # kCFNumberDoubleType
    return out.value


def cf2str(val):
    if not val:
        return ""
    if cf.CFGetTypeID(val) != cf.CFStringGetTypeID():
        return ""
    buf = ctypes.create_string_buffer(4096)
    if cf.CFStringGetCString(val, buf, 4096, 0x08000100):
        return buf.value.decode("utf-8", "replace")
    return ""


def mouse_pos():
    p = cg.CGEventGetLocation(cg.CGEventCreate(None))
    return p.x, p.y


def post(ev):
    cg.CGEventPost(0, ev)  # kCGHIDEventTap
    time.sleep(0.02)


def move_to(x, y):
    post(cg.CGEventCreateMouseEvent(None, 5, CGPoint(x, y), 0))  # mouseMoved


def click(x, y, button="left"):
    move_to(x, y)
    time.sleep(0.05)
    if button == "right":
        down, up, btn = 3, 4, 1
    else:
        down, up, btn = 1, 2, 0
    post(cg.CGEventCreateMouseEvent(None, down, CGPoint(x, y), btn))
    post(cg.CGEventCreateMouseEvent(None, up, CGPoint(x, y), btn))


def double_click(x, y):
    move_to(x, y)
    time.sleep(0.05)
    for _ in range(2):
        post(cg.CGEventCreateMouseEvent(None, 1, CGPoint(x, y), 0))
        post(cg.CGEventCreateMouseEvent(None, 2, CGPoint(x, y), 0))
        time.sleep(0.08)


def drag(x1, y1, x2, y2, steps=20):
    move_to(x1, y1)
    time.sleep(0.1)
    post(cg.CGEventCreateMouseEvent(None, 1, CGPoint(x1, y1), 0))
    for i in range(1, steps + 1):
        nx = x1 + (x2 - x1) * i / steps
        ny = y1 + (y2 - y1) * i / steps
        post(cg.CGEventCreateMouseEvent(None, 6, CGPoint(nx, ny), 0))  # leftMouseDragged
    post(cg.CGEventCreateMouseEvent(None, 2, CGPoint(x2, y2), 0))


def scroll(amount, x=None, y=None):
    if x is not None and y is not None:
        move_to(x, y)
        time.sleep(0.05)
    ev = cg.CGEventCreateScrollWheelEvent(None, 1, 1, int(amount))  # 1=line unit
    post(ev)


def type_text(text):
    """逐字符输入，支持中文等非 ASCII（走 Unicode 字符串通道）"""
    for ch in text:
        ev_down = cg.CGEventCreateKeyboardEvent(None, 0, True)
        buf = ctypes.create_string_buffer(ch.encode("utf-16-le"))
        cg.CGEventKeyboardSetUnicodeString(ev_down, 1, ctypes.cast(buf, ctypes.c_void_p))
        cg.CGEventPost(0, ev_down)
        ev_up = cg.CGEventCreateKeyboardEvent(None, 0, False)
        buf2 = ctypes.create_string_buffer(ch.encode("utf-16-le"))
        cg.CGEventKeyboardSetUnicodeString(ev_up, 1, ctypes.cast(buf2, ctypes.c_void_p))
        cg.CGEventPost(0, ev_up)
        time.sleep(0.012)


# 常用键码
KEYCODES = {
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51,
    "esc": 53, "escape": 53, "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4,
    "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35,
    "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7,
    "y": 16, "z": 6,
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22,
    "7": 26, "8": 28, "9": 25,
    "-": 27, "=": 24, "[": 33, "]": 30, ";": 41, "'": 39, ",": 43,
    ".": 47, "/": 44, "\\": 42, "`": 50,
}

MODIFIERS = {
    "cmd": 1 << 20, "command": 1 << 20,
    "shift": 1 << 17,
    "alt": 1 << 19, "option": 1 << 19,
    "ctrl": 1 << 18, "control": 1 << 18,
    "fn": 1 << 23,
}


def press_key(name, mods=None):
    code = KEYCODES.get(name.lower())
    if code is None and name.isdigit():
        code = int(name)
    if code is None:
        raise SystemExit(f"未知按键: {name}")
    flags = 0
    for m in (mods or []):
        flags |= MODIFIERS.get(m.lower(), 0)
    down = cg.CGEventCreateKeyboardEvent(None, code, True)
    up = cg.CGEventCreateKeyboardEvent(None, code, False)
    if flags:
        cg.CGEventSetFlags(down, flags)
        cg.CGEventSetFlags(up, flags)
    post(down)
    post(up)


# ---------------- 窗口信息 ----------------
WINDOW_KEYS = {
    "name": "kCGWindowName",
    "owner": "kCGWindowOwnerName",
    "pid": "kCGWindowOwnerPID",
    "layer": "kCGWindowLayer",
    "bounds": "kCGWindowBounds",
    "number": "kCGWindowNumber",
    "onscreen": "kCGWindowIsOnscreen",
}


def list_windows(only_layer0=True):
    arr = cg.CGWindowListCopyWindowInfo(1 | 16, 0)  # OnScreenOnly | ExcludeDesktopElements
    if not arr:
        return []
    out = []
    n = cf.CFArrayGetCount(arr)
    for i in range(n):
        d = cf.CFArrayGetValueAtIndex(arr, i)
        rec = {}
        for key, cname in WINDOW_KEYS.items():
            k = cfstr(cname)
            v = cf.CFDictionaryGetValue(d, k)
            cf.CFRelease(k)
            if not v:
                continue
            if key == "bounds":
                # CFDictionary 里的 CGRect 用 CGWindowBounds 字典，简化：取数值
                for sub in ("X", "Y", "Width", "Height"):
                    sk = cfstr(sub)
                    sv = cf.CFDictionaryGetValue(v, sk)
                    cf.CFRelease(sk)
                    rec[sub.lower()] = cfnum(sv) if sv else 0
            elif key in ("pid", "layer", "number", "onscreen"):
                rec[key] = int(cfnum(v))
            else:
                rec[key] = cf2str(v)
        if only_layer0 and rec.get("layer", 1) != 0:
            continue
        out.append(rec)
    cf.CFRelease(arr)
    return out


def cmd_windows():
    wins = list_windows()
    print(f"{'PID':>7}  {'层级':>4}  {'位置/尺寸':<28}  窗口标题  |  所属应用")
    print("-" * 110)
    for w in wins:
        b = f"{int(w.get('x',0))},{int(w.get('y',0))} {int(w.get('width',0))}x{int(w.get('height',0))}"
        name = w.get("name") or "(无标题)"
        print(f"{w.get('pid',0):>7}  {w.get('layer',0):>4}  {b:<28}  {name[:40]:<40} | {w.get('owner','')}")


def cmd_front():
    wins = list_windows()
    if not wins:
        print("没有可见窗口")
        return
    w = wins[0]
    b = f"{int(w.get('x',0))},{int(w.get('y',0))} {int(w.get('width',0))}x{int(w.get('height',0))}"
    print(f"前台窗口: {w.get('owner','')} | {w.get('name') or '(无标题)'} | PID={w.get('pid')} | {b}")


# ---------------- 截图 ----------------
def cmd_shot(name="shot"):
    path = SCREENSHOTS / f"{name}.png"
    subprocess.run(["screencapture", "-x", "-C", str(path)], check=False)
    if not path.exists():
        print("截图失败：检查屏幕录制权限")
        return
    small = SCREENSHOTS / f"{name}_s.png"
    subprocess.run(["sips", "-Z", "1600", str(path), "--out", str(small)],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"已保存: {path}")
    print(f"缩略:   {small}")


# ---------------- AX 元素树 ----------------
def ax_attr(el, attr):
    v = ctypes.c_void_p()
    k = cfstr(attr)
    err = ax.AXUIElementCopyAttributeValue(el, k, ctypes.byref(v))
    cf.CFRelease(k)
    if err != 0:
        return None
    return v


def ax_children(el):
    v = ax_attr(el, "AXChildren")
    if not v:
        return []
    n = cf.CFArrayGetCount(v)
    return [cf.CFArrayGetValueAtIndex(v, i) for i in range(n)]


def ax_walk(el, depth, path, max_depth):
    role = cf2str(ax_attr(el, "AXRole"))
    title = cf2str(ax_attr(el, "AXTitle"))
    desc = cf2str(ax_attr(el, "AXDescription"))
    value = cf2str(ax_attr(el, "AXValue"))
    label = title or desc or value
    if role or label:
        print(f"{'  ' * depth}{path} {role}  {label[:60]}")
    if depth >= max_depth:
        return
    for i, child in enumerate(ax_children(el)):
        ax_walk(child, depth + 1, f"{path}/{i}", max_depth)


def cmd_axlist(pid, max_depth=4):
    app = ax.AXUIElementCreateApplication(int(pid))
    if not app:
        print("无法创建 AX 元素，检查辅助功能权限")
        return
    print(f"=== PID {pid} 的 AX 元素树（深度 {max_depth}）===")
    ax_walk(app, 0, "0", int(max_depth))


def cmd_axclick(pid, xpath):
    app = ax.AXUIElementCreateApplication(int(pid))
    el = app
    for idx in xpath.split("/")[1:]:
        kids = ax_children(el)
        el = kids[int(idx)]
    k = cfstr("AXPress")
    err = ax.AXUIElementPerformAction(el, k)
    cf.CFRelease(k)
    print("AXPress 结果:", "成功" if err == 0 else f"失败({err})")


def ax_point(el, attr):
    """读 AXPosition / AXSize，返回 (x, y) 或 (w, h)"""
    v = ax_attr(el, attr)
    if not v:
        return None
    buf = CGPoint()
    if ax.AXValueGetValue(v, 1, ctypes.byref(buf)):  # 1 = kAXValueCGPointType
        return buf.x, buf.y
    buf2 = CGSize()
    if ax.AXValueGetValue(v, 2, ctypes.byref(buf2)):  # 2 = kAXValueCGSizeType
        return buf2.width, buf2.height
    return None


def ax_find(el, needle, path="0", out=None, depth=0, max_depth=12):
    if out is None:
        out = []
    if depth > max_depth:
        return out
    role = cf2str(ax_attr(el, "AXRole"))
    parts = [
        cf2str(ax_attr(el, "AXTitle")),
        cf2str(ax_attr(el, "AXDescription")),
        cf2str(ax_attr(el, "AXValue")),
        cf2str(ax_attr(el, "AXHelp")),
        cf2str(ax_attr(el, "AXPlaceholderValue")),
    ]
    label = " | ".join(p for p in parts if p)
    if needle.lower() in label.lower():
        pos = ax_point(el, "AXPosition")
        size = ax_point(el, "AXSize")
        out.append((path, role, label, pos, size))
    for i, child in enumerate(ax_children(el)):
        ax_find(child, needle, f"{path}/{i}", out, depth + 1, max_depth)
    return out


def cmd_axfind(pid, needle):
    app = ax.AXUIElementCreateApplication(int(pid))
    hits = ax_find(app, needle)
    if not hits:
        print("没找到匹配元素")
        return
    for path, role, label, pos, size in hits:
        p = f"({pos[0]:.0f},{pos[1]:.0f})" if pos else "(?)"
        s = f"{size[0]:.0f}x{size[1]:.0f}" if size else ""
        cx = f"  中心=({pos[0]+size[0]/2:.0f},{pos[1]+size[1]/2:.0f})" if pos and size else ""
        print(f"{path:<14} {role:<18} {p} {s}{cx}  {label[:50]}")


def cmd_activate(pid):
    app = ax.AXUIElementCreateApplication(int(pid))
    k = cfstr("AXFrontmost")
    err = ax.AXUIElementSetAttributeValue(app, k, CFBOOLEAN_TRUE)
    cf.CFRelease(k)
    print("切换到前台:", "成功" if err == 0 else f"失败({err})")


# ---------------- CLI ----------------
def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return
    cmd = argv[1]
    a = argv[2:]
    if cmd == "windows":
        cmd_windows()
    elif cmd == "front":
        cmd_front()
    elif cmd == "pos":
        x, y = mouse_pos()
        print(f"{x:.0f} {y:.0f}")
    elif cmd == "move":
        move_to(float(a[0]), float(a[1]))
        print(f"鼠标移到 {a[0]},{a[1]}")
    elif cmd == "click":
        click(float(a[0]), float(a[1]), a[2] if len(a) > 2 else "left")
        print(f"点击 {a[0]},{a[1]}")
    elif cmd == "dclick":
        double_click(float(a[0]), float(a[1]))
        print(f"双击 {a[0]},{a[1]}")
    elif cmd == "drag":
        drag(float(a[0]), float(a[1]), float(a[2]), float(a[3]))
        print("拖拽完成")
    elif cmd == "scroll":
        scroll(int(a[0]))
        print(f"滚动 {a[0]}")
    elif cmd == "type":
        type_text(a[0])
        print(f"已输入 {len(a[0])} 个字符")
    elif cmd == "key":
        mods = a[1].split(",") if len(a) > 1 else []
        press_key(a[0], mods)
        print(f"按键 {a[0]} {'+'.join(mods)}")
    elif cmd == "shot":
        cmd_shot(a[0] if a else "shot")
    elif cmd == "axlist":
        cmd_axlist(a[0], a[1] if len(a) > 1 else 4)
    elif cmd == "axclick":
        cmd_axclick(a[0], a[1])
    elif cmd == "axfind":
        cmd_axfind(a[0], a[1])
    elif cmd == "activate":
        cmd_activate(a[0])
    elif cmd == "check":
        print("辅助功能:", "已授权" if ax.AXIsProcessTrusted() else "未授权")
    else:
        print(__doc__)


if __name__ == "__main__":
    main(sys.argv)
