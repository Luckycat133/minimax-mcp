'use strict';

/**
 * stdio-server.js — 换行分隔 JSON-RPC 2.0 over stdio。
 * 实现 MCP 2024-11-05 必需方法：initialize / tools/list / tools/call / ping。
 */

const readline = require('node:readline');
const { TOOLS } = require('./tools');
const { SERVER_INFO, PROTOCOL_VERSIONS } = require('./contract');
const { callTool } = require('./handler');

function negotiateProtocol(requested) {
  if (!requested) return PROTOCOL_VERSIONS[0];
  if (PROTOCOL_VERSIONS.includes(requested)) return requested;
  return PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];
}

function handle(message) {
  const { id, method, params } = message;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: negotiateProtocol(params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: SERVER_INFO.name,
          version: SERVER_INFO.version,
          title: SERVER_INFO.title,
        },
      },
    };
  }

  if (method === 'notifications/initialized' || method === 'initialized') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }

  if (method === 'tools/call') {
    const name = params?.name;
    if (!name) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: '缺少 params.name' } };
    }
    const known = TOOLS.some((t) => t.name === name);
    if (!known) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `未知工具: ${name}` },
      };
    }
    const result = callTool(name, params?.arguments || {});
    return { jsonrpc: '2.0', id, result };
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `方法不存在: ${method}` },
  };
}

function startStdioServer() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } })}\n`);
      return;
    }
    if (Array.isArray(message)) {
      for (const m of message) {
        const res = handle(m);
        if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
      }
      return;
    }
    const res = handle(message);
    if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
  });

  rl.on('close', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

module.exports = { startStdioServer, handle, negotiateProtocol };
