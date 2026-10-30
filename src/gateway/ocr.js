'use strict';
/**
 * ocr.js — 屏幕文字识别（macOS Vision，零第三方依赖）
 *
 * 为什么需要它：MiniMax 是 Electron，读不到控件树；AppleScript 被沙箱拦。
 * 想「按文字点按钮」就只能靠 OCR。Vision 的中文识别质量足够定位界面元素。
 *
 * 坐标约定：全部用**屏幕点**（和 gui.js 一致），不是像素。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'scripts', 'ocr.swift');
const CACHE_DIR = path.join(ROOT, '.cache');
const BIN = path.join(CACHE_DIR, 'ocr');

/** 最近一次截图+OCR 的结果，短 TTL 内复用，避免连点几步就截几次屏。 */
let lastShot = null;

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeout || 60000,
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

/** 需要时编译 Swift 源码。已存在且比源码新就跳过。 */
function ensureBinary() {
  const needBuild = !fs.existsSync(BIN)
    || fs.statSync(BIN).mtimeMs < fs.statSync(SRC).mtimeMs;
  if (!needBuild) return BIN;

  if (!fs.existsSync(SRC)) {
    throw new Error(`找不到 OCR 源码: ${SRC}`);
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  try {
    sh('swiftc', ['-O', '-o', BIN, SRC], { timeout: 300000 });
  } catch (err) {
    const hint = /xcrun|swiftc|command not found/i.test(String(err.stderr || err.message))
      ? '本机缺少 Swift 工具链（xcode-select --install）'
      : 'swiftc 编译失败';
    throw new Error(`OCR 工具编译失败：${hint}。原始错误：${String(err.stderr || err.message).slice(0, 300)}`);
  }
  return BIN;
}

function ocrAvailable() {
  try {
    return fs.existsSync(SRC) && fs.existsSync('/usr/bin/swiftc');
  } catch {
    return false;
  }
}

/**
 * 截一块屏幕并识别。
 * region 省略则截全屏。返回 { items:[{text,x,y,w,h,cx,cy,conf}], pointWidth, ... }
 */
function read(region = null, opts = {}) {
  const bin = ensureBinary();
  const tmp = path.join(os.tmpdir(), `minimax-ocr-${process.pid}-${Date.now()}.png`);
  const args = ['-x'];
  if (region) {
    args.push('-R', `${Math.round(region.x)},${Math.round(region.y)},${Math.round(region.width)},${Math.round(region.height)}`);
  }
  args.push(tmp);
  try {
    sh('screencapture', args, { timeout: 30000 });
    const out = region
      ? sh(bin, [tmp, String(region.x), String(region.y), String(region.width), String(region.height)], { timeout: 120000 })
      : sh(bin, [tmp], { timeout: 120000 });
    const parsed = JSON.parse(out);
    const result = {
      region: region || { x: 0, y: 0, width: parsed.pointWidth, height: parsed.pointHeight },
      count: parsed.count,
      items: parsed.items || [],
    };
    lastShot = { at: Date.now(), result };
    return result;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
  }
}

/** 规范化：去空白、全角转半角、小写，方便中文/英文混排匹配。 */
function norm(s) {
  return String(s || '')
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .toLowerCase();
}

/**
 * 在已识别的文字里找目标。返回按匹配度排序的命中列表。
 * mode: 'contains'（默认，包含即算）| 'exact' | 'prefix'
 */
function match(items, query, opts = {}) {
  const mode = opts.mode || 'contains';
  const q = norm(query);
  if (!q) return [];
  const hits = [];
  for (const it of items) {
    const t = norm(it.text);
    if (!t) continue;
    let score = 0;
    if (t === q) {
      score = 3;
    } else if (mode === 'exact') {
      continue;
    } else if (t.startsWith(q)) {
      score = 2;
    } else if (mode === 'prefix') {
      // prefix 模式只认开头，不往下兜底
      continue;
    } else if (t.includes(q)) {
      score = 1;
    } else if (q.includes(t) && t.length >= 2) {
      // 反查：OCR 把长句切成了几段，查询是完整句子时也算弱命中
      score = 0.5;
    }
    if (!score) continue;
    // 更短的文本更可能是按钮本身而不是整段正文
    score += Math.max(0, (10 - t.length)) / 100;
    hits.push({ ...it, score: Number(score.toFixed(3)) });
  }
  hits.sort((a, b) => b.score - a.score || a.cy - b.cy);
  return hits;
}

/**
 * 找目标文字，必要时重新截屏。
 * opts: {region, mode, index, refresh}
 */
function find(query, opts = {}) {
  const region = opts.region || null;
  const cacheOk = lastShot && !opts.refresh && (Date.now() - lastShot.at) < (opts.ttlMs ?? 3000);
  const shot = cacheOk ? lastShot.result : read(region);
  const hits = match(shot.items, query, opts);
  const index = Number.isInteger(opts.index) ? opts.index : 0;
  return {
    query,
    total: hits.length,
    picked: hits[index] || null,
    matches: hits.slice(0, opts.limit || 8),
    scanned: shot.count,
    region: shot.region,
    cached: Boolean(cacheOk),
  };
}

/**
 * 从多个命中里挑「最靠左那一列」的最上面一个。
 * 用途：同一个标题在侧栏和主区域顶部都会出现，点错了会点到顶栏。
 * 侧栏永远是最左列，所以先按 x 找最左，再在同一列里取最上面的。
 */
function pickLeftmostColumn(matches, tolerance = 40) {
  if (!matches || !matches.length) return null;
  const minX = Math.min(...matches.map((m) => m.x));
  const column = matches
    .filter((m) => m.x <= minX + tolerance)
    .sort((a, b) => a.cy - b.cy);
  return column[0] || null;
}

/** 取最近一次识别结果（调试用）。 */
function last() {
  return lastShot ? { ageMs: Date.now() - lastShot.at, ...lastShot.result } : null;
}

module.exports = { read, find, match, norm, last, pickLeftmostColumn, ensureBinary, ocrAvailable, BIN };
