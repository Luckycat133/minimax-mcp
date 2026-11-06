#!/usr/bin/env node

/**
 * cdp-shot.js — Fast, zero-permission screenshot via Chromium DevTools Protocol
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { cdp } = require('../src/gateway/cdp');

const targetPath = process.argv[2] || path.join(process.cwd(), 'cdp_shot.png');

async function main() {
  const isUp = await cdp.isAvailable();
  if (!isUp) {
    process.stderr.write('CDP endpoint not reachable\n');
    process.exit(1);
  }
  const res = await cdp.captureScreenshot(targetPath);
  process.stdout.write(`OK ${res.path} (${res.bytes} bytes)\n`);
  cdp.close();
  process.exit(0);
}

main().catch(err => {
  process.stderr.write(`ERR ${err.message}\n`);
  process.exit(1);
});
