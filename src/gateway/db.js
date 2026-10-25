'use strict';

/**
 * db.js — MiniMax Code 本地状态只读访问层。
 *
 * 数据源是 MiniMax Code 自己的 SQLite：~/.minimax/v2/sqlite/runtime-state.sqlite
 * 这里只读打开，任何情况下都不写库（App 运行时有内存缓存，写库会造成状态不一致）。
 * 不引第三方依赖：通过系统 sqlite3 CLI 取数，输出用 JSON 模式，避免自己解析管道分隔。
 */

const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const DB_PATH = path.join(os.homedir(), '.minimax/v2/sqlite/runtime-state.sqlite');
const SQLITE_BIN = process.env.MINIMAX_SQLITE_BIN || 'sqlite3';

function dbExists() {
  try {
    return require('node:fs').statSync(DB_PATH).isFile();
  } catch {
    return false;
  }
}

/**
 * sqlite3 CLI 不支持把绑定参数放在 SQL 后面（多出来的 argv 会被当成下一条 SQL），
 * 所以这里把参数转义后直接内联。数字/布尔做严格校验，字符串用双写单引号转义。
 */
function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('非法数字参数');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** 执行一条查询，返回解析后的数组。失败时抛错，由上层转成工具错误。 */
function query(sql, params = []) {
  if (!dbExists()) {
    throw new Error(`找不到 MiniMax 数据库: ${DB_PATH}`);
  }
  let i = 0;
  const inlined = sql.replace(/\?/g, () => {
    if (i >= params.length) throw new Error('SQL 占位符数量与参数不一致');
    return literal(params[i++]);
  });
  const out = execFileSync(SQLITE_BIN, ['-json', DB_PATH, inlined], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const text = out.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new Error('sqlite3 输出不是合法 JSON');
  }
}

function one(sql, params = []) {
  const rows = query(sql, params);
  return rows[0] || null;
}

const localTime = (ms) => {
  if (!ms) return null;
  const d = new Date(Number(ms));
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const sleep = (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* 同步等待 */ }
};

