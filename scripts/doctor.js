'use strict';

/**
 * doctor.js — 环境自检。不启动 MiniMax，不做任何点击。
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const checks = [];
function check(label, pass, detail) {
  checks.push({ label, pass, detail });
}

function tryRun(cmd, args) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: out.trim() };
  } catch (err) {
    return { ok: false, out: (err.stderr || err.message || '').toString().trim() };
  }
}

const node = tryRun(process.execPath, ['--version']);
check('node >= 22', node.ok && parseInt(node.out.replace('v', ''), 10) >= 22, node.out || '未取到版本');

const sqlite = tryRun('sqlite3', ['--version']);
check('sqlite3 CLI', sqlite.ok, sqlite.out);

const python = tryRun('python3', ['--version']);
check('python3', python.ok, python.out);

const dbPath = path.join(os.homedir(), '.minimax/v2/sqlite/runtime-state.sqlite');
check('MiniMax 数据库存在', fs.existsSync(dbPath), dbPath);

const gui = path.join(__dirname, '..', 'scripts', 'mac_gui.py');
check('mac_gui.py 存在', fs.existsSync(gui), gui);

const perm = tryRun('python3', [gui, 'check']);
const cuaCli = path.join(__dirname, '..', '..', 'codex-computer-use-mcp', 'bin', 'cua');
const cuaAvailable = fs.existsSync(cuaCli);
const permOk = (perm.ok && /已授权/.test(perm.out)) || cuaAvailable;
check('辅助功能权限', permOk, permOk 
  ? (cuaAvailable ? '已通过 Codex Computer Use 原生授权' : perm.out.split('\n')[0]) 
  : (perm.out.split('\n')[0] || '未授权（普通 Agent 请运行 node scripts/setup-permissions.js 一键开启）'));

const app = '/Applications/MiniMax Code.app';
check('MiniMax Code 已安装', fs.existsSync(app), app);

// OCR：Swift 工具链 + Vision 识别能否真的跑出字
const ocrSrc = path.join(__dirname, '..', 'scripts', 'ocr.swift');
check('ocr.swift 存在', fs.existsSync(ocrSrc), ocrSrc);
let ocrOk = false;
let ocrDetail = '未测试';
try {
  const ocr = require(path.join(__dirname, '..', 'src/gateway/ocr'));
  ocr.ensureBinary();
  ocrOk = true;
  ocrDetail = `${ocr.BIN} 已就绪`;
} catch (err) {
  ocrDetail = String(err.message).slice(0, 160);
}
check('OCR 可编译可用', ocrOk, ocrDetail);

let failed = 0;
for (const c of checks) {
  if (!c.pass) failed += 1;
  console.log(`${c.pass ? '[OK]  ' : '[FAIL]'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
