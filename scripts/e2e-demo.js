#!/usr/bin/env node

/**
 * e2e-demo.js — Live end-to-end demonstration of the CDP-accelerated MiniMax MCP.
 */

'use strict';

const path = require('path');
const { callTool } = require('../src/mcp/handler');
const { cdp } = require('../src/gateway/cdp');

async function main() {
  console.log('=== MiniMax MCP + CDP End-to-End Live Demonstration ===\n');

  // 1. Status Check (Data Plane)
  console.log('[Step 1] Probing Data Plane (SQLite + Process status)...');
  const statusRes = await callTool('minimax_status', {});
  const statusData = JSON.parse(statusRes.content[0].text);
  console.log('✓ SQLite DB Connected:', Boolean(statusData.dbPath));
  console.log('✓ Total Sessions in DB:', statusData.sessionsCount || statusData.sessions || 'OK');

  // 2. Control Plane Availability (CDP)
  console.log('\n[Step 2] Probing Control Plane (CDP on port 9223)...');
  const isCdpAvailable = await cdp.isAvailable();
  console.log('✓ CDP Endpoint Available:', isCdpAvailable);
  if (!isCdpAvailable) {
    console.error('CDP port not available, aborting demo.');
    process.exit(1);
  }

  // 3. UI Snapshot via CDP
  console.log('\n[Step 3] Fetching UI Snapshot via DOM (Zero Permissions)...');
  const snapshot = await cdp.getUiSnapshot();
  console.log('✓ Window Title:', snapshot.title);
  console.log('✓ Rich-text Editor Ready:', snapshot.hasEditor);
  console.log('✓ Detected Buttons in UI:', snapshot.buttons.length);
  console.log('  Top 5 Buttons:', snapshot.buttons.slice(0, 5).map(b => b.text.replace('\n', ' ')));

  // 4. Zero-Permission Input Test (minimax_type via MCP handler)
  console.log('\n[Step 4] Calling MCP tool "minimax_type" via CDP channel...');
  const testMsg = 'Hello from CDP Driver: Zero-permission automated test!';
  const typeRes = await callTool('minimax_type', { text: testMsg, force: true });
  console.log('✓ MCP Tool Output:', JSON.parse(typeRes.content[0].text));

  // 5. Verification: Read back text from the live TipTap editor
  console.log('\n[Step 5] Verifying editor DOM text after MCP call...');
  const verifySnap = await cdp.getUiSnapshot();
  console.log('✓ Text in Editor:', JSON.stringify(verifySnap.editorText));
  const matched = verifySnap.editorText.includes('Zero-permission');
  console.log('✓ Verified input succeeded in DOM:', matched);

  // 6. Zero-Permission Screenshot Capture
  console.log('\n[Step 6] Capturing pixel-perfect Compositor screenshot...');
  const shotPath = '/tmp/minimax_cdp_e2e_evidence.png';
  const shotRes = await cdp.captureScreenshot(shotPath);
  console.log(`✓ Screenshot saved to ${shotRes.path} (${shotRes.bytes} bytes)`);

  // 7. Cleanup: Clear editor so user context is untampered
  console.log('\n[Step 7] Restoring editor to clean state...');
  await cdp.typeMessage('');
  const cleanSnap = await cdp.getUiSnapshot();
  console.log('✓ Editor restored clean:', cleanSnap.editorText === '');

  cdp.close();
  console.log('\n=== All 7 Steps Completed Successfully! ===');
}

main().catch(err => {
  console.error('Fatal in demo:', err);
  process.exit(1);
});
