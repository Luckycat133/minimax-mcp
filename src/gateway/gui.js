'use strict';

/**
 * gui.js — MiniMax Code 的 GUI 驱动层。
 *
 * MiniMax Code 是 Electron 应用，没有本地 HTTP API，也没有可用的跨进程 AX 树。
 * 唯一稳定的控制通道是 macOS 原生事件注入（CoreGraphics），封装在 scripts/mac_gui.py。
 * 这里只做「调用 + 解析输出」，不重复实现GUI原语。
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const MAC_GUI = path.join(__dirname, '..', '..', 'scripts', 'mac_gui.py');
const PYTHON = process.env.MINIMAX_PYTHON || 'python3';
const APP = 'MiniMax Code';
const CUA_ACTION = path.join(__dirname, '..', '..', '..', 'codex-computer-use-mcp', 'bin', 'cua-action');
const CUA_SCREENSHOT = path.join(__dirname, '..', '..', '..', 'codex-computer-use-mcp', 'bin', 'cua-screenshot');
const fs = require('node:fs');

let _cachedHasAccessibility = null;
function hasPythonAccessibility() {
  if (_cachedHasAccessibility !== null) return _cachedHasAccessibility;
  try {
    const out = gui(['check']);
    _cachedHasAccessibility = /已授权/.test(out);
  } catch {
    _cachedHasAccessibility = false;
  }
  return _cachedHasAccessibility;
}

function gui(args, timeout = 60000) {
  return execFileSync(PYTHON, [MAC_GUI, ...args], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
}

const WIN_RE = /^\s*(\d+)\s+(\d+)\s+(-?[\d.]+),(-?[\d.]+)\s+(\d+)x(\d+)\s+(.*?)\s*\|\s*(.+?)\s*$/;
const WIN_ALL_RE = /^\s*(\d+)\s+(\d+)\s+(是|否)\s+(-?[\d.]+),(-?[\d.]+)\s+(\d+)x(\d+)\s+(.*?)\s*\|\s*(.+?)\s*$/;
const FRONT_RE = /前台窗口:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*PID=(\d+)\s*\|\s*(-?[\d.]+),(-?[\d.]+)\s+(\d+)x(\d+)/;
const ACTIVE_RE = /活跃应用:\s*(.*?)\s*\|\s*原名=(.*?)\s*\|\s*PID=(\d+)\s*\|\s*(.+)/;

/** 列出全部可见窗口（z-order，最前在第一行）。 */
function windows() {
  const out = gui(['windows']);
  const list = [];
  for (const line of out.split('\n')) {
    const m = line.match(WIN_RE);
    if (!m) continue;
    list.push({
      pid: Number(m[1]),
      layer: Number(m[2]),
      x: Number(m[3]),
      y: Number(m[4]),
      width: Number(m[5]),
      height: Number(m[6]),
      title: m[7].trim(),
      app: m[8].trim(),
    });
  }
  return list;
}

function appWindows(app = APP) {
  return windows().filter((w) => w.app === app);
}

/**
 * 全部窗口（含隐藏、最小化、跑到别的 Space 的）。
 * CGWindowListCopyWindowInfo 的 OnScreenOnly 会把隐藏 App 的窗口整个漏掉，
 * 那种情况下会误判成"App 没有窗口"，所以几何信息必须用这个兜底。
 */
function windowsAll() {
  const out = gui(['windowsall']);
  const list = [];
  for (const line of out.split('\n')) {
    const m = line.match(WIN_ALL_RE);
    if (!m) continue;
    list.push({
      pid: Number(m[1]),
      layer: Number(m[2]),
      onScreen: m[3] === '是',
      x: Number(m[4]),
      y: Number(m[5]),
      width: Number(m[6]),
      height: Number(m[7]),
      title: m[8].trim(),
      app: m[9].trim(),
    });
  }
  return list;
}

/** MiniMax 的 PID。先看在屏窗口，再用全部窗口兜底。 */
function minimaxPid() {
  const onScreen = windows().find((w) => w.app === APP);
  if (onScreen) return onScreen.pid;
  const any = windowsAll().find((w) => w.app === APP);
  return any ? any.pid : null;
}

/**
 * MiniMax 当前获得焦点的窗口（AXFocusedWindow）。
 * 一个 App 可能同时开多个窗口（主窗口 + 新建任务页），按键和输入去的是焦点窗口，
 * 不是面积最大的那个。返回 null 表示取不到。
 *
 * 注意必须按 MiniMax 自己的 PID 查——不能按"当前活跃应用"查，
 * 否则 MCP 宿主自己在前台时就会拿到宿主的窗口，点击会打到宿主上去。
 */
