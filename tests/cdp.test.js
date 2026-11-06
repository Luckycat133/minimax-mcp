'use strict';

/**
 * cdp.test.js — Verify MiniMax CDP driver capabilities
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { cdp } = require('../src/gateway/cdp');

let passed = 0;
let total = 0;

function record(name, ok, detail = '') {
  total += 1;
  if (ok) {
    passed += 1;
    console.log(`[OK]   ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function run() {
  console.log('\n--- MiniMax CDP Driver Tests ---');

  // 1. Availability probe
  const isUp = await cdp.isAvailable();
  if (!isUp) {
    console.log(`[-] CDP is offline on port ${cdp.port} (skipping live UI tests; run node scripts/launch-with-debug.js for live test)`);
    console.log(`Passed: 0/0 (live integration skipped when offline)\n`);
    return;
  }
  record('CDP is online on port ' + cdp.port, true);

  // 2. UI snapshot
  try {
    const snap = await cdp.getUiSnapshot();
    const ok = Boolean(snap && snap.title === 'MiniMax Code' && snap.hasEditor && Array.isArray(snap.buttons));
    record('getUiSnapshot returns valid state', ok, `buttons: ${snap?.buttons?.length || 0}, editor: ${snap?.hasEditor}`);
  } catch (err) {
    record('getUiSnapshot returns valid state', false, err.message);
  }

  // 3. Find text via DOM
  try {
    const hits = await cdp.findText('新建任务');
    const ok = Array.isArray(hits) && hits.length > 0 && typeof hits[0].cx === 'number';
    record('findText locates DOM element', ok, `found ${hits.length} nodes, top at (${hits[0]?.cx}, ${hits[0]?.cy})`);
  } catch (err) {
    record('findText locates DOM element', false, err.message);
  }

  // 4. Input & clear
  try {
    const typeRes = await cdp.typeMessage('Hello CDP Unit Test');
    const hasTyped = typeRes && typeRes.ok && typeRes.currentText.includes('Hello CDP');
    const clearRes = await cdp.typeMessage('');
    const hasCleared = clearRes && clearRes.ok && clearRes.currentText === '';
    record('typeMessage can write and clear editor', hasTyped && hasCleared, `typed: ${hasTyped}, cleared: ${hasCleared}`);
  } catch (err) {
    record('typeMessage can write and clear editor', false, err.message);
  }

  // 5. Screenshot via CDP
  try {
    const tmpShot = path.join(require('os').tmpdir(), `cdp-test-shot-${Date.now()}.png`);
    const shotRes = await cdp.captureScreenshot(tmpShot);
    const fileExists = fs.existsSync(tmpShot);
    const size = fileExists ? fs.statSync(tmpShot).size : 0;
    if (fileExists) fs.unlinkSync(tmpShot);
    record('captureScreenshot exports valid PNG', fileExists && size > 1000, `${size} bytes`);
  } catch (err) {
    record('captureScreenshot exports valid PNG', false, err.message);
  }

  cdp.close();

  console.log(`\n${passed}/${total} 通过\n`);
  if (passed !== total) {
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Fatal in cdp.test.js:', err);
  process.exit(1);
});
