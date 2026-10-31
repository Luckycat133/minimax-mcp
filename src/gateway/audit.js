'use strict';
/**
 * audit.js — 操作审计。每次动界面/发消息都落一行，出问题能回溯。
 *
 * 为什么需要：GUI 操作没有 undo。事后想弄清"刚才到底点了哪里、当时屏幕是什么样"，
 * 只能靠记录。MCP 宿主自己也会截屏，但那是临时的、和具体动作对不上。
 *
 * 格式：JSONL，一行一次调用。字段刻意留少——多了没人看，也容易塞进敏感内容。
 *   {at, tool, level, args, ok, ms, target, error}
 *
 * args 会做脱敏和截断：message 只留前 80 字，避免把整段对话写进日志。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = process.env.MINIMAX_MCP_HOME || path.join(os.homedir(), '.minimax-mcp');
const FILE = path.join(DIR, 'audit.jsonl');
const MAX_BYTES = 2 * 1024 * 1024; // 超过 2MB 就滚一份，别无限长

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

function rotateIfNeeded() {
  try {
    const st = fs.statSync(FILE);
    if (st.size > MAX_BYTES) {
      fs.renameSync(FILE, `${FILE}.1`);
    }
  } catch {
    /* 文件不存在就不用滚 */
  }
}

/** 只保留能说明"做了什么"的字段，长文本截断。 */
function sanitizeArgs(args) {
  if (!args || typeof args !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') {
      out[k] = v.length > 80 ? `${v.slice(0, 80)}…(${v.length}字)` : v;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = `[${v.length} 项]`;
    } else if (typeof v === 'object') {
      out[k] = '{…}';
    }
  }
  return out;
}

/**
 * 记一次调用。
 * entry: {tool, level, args, ok, ms, target, error}
 */
function record(entry) {
  try {
    ensureDir();
    rotateIfNeeded();
    const line = JSON.stringify({
      at: new Date().toISOString(),
      tool: entry.tool,
      level: entry.level,
      args: sanitizeArgs(entry.args),
      ok: entry.ok !== false,
      ms: entry.ms ?? null,
      ...(entry.target ? { target: entry.target } : {}),
      ...(entry.error ? { error: String(entry.error).slice(0, 300) } : {}),
    });
    fs.appendFileSync(FILE, `${line}\n`);
  } catch {
    /* 审计失败绝不能影响主流程 */
  }
}

/** 读最近 N 条，给排障用。 */
function recent(limit = 20) {
  try {
    const text = fs.readFileSync(FILE, 'utf8');
    const lines = text.trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => {
      try { return JSON.parse(l); } catch { return { raw: l }; }
    });
  } catch {
    return [];
  }
}

module.exports = { record, recent, sanitizeArgs, FILE, DIR };
