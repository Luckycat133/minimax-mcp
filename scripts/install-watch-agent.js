#!/usr/bin/env node
'use strict';
/**
 * install-watch-agent.js — 把巡检装成 launchd 定时任务。
 *
 *   node scripts/install-watch-agent.js             # 每 5 分钟跑一次
 *   node scripts/install-watch-agent.js --interval 300
 *   node scripts/install-watch-agent.js --dry-run   # 只打印 plist，不装
 *   node scripts/install-watch-agent.js --uninstall
 *
 * 为什么是 StartInterval 而不是 KeepAlive：
 * 巡检是"每 N 分钟看一次"，不需要常驻。常驻进程会一直占内存，
 * 而且一旦崩了还得靠 KeepAlive 拉起，反而更脆。
 *
 * 注意：这个任务会真的操作 GUI（点选项、发催促），
 * 但受 policy 约束——默认只在人离开 ≥180 秒、且只处理低风险的事。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LABEL = 'com.minimax-mcp.watch';
/** 旧版只读巡检器（Python 实现）。它和这个功能重叠，装着两个等于每 5 分钟轮询两次。 */
const LEGACY = [
  { label: 'com.jack.minimax-watch', plist: path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.jack.minimax-watch.plist') },
];
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG_DIR = path.join(os.homedir(), '.minimax-mcp');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const uninstall = args.includes('--uninstall');
const intervalIdx = args.indexOf('--interval');
const interval = intervalIdx >= 0 ? Number(args[intervalIdx + 1]) : 300;

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'watch-tick.js');

/**
 * 挑一个稳定的 node 可执行文件。
 * process.execPath 可能是某个会随宿主升级而消失的路径（比如 WorkBuddy 自带的），
 * 写进 launchd 就再也起不来了。所以优先用系统级的。
 */
function pickNode() {
  const candidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    path.join(os.homedir(), '.local/bin/node'),
    process.execPath,
  ];
  for (const c of candidates) {
    try {
      const v = execFileSync(c, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
      const major = Number(String(v).replace('v', '').split('.')[0]);
      if (major >= 22) return { bin: c, version: v };
    } catch { /* 试下一个 */ }
  }
  return { bin: process.execPath, version: 'unknown' };
}

const NODE = pickNode();

function plistXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE.bin}</string>
    <string>${SCRIPT}</string>
    <string>--quiet</string>
  </array>
  <key>StartInterval</key><integer>${interval}</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${LOG_DIR}/watch.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/watch.err.log</string>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
`;
}

/** 任务是否真的被 launchd 接管了。 */
function isLoaded() {
  const r = execFileSync('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`], {
    encoding: 'utf8', timeout: 15000,
  });
  return /state =|path =/.test(r || '');
}

function launchctl(argv) {
  try {
    return execFileSync('launchctl', argv, { encoding: 'utf8', timeout: 20000 }).trim();
  } catch (err) {
    return `(launchctl 返回非零: ${String(err.stderr || err.message).slice(0, 200)})`;
  }
}

function main() {
  if (uninstall) {
    launchctl(['unload', PLIST]);
    if (fs.existsSync(PLIST)) fs.rmSync(PLIST);
    console.log(`已卸载：${LABEL}`);
    console.log(`plist 已删除：${PLIST}`);
    return;
  }

  if (!fs.existsSync(SCRIPT)) {
    console.error(`找不到 ${SCRIPT}`);
    process.exit(1);
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });

  const xml = plistXml();
  if (dryRun) {
    console.log(xml);
    return;
  }

  // 先卸再装，避免 bootstrap 报 "already exists"
  if (fs.existsSync(PLIST)) {
    launchctl(['bootout', `gui/${process.getuid()}/${LABEL}`]);
    launchctl(['unload', PLIST]);
  }
  fs.writeFileSync(PLIST, xml);

  // 新版 macOS 用 bootstrap；老写法 load 已废弃但仍兼容
  let out = launchctl(['bootstrap', `gui/${process.getuid()}`, PLIST]);
  if (/非零|error|failed/i.test(out)) out = launchctl(['load', PLIST]);

  // 确认真的装上了再动旧的——装失败就把人家原来的停掉是最糟的
  const loaded = isLoaded();
  if (!loaded) {
    console.error('\n安装失败：launchd 没有加载这个任务。');
    console.error('常见原因：当前环境（沙箱 / 自动化宿主）无权写 launchd 用户域。');
    console.error('请在「终端」App 里手动执行：');
    console.error(`  node ${path.join(ROOT, 'scripts', 'install-watch-agent.js')}`);
    console.error('\n旧巡检器保持原样，没有被动过。');
    process.exit(1);
  }

  // 装成功了，再停掉功能重叠的旧巡检器
  for (const legacy of LEGACY) {
    if (!fs.existsSync(legacy.plist)) continue;
    launchctl(['bootout', `gui/${process.getuid()}/${legacy.label}`]);
    launchctl(['unload', legacy.plist]);
    const backup = `${legacy.plist}.disabled-${Date.now()}`;
    try {
      fs.renameSync(legacy.plist, backup);
      console.log(`已停用旧巡检器 ${legacy.label}（备份：${path.basename(backup)}）`);
    } catch (err) {
      console.log(`旧巡检器 ${legacy.label} 停不掉：${err.message}`);
    }
  }

  console.log(`已安装：${LABEL}`);
  console.log(`  间隔：每 ${interval} 秒一次`);
  console.log(`  node：${NODE.bin} (${NODE.version})`);
  console.log(`  脚本：${SCRIPT}`);
  console.log(`  日志：${LOG_DIR}/watch.log`);
  console.log(`  plist：${PLIST}`);
  if (out) console.log(`  launchctl：${out}`);
  console.log('\n看状态：launchctl list | grep minimax-mcp');
  console.log('立即跑一轮：node scripts/watch-tick.js');
  console.log('卸载：node scripts/install-watch-agent.js --uninstall');
}

main();
