'use strict';

/**
 * setup-permissions.js — 为没有 Computer Use 的通用 Agent 和用户一键配置 macOS 权限
 * 
 * 作用：
 * 1. 检测辅助功能（Accessibility）与屏幕录制（Screen Recording）权限。
 * 2. 识别当前调用方宿主（如 Terminal, Cursor, VSCode, Claude, Antigravity）。
 * 3. 自动调起 macOS 系统设置面板直达授权页面。
 */

const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

const MAC_GUI = path.join(__dirname, 'mac_gui.py');

function checkAccessibility() {
  try {
    const out = execFileSync('python3', [MAC_GUI, 'check'], { encoding: 'utf8' });
    return /已授权/.test(out);
  } catch {
    return false;
  }
}

function checkScreenCapture() {
  try {
    // 快速试探 screencapture
    const out = spawnSync('screencapture', ['-x', '-R', '0,0,1,1', '/tmp/perm_test.png']);
    return out.status === 0;
  } catch {
    return false;
  } finally {
    try { require('node:fs').unlinkSync('/tmp/perm_test.png'); } catch (_) {}
  }
}

function openSettings(panel) {
  try {
    execFileSync('open', [`x-apple.systempreferences:com.apple.preference.security?Privacy_${panel}`]);
    return true;
  } catch {
    return false;
  }
}

function main() {
  console.log('=== MiniMax MCP macOS 权限配置向导 ===\n');

  const hasAx = checkAccessibility();
  const hasScr = checkScreenCapture();

  console.log(`1. 辅助功能 (Accessibility):  ${hasAx ? '✅ 已授权' : '❌ 未授权'}`);
  console.log(`2. 屏幕录制 (Screen Capture): ${hasScr ? '✅ 已授权' : '❌ 未授权'}\n`);

  if (hasAx && hasScr) {
    console.log('🎉 所有必要权限均已就绪！任何 Agent 均可原生驱动 MiniMax Code。');
    process.exit(0);
  }

  console.log('📌 缺少权限时的解决方式（只需一次性开启）：');
  if (!hasAx) {
    console.log('  👉 辅助功能：用于模拟鼠标点击与输入。正在打开设置面板...');
    openSettings('Accessibility');
    console.log('     请在弹出的设置窗口中，找到并勾选你当前使用的宿主应用（如 Terminal / VSCode / Cursor / Claude）。\n');
  }

  if (!hasScr) {
    console.log('  👉 屏幕录制：用于 Vision OCR 界面文字定位。正在打开设置面板...');
    openSettings('ScreenCapture');
    console.log('     请在弹出的设置窗口中勾选当前宿主应用。\n');
  }

  console.log('💡 提示：开启权限后，请重启终端或 Agent 宿主使系统授权生效。');
}

main();