const clip = (s, n = 160) => {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function status() {
  if (!dbExists()) {
    return { dbPath: DB_PATH, dbFound: false, running: false };
  }
  const row = one(
    'select count(distinct session_id) as sessions, count(*) as messages, ' +
    'max(created_at_ms) as lastActivityMs from local_runtime_message_rows'
  );
  const running = one(
    "select count(*) as n from local_runtime_background_tasks where status='running'"
  );
  return {
    dbPath: DB_PATH,
    dbFound: true,
    sessions: Number(row?.sessions || 0),
    messages: Number(row?.messages || 0),
    lastActivity: localTime(row?.lastActivityMs),
    runningTasks: Number(running?.n || 0),
  };
}

function listSessions(limit = 20) {
  const rows = query(
    "select session_id, count(*) as messages, " +
    "datetime(max(created_at_ms)/1000,'unixepoch','localtime') as lastActivity, " +
    "max(created_at_ms) as lastActivityMs " +
    "from local_runtime_message_rows group by session_id " +
    "order by max(created_at_ms) desc limit ?",
    [limit]
  );
  return rows.map((r, i) => {
    const first = one(
      "select json_extract(data_json,'$.msg_content') as c " +
      "from local_runtime_message_rows where session_id=? and role='user' order by id limit 1",
      [r.session_id]
    );
    return {
      index: i + 1,
      sessionId: r.session_id,
      messages: Number(r.messages),
      lastActivity: r.lastActivity,
      lastActivityMs: Number(r.lastActivityMs),
      firstUserMessage: clip(first?.c, 90),
    };
  });
}

function resolveSession(arg) {
  if (arg === undefined || arg === null || arg === '') return null;
  const asString = String(arg);
  if (/^\d+$/.test(asString)) {
    const idx = Number(asString);
    const list = listSessions(Math.max(idx, 1));
    return list[idx - 1]?.sessionId || null;
  }
  const row = one(
    "select session_id from local_runtime_message_rows where session_id like ? limit 1",
    [`${asString}%`]
  );
  return row?.session_id || null;
}

function readSession(sessionArg, limit = 30, includeThinking = false) {
  const sid = resolveSession(sessionArg);
  if (!sid) return { error: `找不到会话: ${sessionArg}` };
  const rows = query(
    "select role, created_at_ms, " +
    "json_extract(data_json,'$.msg_content') as content, " +
    "json_extract(data_json,'$.thinking_content') as thinking, " +
    "json_extract(data_json,'$.tool_calls') as toolCalls " +
    "from local_runtime_message_rows where session_id=? order by id desc limit ?",
    [sid, limit]
  );
  const messages = rows.reverse().map((r) => {
    const m = {
      role: r.role,
      time: localTime(r.created_at_ms),
      content: r.content || '',
    };
    if (r.toolCalls) {
      try {
        const calls = JSON.parse(r.toolCalls);
        m.tools = calls.map((c) => c.tool_name).filter(Boolean);
      } catch { /* 忽略解析失败 */ }
    }
    if (includeThinking && r.thinking) m.thinking = r.thinking;
    return m;
  });
  return { sessionId: sid, returned: messages.length, messages };
}

function tailSessions(count = 3, perSession = 2) {
  return listSessions(count).map((s) => {
    const r = readSession(s.sessionId, perSession);
    return { ...s, latest: r.messages || [] };
  });
}

function search(queryText, limit = 20) {
  const rows = query(
    "select session_id, role, created_at_ms, " +
    "json_extract(data_json,'$.msg_content') as content " +
    "from local_runtime_message_rows " +
    "where json_extract(data_json,'$.msg_content') like ? " +
    "order by id desc limit ?",
    [`%${queryText}%`, limit]
  );
  return rows.map((r) => ({
    sessionId: r.session_id,
    role: r.role,
    time: localTime(r.created_at_ms),
    snippet: clip(r.content, 200),
  }));
}

function pending() {
  const rows = query(
    "select request_id, session_id, agent_name, status, " +
    "datetime(created_at/1000,'unixepoch','localtime') as createdAt, request_json " +
    "from questionnaire_requests where status='pending' order by created_at desc limit 50"
  );
  return rows.map((r) => {
    let question = '';
    try {
      const j = JSON.parse(r.request_json || '{}');
      question = j.question || j.prompt || j.title || clip(JSON.stringify(j), 200);
    } catch { /* 忽略 */ }
    return {
      requestId: r.request_id,
      sessionId: r.session_id,
      agent: r.agent_name,
      createdAt: r.createdAt,
      question: clip(question, 400),
    };
  });
}

function tasks(limit = 20, statusFilter = null) {
  const rows = statusFilter
    ? query(
        "select task_id, owner_session_id, kind, status, " +
        "datetime(created_at_ms/1000,'unixepoch','localtime') as createdAt, " +
        "datetime(updated_at_ms/1000,'unixepoch','localtime') as updatedAt " +
        "from local_runtime_background_tasks where status=? " +
        "order by updated_at_ms desc limit ?",
        [statusFilter, limit]
      )
    : query(
        "select task_id, owner_session_id, kind, status, " +
        "datetime(created_at_ms/1000,'unixepoch','localtime') as createdAt, " +
        "datetime(updated_at_ms/1000,'unixepoch','localtime') as updatedAt " +
        "from local_runtime_background_tasks order by updated_at_ms desc limit ?",
        [limit]
      );
  return rows.map((r) => ({
    taskId: r.task_id,
    sessionId: r.owner_session_id,
    kind: r.kind,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/**
 * 最近被"碰到"的会话：取 local_runtime_sessions.updated_at_ms 最新的几个。
 * 打开/切换会话会刷新这个时间戳，比消息活跃度更接近"用户正在看哪个"。
 */
function recentlyTouchedSessions(limit = 3) {
  const rows = query(
    'select session_id, title, status, updated_at_ms ' +
    'from local_runtime_sessions where archived = 0 ' +
    'order by updated_at_ms desc limit ?',
    [limit]
  );
  return rows.map((r) => ({
    sessionId: r.session_id,
    title: r.title || '',
    status: r.status,
    lastActivityMs: Number(r.updated_at_ms),
  }));
}

/**
 * 等一个会话把当前这轮跑完，返回最终的助手回复。
 * 判定"跑完"用两个信号：会话状态回到 idle，且最后一条 assistant 消息有正文。
 * 这比数消息条数可靠——流式输出过程中会不断追加空 content 的工具调用消息。
 */
function waitForResult(sessionId, afterMessageId, timeoutSeconds = 300, intervalMs = 3000) {
  const started = Date.now();
  const deadline = started + timeoutSeconds * 1000;
  let lastSeen = afterMessageId;
  let best = null;

  while (Date.now() < deadline) {
    const row = one(
      'select status from local_runtime_sessions where session_id = ?',
      [sessionId]
    );
    const status = row?.status || null;

    const msg = one(
      "select id, role, created_at_ms, json_extract(data_json,'$.msg_content') as content "
      + "from local_runtime_message_rows where session_id = ? and id > ? order by id desc limit 1",
      [sessionId, lastSeen]
    );
    if (msg) {
      lastSeen = Number(msg.id);
      const text = (msg.content || '').trim();
      if (msg.role === 'assistant' && text) best = { id: Number(msg.id), text };
    }

    // 状态回到 idle 且已经拿到正文 → 这一轮结束了
    if (status === 'idle' && best) {
      return {
        done: true,
        sessionId,
        waitedSeconds: Math.round((Date.now() - started) / 1000),
        lastAssistantMessageId: best.id,
        result: best.text,
      };
    }
    sleep(intervalMs);
  }

  return {
    done: false,
    sessionId,
    waitedSeconds: Math.round((Date.now() - started) / 1000),
    lastAssistantMessageId: best ? best.id : null,
    result: best ? best.text : null,
    note: '超时了还没回到 idle；结果可能是半成品',
  };
}

/** 取当前最大消息 id，用于发送后判断有没有真的入库。 */
function maxMessageId() {
  const row = one('select coalesce(max(id),0) as m from local_runtime_message_rows');
  return Number(row?.m || 0);
}

/** 轮询数据库，确认以 prefix 开头的新用户消息已入库。 */
function waitForUserMessage(afterId, prefix, tries = 16, intervalMs = 500) {
  const needle = String(prefix || '').slice(0, 12).trim();
  for (let i = 0; i < tries; i += 1) {
    const row = one(
      "select id, session_id, json_extract(data_json,'$.msg_content') as content " +
      "from local_runtime_message_rows where role='user' and id > ? order by id desc limit 1",
      [afterId]
    );
    if (row && String(row.content || '').trim().startsWith(needle)) {
      return { ok: true, messageId: Number(row.id), sessionId: row.session_id };
    }
    if (i < tries - 1) {
      const end = Date.now() + intervalMs;
      while (Date.now() < end) { /* 同步 sleep */ }
    }
  }
  return { ok: false };
}

module.exports = {
  DB_PATH,
  dbExists,
  query,
  status,
  listSessions,
  recentlyTouchedSessions,
  resolveSession,
  readSession,
  tailSessions,
  search,
  pending,
  tasks,
  maxMessageId,
  waitForUserMessage,
  waitForResult,
  localTime,
  clip,
};
