'use strict';

/**
 * build-npm-package.js — 打 npm tarball 并校验内容。
 * 不发布，只本地打包 + 断言关键文件都在包里。
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const MUST_CONTAIN = [
  'package/package.json',
  'package/mcp-server.js',
  'package/src/mcp/index.js',
  'package/src/gateway/db.js',
  'package/src/gateway/gui.js',
  'package/scripts/mac_gui.py',
  'package/skills/minimax-mcp/SKILL.md',
  'package/README.md',
];

const MUST_NOT_CONTAIN = [
  'package/.git',
  'package/node_modules',
  'package/screenshots',
  'package/dist',
];

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function main() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  const packOut = sh('npm', ['pack', '--pack-destination', DIST, '--silent'], ROOT);
  const tarball = packOut.trim().split('\n').pop().trim();
  const tarballPath = path.join(DIST, tarball);
  if (!fs.existsSync(tarballPath)) {
    console.error(`npm pack 没产出 tarball：${tarball}`);
    process.exit(1);
  }

  const listing = sh('tar', ['-tzf', tarballPath], ROOT);
  const entries = listing.split('\n').map((s) => s.trim()).filter(Boolean);
  const set = new Set(entries);

  const problems = [];
  for (const f of MUST_CONTAIN) {
    if (!set.has(f)) problems.push(`包里缺 ${f}`);
  }
  for (const f of MUST_NOT_CONTAIN) {
    if (entries.some((e) => e === f || e.startsWith(`${f}/`))) problems.push(`包里不该有 ${f}`);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  // files 里可能是 "src/**/*.js" 这种 glob，取第一段目录来判断
  const declared = new Set((pkg.files || []).map((f) => f.split('/')[0]));
  for (const need of ['mcp-server.js', 'src', 'scripts', 'skills', 'README.md']) {
    if (!declared.has(need)) problems.push(`package.json files 没覆盖 ${need}`);
  }

  const size = fs.statSync(tarballPath).size;
  console.log(`tarball: ${tarball}`);
  console.log(`大小: ${(size / 1024).toFixed(1)} KB`);
  console.log(`条目数: ${entries.length}`);
  if (problems.length) {
    console.error('\n有问题:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('\nnpm 包校验通过');
}

main();
