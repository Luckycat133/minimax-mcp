#!/usr/bin/env node
'use strict';

/**
 * call.js — 一次性调用某个工具，不需要常驻 MCP 客户端。
 *   node scripts/call.js minimax_status
 *   node scripts/call.js minimax_read_session '{"session":"1","limit":5}'
 *   node scripts/call.js minimax_send_message '{"message":"继续","send":true}'
 */

const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'mcp-server.js');
const [tool, rawArgs] = process.argv.slice(2);

if (!tool) {
  console.error('用法: node scripts/call.js <工具名> [JSON参数]');
  process.exit(2);
}

let args = {};
if (rawArgs) {
  try { args = JSON.parse(rawArgs); } catch (err) {
    console.error(`参数不是合法 JSON: ${err.message}`);
    process.exit(2);
  }
}

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
const rl = readline.createInterface({ input: child.stdout, terminal: false });
let nextId = 1;
const waiting = new Map();

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  const done = waiting.get(msg.id);
  if (done) { waiting.delete(msg.id); done(msg); }
});

const send = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  waiting.set(id, resolve);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  setTimeout(() => { if (waiting.delete(id)) reject(new Error(`超时: ${method}`)); }, 90000);
});

(async () => {
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'minimax-call', version: '1' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

  const res = await send('tools/call', { name: tool, arguments: args });
  const result = res.result || {};
  const text = (result.content || []).map((c) => c.text || '').join('\n');
  if (result.isError) {
    console.error(text);
    process.exit(1);
  }
  console.log(text);
  process.exit(0);
})().catch((err) => {
  console.error(`调用失败: ${err.message}`);
  process.exit(1);
});
