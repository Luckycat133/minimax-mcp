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

function gui(args, timeout = 60000) {
  return execFileSync(PYTHON, [MAC_GUI, ...args], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
}

const WIN_RE = /^\s*(\d+)\s+(\d+)\s+(-?[\d.]+),(-?[\d.]+)\s+(\d+)x(\d+)\s+(.*?)\s*\|\s*(.+?)\s*$/;
const FRONT_RE = /前台窗口:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*PID=(\d+)\s*\|\s*(-?[\d.]+),(-?[\d.]+)\s+(\d+)x(\d+)/;

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

/** 取 MiniMax 的主窗口：在屏、面积最大（避开跑到屏幕外的侧栏窗口）。 */
function mainWindow() {
  const cands = appWindows().filter((w) => w.width > 800);
  if (!cands.length) return null;
  cands.sort((a, b) => b.width * b.height - a.width * a.height);
  return cands[0];
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
  gui(['activate', String(pid)]);
  return { activated: pid };
}

/** 确保 MiniMax 既在前台、又是最顶层窗口；否则返回 false，调用方应放弃操作。 */
function ensureFront(tries = 4) {
  for (let i = 0; i < tries; i += 1) {
    const f = front();
    if (f && f.app === APP) {
      const top = windows()[0];
      if (!top || top.app === APP) return true;
    }
    const w = mainWindow();
    if (w) activate(w.pid);
    sleep(800);
  }
  const f = front();
  return Boolean(f && f.app === APP);
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* 同步等待 */ }
}

function click(x, y, button = 'left') {
  gui(['click', String(Math.round(x)), String(Math.round(y)), button]);
  return { clicked: [Math.round(x), Math.round(y)], button };
}

function typeText(text) {
  gui(['type', text]);
  return { typed: text.length };
}

function pressKey(key, modifiers = []) {
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
    require('node:fs').mkdirSync(out, { recursive: true });
    const file = path.join(out, `${safe}_${Date.now()}.png`);
    execFileSync('screencapture', ['-x', '-R', `${region.x},${region.y},${region.width},${region.height}`, file]);
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
  mainWindow,
  front,
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
