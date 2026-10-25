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
check('辅助功能权限', perm.ok && /已授权/.test(perm.out), perm.out.split('\n')[0] || '');

const app = '/Applications/MiniMax Code.app';
check('MiniMax Code 已安装', fs.existsSync(app), app);

let failed = 0;
for (const c of checks) {
  if (!c.pass) failed += 1;
  console.log(`${c.pass ? '[OK]  ' : '[FAIL]'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
