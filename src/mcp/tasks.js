'use strict';

/**
 * tasks.js — 最小可用的 Tasks 扩展实现（io.modelcontextprotocol/tasks 草案）。
 *
 * 目的：让现代 host 不用轮询。流程是
 *   client  initialize 时声明 capabilities.tasks
 *   → send_message 创建一条持久任务，立刻返回 taskId
 *   → 后台轮询 MiniMax，状态变化时通过 notifications/tasks/status 推送
 *   → client 用 tasks/get 看状态、tasks/result 取最终回复
 *
 * 任务落盘在 ~/.minimax-mcp/tasks.json，进程重启不丢。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STORE_PATH = path.join(
  process.env.MINIMAX_MCP_HOME || path.join(os.homedir(), '.minimax-mcp'),
  'tasks.json'
);

/** working → completed | failed | canceled */
function load() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function save(tasks) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(tasks, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
}

function create(meta = {}) {
  const tasks = load();
  const taskId = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  tasks[taskId] = {
    taskId,
    status: 'working',
    createdAt: now,
    updatedAt: now,
    sessionId: meta.sessionId || null,
    afterMessageId: meta.afterMessageId || 0,
    messagePreview: meta.messagePreview || '',
    statusMessage: '已提交，等待 MiniMax 处理',
    result: null,
    error: null,
  };
  save(tasks);
  return tasks[taskId];
}

function get(taskId) {
  return load()[taskId] || null;
}

function list(limit = 50) {
  return Object.values(load())
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

function update(taskId, patch) {
  const tasks = load();
  const t = tasks[taskId];
  if (!t) return null;
  Object.assign(t, patch, { updatedAt: Date.now() });
  save(tasks);
  return t;
}

function cancel(taskId) {
  const t = get(taskId);
  if (!t) return null;
  if (t.status === 'completed' || t.status === 'failed' || t.status === 'canceled') return t;
  return update(taskId, { status: 'canceled', statusMessage: '已取消' });
}

/** 清理超过 retainHours 的终态任务，避免无限增长。 */
function prune(retainHours = 72) {
  const tasks = load();
  const cutoff = Date.now() - retainHours * 3600 * 1000;
  let removed = 0;
  for (const [id, t] of Object.entries(tasks)) {
    // 用 <= ：retainHours=0 的含义是"连刚结束的也清掉"，严格小于会把同一毫秒内
    // 结束的任务漏下（测试里就撞到过）
    if (t.status !== 'working' && t.updatedAt <= cutoff) {
      delete tasks[id];
      removed += 1;
    }
  }
  if (removed) save(tasks);
  return removed;
}

module.exports = { STORE_PATH, create, get, list, update, cancel, prune };
