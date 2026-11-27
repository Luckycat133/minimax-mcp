'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { cdp } = require('./cdp');
const gui = require('./gui');

function requireFront() {
  if (gui.activeApp()?.app !== gui.APP) {
    throw new Error('MiniMax Code 不在前台。先调用 minimax_agent({action:"activate"}) 再重试');
  }
}

async function verifyFocus(checkRenderer) {
  if (gui.activeApp()?.app !== gui.APP) return false;
  if (!checkRenderer) return true;
  const context = await cdp.controlContext().catch(() => null);
  return context?.windowFocused === true;
}

async function activateDesktop() {
  const checkRenderer = await cdp.isAvailable();
  if (await verifyFocus(checkRenderer)) return { activated: true, via: 'already-focused' };

  // CDP can focus a page without activating its macOS application.
  gui.openApp();
  if (checkRenderer) await cdp.bringToFront();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await verifyFocus(checkRenderer)) return { activated: true, via: 'gui-open', window: gui.mainWindow() };
    if (attempt < 5) await delay(150);
  }
  throw new Error('MiniMax 窗口未取得前台焦点。请切到 MiniMax Code 后重试');
}

module.exports = { activateDesktop, requireFront };
