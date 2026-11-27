'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');

async function connect({
  clientName = 'minimax-cli', timeoutMs = 15000, capabilities = {}, nodeArgs = [], env = process.env,
} = {}) {
  const server = path.join(__dirname, '..', 'mcp-server.js');
  const child = spawn(process.execPath, [...nodeArgs, server], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  let closed = false;

  function disconnect(error) {
    closed = true;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  }

  lines.on('line', (line) => {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      disconnect(new Error('MCP stdout 含有非 JSON 消息'));
      return;
    }
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.error) request.reject(Object.assign(new Error(response.error.message), { code: response.error.code }));
    else request.resolve(response.result);
  });
  child.on('error', disconnect);
  child.stdin.on('error', disconnect);
  child.on('exit', (code, signal) => disconnect(new Error(`MCP 服务已退出 (${signal || code})`)));

  const notify = (method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  function request(method, params = {}) {
    if (closed) return Promise.reject(new Error('MCP 连接已关闭'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        notify('notifications/cancelled', { requestId: id, reason: 'Client timeout' });
        reject(new Error(`MCP 请求超时 (${method})`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  function close() {
    lines.close();
    child.stdin.end();
    child.kill();
  }

  try {
    const init = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities,
      clientInfo: { name: clientName, version: '1' },
    });
    if (!init?.capabilities?.tools) throw new Error('MCP 服务未声明 tools 能力');
    notify('notifications/initialized');
    return {
      init,
      request,
      close,
      call: (name, args = {}) => request('tools/call', { name, arguments: args }),
    };
  } catch (error) {
    close();
    throw error;
  }
}

module.exports = { connect };
