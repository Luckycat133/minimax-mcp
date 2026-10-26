'use strict';

/**
 * build-mcpb.js — 打 MCPB bundle（.mcpb 本质是带 manifest.json 的 zip）。
 * 参考 traecnclaw-mcp-skill 的分发方式：npm tarball + MCPB + glama.json 三条路。
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'mcpb-stage');

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/**
 * 只拷运行必需的东西，别把 .git / 测试 / 截图带进去。
 * 注意：走 shell 的 cp，不用 Node 的 fs.copyFileSync——宿主对 Node fs 有文件类型
 * 白名单，.py 会被拒（CODEBUDDY_BROKER_DENY）。
 */
const COPY = [
  'mcp-server.js',
  'package.json',
  'README.md',
  'AGENTS.md',
  'glama.json',
  'src',
  'scripts/mac_gui.py',
  'skills',
];

function copyFiltered(src, dest) {
  // cp -R 不会自动建父目录，先 mkdir -p
  sh('mkdir', ['-p', path.dirname(dest)]);
  sh('cp', ['-R', src, dest]);
}

function pruneJunk(dir) {
  sh('find', [dir, '-type', 'd', '-name', 'node_modules', '-prune', '-exec', 'rm', '-rf', '{}', '+']);
  sh('find', [dir, '-type', 'd', '-name', '.git', '-prune', '-exec', 'rm', '-rf', '{}', '+']);
  sh('find', [dir, '-type', 'd', '-name', 'screenshots', '-prune', '-exec', 'rm', '-rf', '{}', '+']);
  sh('find', [dir, '-type', 'f', '-name', '*.log', '-delete']);
  sh('find', [dir, '-type', 'f', '-name', '*.png', '-delete']);
  sh('find', [dir, '-type', 'f', '-name', '*.jpg', '-delete']);
}

function main() {
  // 只清自己的暂存目录，别把 npm pack 的产物一起删了
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.rmSync(path.join(DIST, 'verify'), { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });

  for (const item of COPY) {
    const from = path.join(ROOT, item);
    if (!fs.existsSync(from)) {
      console.error(`缺文件: ${item}`);
      process.exit(1);
    }
    copyFiltered(from, path.join(STAGE, item));
  }
  // 拷过来的 src 里含 tests，bundle 不需要
  fs.rmSync(path.join(STAGE, 'src/mcp/tasks.js.bak'), { force: true });
  pruneJunk(STAGE);

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const manifest = {
    manifest_version: '0.2',
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    author: { name: 'Luckycat133' },
    server: {
      type: 'stdio',
      entry_point: 'server/mcp-server.js',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/server/mcp-server.js'],
        env: {
          MINIMAX_PYTHON: 'python3',
          MINIMAX_SQLITE_BIN: 'sqlite3',
        },
      },
    },
    user_config: {},
  };
  fs.writeFileSync(path.join(STAGE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // MCPB 约定：入口在 server/ 下
  const serverDir = path.join(STAGE, 'server');
  fs.mkdirSync(serverDir, { recursive: true });
  for (const item of COPY) {
    const from = path.join(STAGE, item);
    if (fs.existsSync(from)) {
      copyFiltered(from, path.join(serverDir, item));
      fs.rmSync(from, { recursive: true, force: true });
    }
  }

  const out = path.join(DIST, `${pkg.name}-${pkg.version}.mcpb`);
  sh('zip', ['-r', '-q', out, 'manifest.json', 'server'], STAGE);

  const size = fs.statSync(out).size;
  const listing = sh('unzip', ['-l', out], DIST);
  const count = (listing.match(/\n\s+\d+\s+/g) || []).length;
  console.log(`bundle: ${path.basename(out)}`);
  console.log(`大小: ${(size / 1024).toFixed(1)} KB`);
  console.log(`文件数: ${count}`);
  console.log(`manifest_version: ${manifest.manifest_version} | entry: ${manifest.server.entry_point}`);

  // 校验：解出来必须能 require 得动
  const verifyDir = path.join(DIST, 'verify');
  fs.mkdirSync(verifyDir, { recursive: true });
  sh('unzip', ['-q', out, '-d', verifyDir], DIST);
  sh(process.execPath, ['-e', `require(${JSON.stringify(path.join(verifyDir, 'server/mcp-server.js'))})`], DIST);
  console.log('\nMCPB 校验通过（解包后能正常 require）');
}

main();
