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

/**
 * 把 ? 占位符换成转义后的字面量。
 *
 * 为什么不能直接 sql.replace(/\?/g, ...)：字符串字面量里也可能有问号
 * （比如 like '%?%'），那样会把参数错位到字面量内部，SQL 直接跑歪。
 * 所以扫一遍，只在单引号外面替换。
 */
function inlineParams(sql, params) {
  let out = '';
  let i = 0;
  let inQuote = false;
  for (let pos = 0; pos < sql.length; pos += 1) {
    const ch = sql[pos];
    if (ch === "'") {
      // SQL 里 '' 是转义的引号，要成对跳过
      if (inQuote && sql[pos + 1] === "'") {
        out += "''";
        pos += 1;
        continue;
      }
      inQuote = !inQuote;
      out += ch;
      continue;
    }
    if (ch === '?' && !inQuote) {
      if (i >= params.length) throw new Error('SQL 占位符数量与参数不一致');
      out += literal(params[i]);
      i += 1;
      continue;
    }
    out += ch;
  }
  if (i !== params.length) throw new Error(`SQL 占位符 ${i} 个但给了 ${params.length} 个参数`);
  return out;
}

/** 执行一条查询，返回解析后的数组。失败时抛错，由上层转成工具错误。 */
function query(sql, params = []) {
  if (!dbExists()) {
    throw new Error(`找不到 MiniMax 数据库: ${DB_PATH}`);
  }
  const inlined = inlineParams(sql, params);
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
    // 用 ended_at_ms 判"没结束"，不依赖 status 字符串——实测表里只有终态值，
    // 万一以后加了别的中间态，按字符串匹配会悄悄变成 0。
    'select count(*) as n from local_runtime_background_tasks where ended_at_ms is null' 
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

/**
 * 读一个会话的消息。默认取最后 limit 条（最新在最前返回时已 reverse 成时间顺序）。
 * before 传消息 id 可以继续往前翻——一个会话可能有上万条，只给 limit 就没法回溯。
 */
function readSession(sessionArg, limit = 30, includeThinking = false, before = null) {
  const sid = resolveSession(sessionArg);
  if (!sid) return { error: `找不到会话: ${sessionArg}` };
  const useBefore = Number.isFinite(Number(before)) && Number(before) > 0;
  const rows = query(
    "select id, role, created_at_ms, " +
    "json_extract(data_json,'$.msg_content') as content, " +
    "json_extract(data_json,'$.thinking_content') as thinking, " +
    "json_extract(data_json,'$.tool_calls') as toolCalls " +
    "from local_runtime_message_rows where session_id=? " +
    (useBefore ? 'and id < ? ' : '') +
    "order by id desc limit ?",
    useBefore ? [sid, Number(before), limit] : [sid, limit]
  );
  const messages = rows.reverse().map((r) => {
    const m = {
      id: Number(r.id),
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
  return {
    sessionId: sid,
    returned: messages.length,
    // 给调用方一个继续往前翻的锚点；没有更早的消息就是 null
    oldestId: messages.length ? messages[0].id : null,
    hasMore: messages.length === limit,
    messages,
  };
}

function tailSessions(count = 3, perSession = 2) {
  return listSessions(count).map((s) => {
    const r = readSession(s.sessionId, perSession);
    return { ...s, latest: r.messages || [] };
  });
}

/**
 * 跨会话搜索。
 *
 * 默认同时搜**会话标题**和**消息正文**——只搜正文的话，"那个讨论 X 的会话"根本找不到，
 * 而按标题找会话是最高频的用法。标题命中排在前面，因为那是"定位到会话"，
 * 正文命中是"定位到某句话"，粒度不同。
 */
function search(queryText, limit = 20, includeTitles = true) {
  const q = String(queryText ?? '').trim();
  // 空关键词会退化成 LIKE '%%'，把最近 20 条全捞出来冒充"搜索结果"——静默给错答案。
  if (!q) throw new Error('搜索关键词不能为空');
  // LIKE 里 % 和 _ 是通配符，用户搜这两个字符时会被当成模式，得转义
  const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  const pattern = `%${escaped}%`;

  const hits = [];
  if (includeTitles) {
    const titleRows = query(
      'select session_id, title, status, updated_at_ms from local_runtime_sessions ' +
      "where archived = 0 and title like ? escape '\\' " +
      'order by updated_at_ms desc limit ?',
      [pattern, Math.max(1, Math.min(limit, 20))]
    );
    for (const r of titleRows) {
      hits.push({
        kind: 'session',
        sessionId: r.session_id,
        title: r.title || '',
        status: r.status,
        time: localTime(r.updated_at_ms),
        snippet: clip(r.title, 200),
      });
    }
  }

  const rows = query(
    "select session_id, role, created_at_ms, " +
    "json_extract(data_json,'$.msg_content') as content " +
    "from local_runtime_message_rows " +
    "where json_extract(data_json,'$.msg_content') like ? escape '\\' " +
    "order by id desc limit ?",
    [pattern, limit]
  );
  for (const r of rows) {
    hits.push({
      kind: 'message',
      sessionId: r.session_id,
      role: r.role,
      time: localTime(r.created_at_ms),
      snippet: clip(r.content, 200),
    });
  }
  return hits;
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

/** 单个会话的标题等元信息，用于在侧栏里按文字定位。 */
function sessionMeta(sessionId) {
  const row = one(
    'select session_id, title, status, updated_at_ms, archived ' +
    'from local_runtime_sessions where session_id = ? limit 1',
    [sessionId]
  );
  if (!row) {
    // 会话可能还没写进 sessions 表，退回用首条用户消息当标题
    const first = one(
      "select json_extract(data_json,'$.msg_content') as c from local_runtime_message_rows " +
      "where session_id = ? and role = 'user' order by id limit 1",
      [sessionId]
    );
    return { sessionId, title: '', firstUserMessage: clip(first?.c, 80), status: null };
  }
  const first = one(
    "select json_extract(data_json,'$.msg_content') as c from local_runtime_message_rows " +
    "where session_id = ? and role = 'user' order by id limit 1",
    [sessionId]
  );
  return {
    sessionId: row.session_id,
    title: row.title || '',
    status: row.status,
    archived: Number(row.archived || 0),
    lastActivityMs: Number(row.updated_at_ms),
    firstUserMessage: clip(first?.c, 80),
  };
}

/**
 * 等一个会话把当前这轮跑完，返回最终的助手回复。
 * 判定"跑完"用两个信号：会话状态回到 idle，且最后一条 assistant 消息有正文。
 * 这比数消息条数可靠——流式输出过程中会不断追加空 content 的工具调用消息。
 */
/**
 * 单次检查：这个会话跑完了吗？
 * 不睡眠、不重试，给轮询器用——轮询器自己控制节奏，
 * 传 interval=0 进 waitForResult 会变成 1 秒空转，白烧 CPU。
 */
function checkResult(sessionId, afterMessageId) {
  const row = one('select status from local_runtime_sessions where session_id = ?', [sessionId]);
  const status = row?.status || null;
  const msg = one(
    "select id, role, created_at_ms, json_extract(data_json,'$.msg_content') as content "
    + "from local_runtime_message_rows where session_id = ? and id > ? order by id desc limit 1",
    [sessionId, afterMessageId]
  );
  let best = null;
  let lastSeen = afterMessageId;
  if (msg) {
    lastSeen = Number(msg.id);
    const text = (msg.content || '').trim();
    if (msg.role === 'assistant' && text) best = { id: Number(msg.id), text };
  }
  return {
    status,
    lastSeen,
    best,
    done: status === 'idle' && Boolean(best),
  };
}

function waitForResult(sessionId, afterMessageId, timeoutSeconds = 300, intervalMs = 3000) {
  const started = Date.now();
  const deadline = started + timeoutSeconds * 1000;
  let lastSeen = afterMessageId;
  let best = null;

  while (Date.now() < deadline) {
    const c = checkResult(sessionId, lastSeen);
    if (c.lastSeen !== lastSeen) lastSeen = c.lastSeen;
    if (c.best) best = c.best;

    if (c.done) {
      return {
        done: true,
        sessionId,
        waitedAt: localTime(Date.now()),
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

/** 取一条问卷/提问的完整结构（问题、选项、recommended 标记）。 */
function questionnaireDetail(requestId) {
  const row = one(
    'select request_id, session_id, agent_name, status, request_json, ' +
    "datetime(created_at/1000,'unixepoch','localtime') as createdAt, reply_payload " +
    'from questionnaire_requests where request_id = ?',
    [requestId]
  );
  if (!row) return null;
  let parsed = {};
  try {
    parsed = JSON.parse(row.request_json || '{}');
  } catch { /* 保持空 */ }
  const steps = (parsed.steps || []).map((s) => ({
    stepId: s.id,
    question: s.question || '',
    selectionMode: s.selectionMode || 'single',
    required: s.required !== false,
    allowOther: s.allowOther === true,
    options: (s.options || []).map((o) => ({
      optionId: o.id,
      label: o.label || '',
      description: o.description || '',
      recommended: o.recommended === true,
    })),
  }));
  return {
    requestId: row.request_id,
    sessionId: row.session_id,
    agent: row.agent_name,
    status: row.status,
    createdAt: row.createdAt,
    title: parsed.title || '',
    replaceComposer: parsed.presentation?.replaceComposer === true,
    steps,
    answered: row.reply_payload ? safeParse(row.reply_payload) : null,
  };
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * 按 recommended 标记生成一份建议答案，并给出对应的 reply_payload。
 * 只读、无副作用——答了等于替用户做决定，所以这里只出草稿，不提交。
 */
function suggestAnswer(detail) {
  if (!detail) return null;
  const answers = detail.steps.map((s) => {
    const picked = s.options.filter((o) => o.recommended).map((o) => o.optionId);
    const fallback = picked.length ? picked : (s.options[0] ? [s.options[0].optionId] : []);
    return { stepId: s.stepId, selectedOptionIds: fallback, selectedOther: false };
  });
  return {
    basis: '取每步 recommended 标记的选项；没有标记就取第一个',
    answers,
    replyPayload: {
      schemaVersion: 2,
      requestId: detail.requestId,
      answers,
    },
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
  sessionMeta,
  resolveSession,
  readSession,
  tailSessions,
  search,
  pending,
  questionnaireDetail,
  suggestAnswer,
  tasks,
  maxMessageId,
  waitForUserMessage,
  waitForResult,
  checkResult,
  localTime,
  clip,
};
