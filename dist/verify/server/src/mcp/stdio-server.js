'use strict';

/**
 * stdio-server.js — 换行分隔 JSON-RPC 2.0 over stdio。
 * 实现 MCP 2024-11-05 必需方法：initialize / tools/list / tools/call / ping。
 */

const readline = require('node:readline');
const { TOOLS } = require('./tools');
const { SERVER_INFO, PROTOCOL_VERSIONS } = require('./contract');
const { callTool, setTasksEnabled } = require('./handler');
const tasks = require('./tasks');

/** 客户端是否协商了 Tasks 扩展。 */
let tasksEnabled = false;
/** 待推送的状态通知，由轮询器写入、主循环发出。 */
const notifications = [];

function negotiateProtocol(requested) {
  if (!requested) return PROTOCOL_VERSIONS[0];
  if (PROTOCOL_VERSIONS.includes(requested)) return requested;
  return PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];
}

function emit(method, params) {
  notifications.push({ jsonrpc: '2.0', method, params });
}

/** 轮询所有 working 任务，状态一变就发 notifications/tasks/status。 */
function startTaskPoller() {
  const tick = () => {
    for (const t of tasks.list(50)) {
      if (t.status !== 'working') continue;
      const db = require('../gateway/db');
      const r = db.waitForResult(t.sessionId, t.afterMessageId, 1, 0);
      if (r.done) {
        tasks.update(t.taskId, {
          status: 'completed',
          statusMessage: 'MiniMax 已跑完',
          result: r.result,
        });
        emit('notifications/tasks/status', {
          taskId: t.taskId,
          status: 'completed',
          statusMessage: 'MiniMax 已跑完',
        });
      }
    }
    tasks.prune(72);
  };
  const timer = setInterval(tick, 15000);
  timer.unref();
}

function handle(message) {
  const { id, method, params } = message;

  if (method === 'initialize') {
    tasksEnabled = params?.capabilities?.tasks !== undefined;
    setTasksEnabled(tasksEnabled);
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: negotiateProtocol(params?.protocolVersion),
        capabilities: {
          tools: { listChanged: false },
          ...(tasksEnabled ? { tasks: {} } : {}),
        },
        serverInfo: {
          name: SERVER_INFO.name,
          version: SERVER_INFO.version,
          title: SERVER_INFO.title,
        },
      },
    };
  }

  if (method === 'notifications/initialized' || method === 'initialized') {
    if (tasksEnabled) startTaskPoller();
    return null;
  }
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
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `未知工具: ${name}` } };
    }
    const result = callTool(name, params?.arguments || {});
    return { jsonrpc: '2.0', id, result };
  }

  // ---- Tasks 扩展 ----
  if (method === 'tasks/get') {
    const t = tasks.get(params?.taskId);
    if (!t) return { jsonrpc: '2.0', id, error: { code: -32001, message: `任务不存在: ${params?.taskId}` } };
    return { jsonrpc: '2.0', id, result: t };
  }
  if (method === 'tasks/list') {
    return { jsonrpc: '2.0', id, result: { tasks: tasks.list(params?.limit || 50) } };
  }
  if (method === 'tasks/result') {
    const t = tasks.get(params?.taskId);
    if (!t) return { jsonrpc: '2.0', id, error: { code: -32001, message: `任务不存在: ${params?.taskId}` } };
    if (t.status === 'working') {
      return { jsonrpc: '2.0', id, error: { code: -32002, message: '任务还在跑，没有结果' } };
    }
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: t.result || t.error || '' }],
        isError: t.status === 'failed',
      },
    };
  }
  if (method === 'tasks/cancel') {
    const t = tasks.cancel(params?.taskId);
    if (!t) return { jsonrpc: '2.0', id, error: { code: -32001, message: `任务不存在: ${params?.taskId}` } };
    return { jsonrpc: '2.0', id, result: t };
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
    const batch = Array.isArray(message) ? message : [message];
    for (const m of batch) {
      const res = handle(m);
      if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
    }
    // 把轮询积攒的通知发出去
    while (notifications.length) {
      process.stdout.write(`${JSON.stringify(notifications.shift())}\n`);
    }
  });

  rl.on('close', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

module.exports = { startStdioServer, handle, negotiateProtocol, emit };
