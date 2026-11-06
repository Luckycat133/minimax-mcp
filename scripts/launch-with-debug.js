#!/usr/bin/env node

/**
 * launch-with-debug.js — Launch or restart MiniMax Code with CDP remote debugging.
 *
 * Modeled after TRAECNclaw's process recovery policy:
 * - Detects if MiniMax Code is already running
 * - Gracefully stops it via SIGTERM
 * - Relaunches with --remote-debugging-port=<port>
 * - Verifies the CDP endpoint is online
 */

'use strict';

const { execSync } = require('child_process');
const http = require('http');

const PORT = Number(process.env.MINIMAX_CDP_PORT) || 9223;
const APP_PATH = '/Applications/MiniMax Code.app';

function probeCdp(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, { timeout: 1500 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function getRunningPids() {
  try {
    const out = execSync(`pgrep -f "${APP_PATH}/Contents/MacOS/MiniMax Code"`).toString().trim();
    return out.split('\n').map(s => Number(s.trim())).filter(n => !isNaN(n) && n > 0);
  } catch {
    return [];
  }
}

async function stopAppGracefully() {
  const pids = getRunningPids();
  if (pids.length === 0) return true;

  console.log(`[LaunchDebug] Stopping existing MiniMax Code (PIDs: ${pids.join(', ')})...`);
  try {
    execSync('osascript -e "tell application \\"MiniMax Code\\" to quit"', { stdio: 'ignore' });
  } catch {}

  // Wait up to 3s for graceful AppleScript quit
  for (let i = 0; i < 6; i++) {
    execSync('sleep 0.5');
    if (getRunningPids().length === 0) return true;
  }

  // Next level: SIGTERM
  for (const pid of getRunningPids()) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  for (let i = 0; i < 6; i++) {
    execSync('sleep 0.5');
    if (getRunningPids().length === 0) return true;
  }

  // Final level: SIGKILL
  for (const pid of getRunningPids()) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  for (let i = 0; i < 6; i++) {
    execSync('sleep 0.5');
    if (getRunningPids().length === 0) return true;
  }

  return getRunningPids().length === 0;
}

async function main() {
  console.log(`[LaunchDebug] Checking CDP on port ${PORT}...`);
  if (await probeCdp(PORT)) {
    console.log(`[LaunchDebug] MiniMax Code is ALREADY listening on CDP port ${PORT}. Ready!`);
    return;
  }

  const stopped = await stopAppGracefully();
  console.log(`[LaunchDebug] Application stopped completely: ${stopped}`);

  console.log(`[LaunchDebug] Launching MiniMax Code with --remote-debugging-port=${PORT}...`);
  execSync(`open -a "${APP_PATH}" --args --remote-debugging-port=${PORT}`);

  // Poll for CDP up to 15s
  let ready = false;
  for (let i = 0; i < 30; i++) {
    execSync('sleep 0.5');
    if (await probeCdp(PORT)) {
      ready = true;
      break;
    }
  }

  if (ready) {
    console.log(`[LaunchDebug] SUCCESS: MiniMax Code is now running with CDP on port ${PORT}!`);
  } else {
    console.error(`[LaunchDebug] ERROR: Timed out waiting for CDP port ${PORT} to come up.`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[LaunchDebug] Fatal:', err.message);
  process.exit(1);
});
