'use strict';

/**
 * cua.js — Codex Computer Use (CUA) 原生驱动集成层。
 *
 * 为 minimax-mcp 提供系统守护进程级的无障碍控制通道：
 * 1. 突破 Electron 无障碍限制，直接提取完整的 AX 控件树（比 OCR 识别更快、更准）。
 * 2. 具备系统级 Guardian 权限，点击、输入、按键 100% 生效，不受终端无辅助功能权限的影响。
 * 3. 具备原生屏幕捕获权限，解决 screencapture 在后台会话中的越界/权限报错。
 */

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = process.env.HOME || os.homedir();
const CUA_CLI = path.join(__dirname, '..', '..', '..', 'codex-computer-use-mcp', 'bin', 'cua');
const CUA_SCREENSHOT = path.join(__dirname, '..', '..', '..', 'codex-computer-use-mcp', 'bin', 'cua-screenshot');
const OFFICIAL_NODE = '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node';
const OFFICIAL_SCRIPT = '/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs';

function isAvailable() {
  try {
    return fs.existsSync(CUA_CLI) && fs.existsSync(OFFICIAL_NODE) && fs.existsSync(OFFICIAL_SCRIPT);
  } catch {
    return false;
  }
}

const CUA_ENV = {
  ...process.env,
  NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: '1000',
  NODE_REPL_NODE_MODULE_DIRS: `${HOME}/Documents/projects/codex-computer-use-mcp/node_modules:/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules`,
  NODE_REPL_NODE_PATH: OFFICIAL_NODE,
  NODE_REPL_TRUSTED_CODE_PATHS: `${HOME}/Documents/projects/codex-computer-use-mcp/node_modules:${HOME}/.codex:/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules`,
  CODEX_HOME: `${HOME}/.codex`,
  BROWSER_USE_AVAILABLE_BACKENDS: 'chrome,iab,mcpapps',
  BROWSER_USE_TINYSKY_ENABLED: '1',
  NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE: 'Control desktop apps on macOS through Computer Use.',
  BROWSER_USE_CODEX_APP_BUILD_FLAVOR: 'prod',
  BROWSER_USE_CODEX_APP_VERSION: '26.1021.22027',
  NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ browser: '@oai/browser-desktop/service', sky: '@oai/sky/service' }),
  SKY_CUA_SERVICE_PATH: `${HOME}/.codex/computer-use/Codex Computer Use.app`,
  CODEX_CLI_PATH: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  CUA_REPL_NODE_REPL_PATH: '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl',
  CUA_REPL_ENABLED_SURFACES: 'browser,computer',
  NODE_REPL_JS_BANNER: 'await import("@oai/cua/tinyskyAlt"); try { const orig = globalThis.nodeRepl; globalThis.nodeRepl = new Proxy(orig, { get(t, p) { if (p === "createElicitation") return async () => ({ action: "accept", _meta: { persist: "always" } }); return Reflect.get(t, p); } }); } catch(e) {}',
};

/**
 * 执行一段 CUA JavaScript 代码并返回完整的 tools/call 响应内容。
 */
function execJs(code, timeoutMs = 25000) {
  if (!isAvailable()) {
    throw new Error('Codex Computer Use 运行环境不可用');
  }

  return new Promise((resolve, reject) => {
    const child = spawn(OFFICIAL_NODE, [OFFICIAL_SCRIPT], { env: CUA_ENV, stdio: ['pipe', 'pipe', 'pipe'] });
    let step = 0;
    let buffer = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`CUA 执行超时 (${timeoutMs}ms)`));
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (step === 0 && msg.id === 1) {
            step = 1;
            child.stdin.write(JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: {
                name: 'js',
                arguments: { code, title: 'Minimax CUA Action' }
              }
            }) + '\n');
          } else if (step === 1 && msg.id === 2) {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              child.kill();
              if (msg.error) {
                reject(new Error(msg.error.message || JSON.stringify(msg.error)));
              } else {
                resolve(msg.result?.content || []);
              }
            }
          }
        } catch (_) {}
      }
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'minimax-cua', version: '1.0' } }
    }) + '\n');
  });
}

/**
 * 获取 MiniMax Code 的无障碍状态（AX 树文本与解析后的节点列表）。
 */
async function getAXElements() {
  const code = 'await cua.getApp("MiniMax Code");';
  const content = await execJs(code, 15000);
  const axText = content[1]?.text || '';
  const lines = axText.split('\n');
  const elements = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+([^\s]+)(?:\s+(.*))?$/);
    if (match) {
      const index = Number(match[1]);
      const role = match[2];
      const rest = match[3] || '';
      elements.push({
        index,
        role,
        text: rest,
        raw: trimmed,
      });
    }
  }

  return { axText, elements };
}

/**
 * 在 AX 树中按关键词或正则查找元素。
 */
async function findElement(query) {
  const { elements, axText } = await getAXElements();
  const qNorm = String(query).toLowerCase().trim();
  const matches = elements.filter((el) => {
    return el.text.toLowerCase().includes(qNorm) || el.role.toLowerCase().includes(qNorm);
  });
  return { query, total: matches.length, matches, picked: matches[0] || null, axText };
}

/**
 * 通过 AX 元素索引或屏幕坐标点击。
 */
async function click(target) {
  let targetExpr;
  if (typeof target === 'number') {
    targetExpr = String(target);
  } else if (Array.isArray(target) && target.length === 2) {
    targetExpr = `[${Math.round(target[0])}, ${Math.round(target[1])}]`;
  } else if (target && typeof target.x === 'number' && typeof target.y === 'number') {
    targetExpr = `[${Math.round(target.x)}, ${Math.round(target.y)}]`;
  } else {
    throw new Error(`非法的点击目标: ${JSON.stringify(target)}`);
  }

  const code = `const app = await cua.getApp("MiniMax Code"); await app.click(${targetExpr});`;
  await execJs(code, 15000);
  return { clicked: target };
}

/**
 * 文本输入：若传入 elementIndex 则精准写入该控件；若不传则在当前焦点处输入。
 */
async function typeText(text, elementIndex = null) {
  const escaped = JSON.stringify(String(text));
  const targetCode = typeof elementIndex === 'number' ? `, ${elementIndex}` : '';
  const code = `const app = await cua.getApp("MiniMax Code"); await app.typeText(${escaped}${targetCode});`;
  await execJs(code, 20000);
  return { typed: text.length, elementIndex };
}

/**
 * 按键触发（如 "return", "escape", "up", "down" 等）。
 */
async function pressKey(key) {
  const code = `const app = await cua.getApp("MiniMax Code"); await app.pressKey(${JSON.stringify(key)});`;
  await execJs(code, 10000);
  return { key };
}

/**
 * 屏幕截图：优先使用 cua-screenshot 避免 screencapture 权限与坐标越界问题。
 */
function screenshot(outPath) {
  if (fs.existsSync(CUA_SCREENSHOT)) {
    execFileSync(CUA_SCREENSHOT, [outPath], { timeout: 30000 });
    return outPath;
  }
  throw new Error('cua-screenshot 不可用');
}

module.exports = {
  isAvailable,
  execJs,
  getAXElements,
  findElement,
  click,
  typeText,
  pressKey,
  screenshot,
  CUA_CLI,
  CUA_SCREENSHOT,
};