function focusedWindow() {
  const pid = minimaxPid();
  if (!pid) return null;
  const out = gui(['focusedwin', String(pid)]);
  const m = out.match(/焦点窗口:\s*(.*?)\s*\|\s*(-?[\d.]+),(-?[\d.]+)\s+(\d+)x(\d+)\s*\|\s*PID=(\d+)/);
  if (!m) return null;
  return {
    title: m[1].trim(),
    x: Number(m[2]),
    y: Number(m[3]),
    width: Number(m[4]),
    height: Number(m[5]),
    pid: Number(m[6]),
  };
}

/** 主显示器 backing scale（Retina 为 2）。区域截图的坐标要点→像素换算用。 */
function displayScale() {
  const out = gui(['scale']);
  const v = Number.parseFloat(out.trim());
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/** 取 MiniMax 的主窗口：优先在屏的，其次用全部窗口兜底（避开屏幕外的侧栏窗口）。 */
/**
 * 主窗口的宽度下限。
 * 原来是硬编码 800，那是在 5K 屏上量出来的——用户把窗口拖窄到 700 时，
 * 所有控制类工具都会报"找不到窗口"。现在放到 320，靠"优先焦点窗口 + 取最大"来避坑。
 */
const MIN_MAIN_WIDTH = Number(process.env.MINIMAX_MIN_WINDOW_WIDTH || 320);

function mainWindow() {
  // 焦点窗口优先：按键和输入就是去这里的，哪怕它比别的窗口小
  const focused = focusedWindow();
  if (focused && focused.width >= MIN_MAIN_WIDTH) {
    return { ...focused, visible: true, source: 'focused' };
  }
  const onScreen = appWindows().filter((w) => w.width >= MIN_MAIN_WIDTH);
  if (onScreen.length) {
    onScreen.sort((a, b) => b.width * b.height - a.width * a.height);
    return { ...onScreen[0], visible: true, source: 'largest' };
  }
  const all = windowsAll().filter((w) => w.app === APP && w.width >= MIN_MAIN_WIDTH);
  if (all.length) {
    all.sort((a, b) => b.width * b.height - a.width * a.height);
    return { ...all[0], visible: false, source: 'all-windows' };
  }
  return null;
}

/** 用 LaunchServices 打开/激活 App。窗口被隐藏或在别的 Space 时，只有这条能把它拉回来。 */
function openApp() {
  try {
    execFileSync('open', ['-a', APP], { timeout: 20000 });
  } catch (err) {
    throw new Error(`启动 MiniMax Code 失败（可能没安装）：${String(err.stderr || err.message).slice(0, 200)}`);
  }
  sleep(1200);
  return { opened: APP };
}

/**
 * 当前「活跃应用」——⌘Tab 指向的那个，也是键盘事件的去处。
 * 注意不能用 windows()[0] 代替：浮动面板会一直躺在最上层却不是活跃应用。
 */
function activeApp() {
  const out = gui(['active']);
  const m = out.match(ACTIVE_RE);
  if (!m) return null;
  return { app: m[1].trim(), pid: Number(m[3]), bundle: m[4].trim() };
}

/** 最上层窗口所属应用，仅作诊断信息。 */
function topmostApp() {
  const list = windows();
  return list.length ? { app: list[0].app, title: list[0].title, pid: list[0].pid } : null;
}

/**
 * 命中测试：给定屏幕点，返回最上层覆盖该点的窗口。
 * 用来防止"坐标算对了，但那个位置上盖着别的 App 的悬浮面板"。
 */
function topmostAt(x, y) {
  const list = windows();
  for (const w of list) {
    if (x >= w.x && x <= w.x + w.width && y >= w.y && y <= w.y + w.height) {
      return { app: w.app, title: w.title, pid: w.pid };
    }
  }
  return null;
}

function front() {
  const out = gui(['front']);
  const m = out.match(FRONT_RE);
  if (!m) return null;
  return {
    app: m[1].trim(),
    title: m[2].trim(),
    pid: Number(m[3]),
    x: Number(m[4]),
    y: Number(m[5]),
    width: Number(m[6]),
    height: Number(m[7]),
  };
}

function activate(pid) {
  try {
    execFileSync('osascript', ['-e', 'tell application "MiniMax Code" to activate'], { timeout: 3000 });
  } catch (_) {
    gui(['activate', String(pid)]);
  }
  return { activated: pid };
}

/**
 * 确认 MiniMax 是「活跃应用」。不在就激活，仍不成则返回 false。
 * 只看活跃应用，不看最上层窗口——悬浮面板不等于抢走了输入焦点。
 */
function ensureFront(tries = 4) {
  for (let i = 0; i < tries; i += 1) {
    const a = activeApp();
    if (a && a.app === APP) return true;
    const w = mainWindow();
    if (w) activate(w.pid);
    sleep(800);
  }
  const a = activeApp();
  return Boolean(a && a.app === APP);
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* 同步等待 */ }
}

