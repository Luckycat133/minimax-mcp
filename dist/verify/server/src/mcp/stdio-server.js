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
/** 轮询器只能起一个，客户端重复发 initialized 不该叠加定时器。 */
let pollerStarted = false;

/**
 * 立刻把通知写到 stdout。
 *
 * 原来是把通知攒进数组、等下一次收到客户端消息时一起发——但客户端订阅完就是等，
 * 不会再发消息，于是通知永远卡在数组里。这是实打实的 bug：订阅了却收不到。
 * stdout.write 对单次调用是原子的，直接写就行。
 */
function emit(method, params) {
  try {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  } catch {
    /* 客户端已经断开，写不进去就算了 */
  }
}

function negotiateProtocol(requested) {
  if (!requested) return PROTOCOL_VERSIONS[0];
  if (PROTOCOL_VERSIONS.includes(requested)) return requested;
  return PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];
}

/**
 * 轮询所有 working 任务，状态一变就发 notifications/tasks/status。
 *
 * 用 checkResult 做单次检查，不要调 waitForResult(…,1,0)——
 * 那会以 0ms 间隔空转整整 1 秒/任务，50 个任务就是 50 秒 CPU 满载。
 */
function startTaskPoller() {
  if (pollerStarted) return;
  pollerStarted = true;
  const tick = () => {
    const db = require('../gateway/db');
    for (const t of tasks.list(50)) {
      if (t.status !== 'working') continue;
      const r = db.checkResult(t.sessionId, t.afterMessageId || 0);
      if (r.done) {
        tasks.update(t.taskId, {
          status: 'completed',
          statusMessage: 'MiniMax 已跑完',
          result: r.best.text,
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
  });

  rl.on('close', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

module.exports = { startStdioServer, handle, negotiateProtocol, emit };