function click(x, y, button = 'left') {
  if (!hasPythonAccessibility() && fs.existsSync(CUA_ACTION)) {
    try {
      execFileSync(CUA_ACTION, ['click', String(Math.round(x)), String(Math.round(y))], { encoding: 'utf8', timeout: 15000 });
      return { clicked: [Math.round(x), Math.round(y)], button, via: 'cua' };
    } catch (_) {}
  }
  gui(['click', String(Math.round(x)), String(Math.round(y)), button]);
  return { clicked: [Math.round(x), Math.round(y)], button };
}

function typeText(text) {
  if (!hasPythonAccessibility() && fs.existsSync(CUA_ACTION)) {
    try {
      execFileSync(CUA_ACTION, ['type', text], { encoding: 'utf8', timeout: 15000 });
      return { typed: text.length, via: 'cua' };
    } catch (_) {}
  }
  gui(['type', text]);
  return { typed: text.length };
}

function pressKey(key, modifiers = []) {
  if (!hasPythonAccessibility() && fs.existsSync(CUA_ACTION)) {
    try {
      execFileSync(CUA_ACTION, ['key', key], { encoding: 'utf8', timeout: 15000 });
      return { key, modifiers, via: 'cua' };
    } catch (_) {}
  }
  gui(['key', key, ...(modifiers.length ? [modifiers.join(',')] : [])]);
  return { key, modifiers };
}

function clipboard(text) {
  execFileSync('pbcopy', [], { input: text, encoding: 'utf8' });
}

/** 截图。mode=screen 全屏；mode=region 需要传 x,y,w,h。返回保存路径。 */
function screenshot(name = 'shot', mode = 'screen', region = null) {
  const safe = String(name).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'shot';
  if (mode === 'region' && region) {
    const out = path.join(__dirname, '..', '..', 'screenshots');
    fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, `${safe}_${Date.now()}.png`);
    try {
      execFileSync('screencapture', ['-x', '-R',
        `${Math.round(region.x)},${Math.round(region.y)},${Math.round(region.width)},${Math.round(region.height)}`,
        file]);
    } catch (scErr) {
      if (fs.existsSync(CUA_SCREENSHOT)) {
        execFileSync(CUA_SCREENSHOT, [file], { timeout: 30000 });
      } else {
        throw scErr;
      }
    }
    return { path: file };
  }
  const out = gui(['shot', safe]);
  const m = out.match(/已保存:\s*(.+)/);
  const thumb = out.match(/缩略:\s*(.+)/);
  return { path: m ? m[1].trim() : null, thumbnail: thumb ? thumb[1].trim() : null };
}

/** 输入框坐标：chat 布局在窗口底部居中；newtask 布局在窗口中上部。 */
function inputCoords(win, at = null, layout = 'chat') {
  if (at) {
    const [x, y] = String(at).split(',').map(Number);
    return { x, y, source: 'explicit' };
  }
  if (!win) return null;
  if (layout === 'newtask') {
    return {
      x: Math.round(win.x + win.width * 0.416),
      y: Math.round(win.y + win.height * 0.418),
      source: 'newtask',
    };
  }
  return {
    x: Math.round(win.x + win.width * 0.5),
    y: Math.round(win.y + win.height - 68),
    source: 'chat',
  };
}

module.exports = {
  APP,
  MAC_GUI,
  windows,
  appWindows,
  windowsAll,
  minimaxPid,
  mainWindow,
  focusedWindow,
  displayScale,
  openApp,
  front,
  activeApp,
  topmostApp,
  topmostAt,
  activate,
  ensureFront,
  click,
  typeText,
  pressKey,
  clipboard,
  screenshot,
  inputCoords,
  sleep,
};
