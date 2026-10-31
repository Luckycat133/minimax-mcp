'use strict';
/**
 * watch.js — 主动巡检：比对两次快照，产出事件，并按策略执行低风险动作。
 *
 * 为什么是"轮询 + 快照 diff"而不是监听：
 * MiniMax 没有对外事件接口，能读的只有 SQLite。所以只能在服务端做 diff，
 * 把"状态变化"还原成事件。好处是无侵入，坏处是精度取决于轮询间隔。
 *
 * 事件与动作分开记录：
 *   events   —— 发生了什么（只读事实）
 *   actions  —— 我做了什么（可审计的动作，带策略判定理由）
 *
 * 状态落盘在 ~/.minimax-mcp/watch-state.json，所以进程重启不会重复报同一件事。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const db = require('./db');
const brief = require('./brief');
const policyMod = require('./policy');

const DIR = path.join(os.homedir(), '.minimax-mcp');
const STATE_FILE = path.join(DIR, 'watch-state.json');
const EVENT_FILE = path.join(DIR, 'events.jsonl');
const REPORT_FILE = path.join(DIR, 'report.md');
const MAX_EVENT_BYTES = 1024 * 1024;
const EMIT_TTL_MS = 24 * 3600 * 1000;

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

/**
 * 人离开多久了（秒）。用 HIDIdleTime 读系统级输入闲置时间。
 * 读不到就返回 null——调用方按"人在"处理，宁可不自动动。
 */
function idleSeconds() {
  try {
    const out = execFileSync('ioreg', ['-c', 'IOHIDSystem'], {
      encoding: 'utf8', timeout: 8000, maxBuffer: 4 * 1024 * 1024,
    });
    const m = out.match(/"HIDIdleTime"\s*=\s*(\d+)/);
    if (!m) return null;
    return Math.floor(Number(m[1]) / 1e9);
  } catch {
    return null;
  }
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      version: 1,
      lastTick: raw.lastTick || 0,
      sessions: raw.sessions || {},
      emitted: raw.emitted || {},
      lastRun: raw.lastRun || null,
    };
  } catch {
    return { version: 1, lastTick: 0, sessions: {}, emitted: {}, lastRun: null };
  }
}

function saveState(state) {
  try {
    ensureDir();
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 1)}\n`);
  } catch {
    /* 状态写不进去不该让巡检失败 */
  }
}

/** 当前每个会话的关键状态。只取需要的字段，避免把整库拖进内存。 */
function snapshot() {
  const rows = db.query(
    'select s.session_id, s.title, s.status, s.updated_at_ms, s.error_message, ' +
    "(select m.id from local_runtime_message_rows m where m.session_id = s.session_id order by m.id desc limit 1) as last_id, " +
    "(select m.role from local_runtime_message_rows m where m.session_id = s.session_id order by m.id desc limit 1) as last_role, " +
    "(select m.created_at_ms from local_runtime_message_rows m where m.session_id = s.session_id order by m.id desc limit 1) as last_ms, " +
    "(select substr(json_extract(m.data_json,'$.msg_content'),1,200) from local_runtime_message_rows m where m.session_id = s.session_id order by m.id desc limit 1) as last_text " +
    'from local_runtime_sessions s where s.archived = 0 ' +
    'order by s.updated_at_ms desc limit 300'
  );
  const map = new Map();
  for (const r of rows) {
    map.set(r.session_id, {
      sessionId: r.session_id,
      title: r.title || '',
      status: r.status,
      updatedAtMs: Number(r.updated_at_ms || 0),
      errorMessage: r.error_message || '',
      lastId: r.last_id ? Number(r.last_id) : null,
      lastRole: r.last_role || null,
      lastMs: r.last_ms ? Number(r.last_ms) : null,
      lastText: String(r.last_text || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    });
  }
  return map;
}

/**
 * 写一份人能直接读的 report.md。
 * 保留这个是因为之前的巡检器就是产出 report.md，换掉之后不能让人突然少个东西看。
 */
function writeReport(result, briefData) {
  try {
    ensureDir();
    const lines = [];
    lines.push(`# MiniMax 巡检报告`);
    lines.push('');
    lines.push(`生成时间：${result.at}　|　人已离开：${result.idleSeconds ?? '未知'} 秒　|　策略：${result.policy.mode} / 上限 ${result.policy.riskCeiling}`);
    lines.push('');
    lines.push(`**${briefData.headline}**`);
    lines.push('');

    if (result.needsHuman.length) {
      lines.push('## 需要你处理');
      for (const n of result.needsHuman) {
        lines.push(`- ${n.title || n.sessionId}${n.risk ? `（风险 ${n.risk}）` : ''} — ${n.why || n.reason || ''}`);
      }
      lines.push('');
    }
    if (result.actions.length) {
      lines.push('## 我自动做了');
      for (const a of result.actions) {
        lines.push(`- ${a.tool} ${a.planned ? '(仅计划)' : a.ok ? '✓' : '✗'} — ${a.why || ''}${a.verified !== undefined && a.verified !== null ? `（数据库核对：${a.verified}）` : ''}`);
      }
      lines.push('');
    }
    if (result.events.length) {
      lines.push('## 本轮变化');
      for (const e of result.events) {
        lines.push(`- \`${e.type}\` ${e.title || ''} — ${(e.detail || '').slice(0, 120)}`);
      }
      lines.push('');
    }
    if (briefData.items.length) {
      lines.push('## 全量待办（按优先级）');
      for (const it of briefData.items) {
        lines.push(`- [${it.kind}] ${it.title} — ${it.why}`);
      }
      lines.push('');
    }
    fs.writeFileSync(REPORT_FILE, `${lines.join('\n')}\n`);
  } catch {
    /* 报告写不进去不影响巡检 */
  }
}

function appendEvents(list) {
  if (!list.length) return;
  try {
    ensureDir();
    try {
      const st = fs.statSync(EVENT_FILE);
      if (st.size > MAX_EVENT_BYTES) fs.renameSync(EVENT_FILE, `${EVENT_FILE}.1`);
    } catch { /* 首次写 */ }
    const lines = list.map((e) => JSON.stringify(e)).join('\n');
    fs.appendFileSync(EVENT_FILE, `${lines}\n`);
  } catch {
    /* 事件写不进去不影响巡检 */
  }
}

/** 读事件队列，since 可以是时间戳（ms）或 ISO 时间。 */
function readEvents(since, limit = 50) {
  let rows = [];
  try {
    const text = fs.readFileSync(EVENT_FILE, 'utf8');
    rows = text.trim().split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return { events: [], count: 0 };
  }
  let filtered = rows;
  if (since) {
    const t = typeof since === 'number' ? since : Date.parse(since);
    if (!Number.isNaN(t)) filtered = rows.filter((e) => Date.parse(e.at) >= t);
  }
  return { events: filtered.slice(-limit), count: filtered.length, total: rows.length };
}

function pruneEmitted(emitted, now) {
  const out = {};
  for (const [k, ts] of Object.entries(emitted)) {
    if (now - Number(ts) < EMIT_TTL_MS) out[k] = ts;
  }
  return out;
}

/**
 * 跑一轮巡检。
 *
 * opts:
 *   policy     —— 见 policy.DEFAULT_POLICY
 *   execute    —— (toolName, args) => result，由 handler 注入，用来真正执行自动动作
 *   dryRun     —— true 时只算不执行（默认 false）
 *   stalledMinutes / finishedMinutes —— 覆盖 brief 的阈值
 *
 * 返回 {at, idleSeconds, events, actions, needsHuman, counts}
 */
function tick(opts = {}) {
  const policy = { ...policyMod.DEFAULT_POLICY, ...(opts.policy || {}) };
  const execute = opts.execute || (() => ({ skipped: true, reason: '没有注入执行器' }));
  const dryRun = opts.dryRun === true;
  const now = Date.now();
  const idle = idleSeconds();

  const state = loadState();
  const prev = state.sessions || {};
  const cur = snapshot();
  const emitted = pruneEmitted(state.emitted || {}, now);

  const events = [];
  const actions = [];
  const needsHuman = [];
  let actionBudget = policy.maxActionsPerTick;

  const emit = (ev) => {
    const key = ev.key;
    delete ev.key;
    if (emitted[key]) return false;
    emitted[key] = now;
    events.push(ev);
    return true;
  };

  const b = brief.brief({
    stalledMinutes: opts.stalledMinutes,
    finishedMinutes: opts.finishedMinutes,
    limit: 300,
  });
  const pendingBySession = new Map();
  for (const q of db.pending()) pendingBySession.set(q.sessionId, q);

  // ---------- 1. 状态迁移 ----------
  for (const [sid, s] of cur) {
    const p = prev[sid];
    if (!p) continue; // 新会话不产生"变化"事件，避免第一次跑就刷一堆

    if (p.status !== s.status) {
      if (s.status === 'error') {
        emit({
          key: `error:${sid}:${s.lastId || 0}`,
          at: new Date(now).toISOString(),
          type: 'error',
          sessionId: sid,
          title: s.title || s.lastText.slice(0, 40),
          detail: s.errorMessage.slice(0, 200),
        });
      } else if (p.status === 'error' && (s.status === 'idle' || s.status === 'started')) {
        emit({
          key: `recovered:${sid}:${now}`,
          at: new Date(now).toISOString(),
          type: 'recovered',
          sessionId: sid,
          title: s.title || '',
          detail: `从 error 恢复到 ${s.status}`,
        });
      }
      if (p.status === 'started' && s.status !== 'started' && s.lastRole === 'assistant') {
        emit({
          key: `finished:${sid}:${s.lastId || 0}`,
          at: new Date(now).toISOString(),
          type: 'finished',
          sessionId: sid,
          title: s.title || '',
          detail: s.lastText.slice(0, 160),
        });
      }
    }

    if (p.lastId && s.lastId && s.lastId > p.lastId && s.lastRole === 'assistant' && p.status === 'started' && s.status !== 'started') {
      // 状态没变但消息推进了，也算完成（有些会话状态不落库）
      emit({
        key: `finished:${sid}:${s.lastId}`,
        at: new Date(now).toISOString(),
        type: 'finished',
        sessionId: sid,
        title: s.title || '',
        detail: s.lastText.slice(0, 160),
      });
    }
  }

  // ---------- 2. 新提问 ----------
  for (const [sid, q] of pendingBySession) {
    const detail = db.questionnaireDetail(q.requestId);
    const decision = policyMod.decideQuestion(detail, { policy, idleSeconds: idle === null ? undefined : idle });
    const isNew = !prev[sid] || !(prev[sid].pendingIds || []).includes(q.requestId);

    if (isNew) {
      emit({
        key: `question:${q.requestId}`,
        at: new Date(now).toISOString(),
        type: 'question',
        sessionId: sid,
        title: q.question.slice(0, 80),
        detail: `风险=${decision.risk.level}；${decision.why}`,
        requestId: q.requestId,
        risk: decision.risk.level,
        riskReasons: decision.risk.reasons,
      });
    }

    if (decision.action === 'auto_answer') {
      if (actionBudget <= 0) {
        needsHuman.push({ sessionId: sid, requestId: q.requestId, reason: '本轮自动动作额度用完了' });
        continue;
      }
      if (dryRun) {
        actions.push({ tool: 'minimax_answer_question', args: { requestId: q.requestId }, planned: true, why: decision.why });
        continue;
      }
      const res = execute('minimax_answer_question', {
        requestId: q.requestId,
        preview: false,
        force: true,
      });
      actionBudget -= 1;
      const payload = safePayload(res);
      actions.push({
        tool: 'minimax_answer_question',
        args: { requestId: q.requestId },
        why: decision.why,
        ok: res && res.isError !== true,
        verified: payload ? payload.verified : null,
        status: payload ? payload.status : null,
      });
      emit({
        key: `auto_answer:${q.requestId}`,
        at: new Date(now).toISOString(),
        type: 'auto_action',
        sessionId: sid,
        title: q.question.slice(0, 60),
        detail: `已代答（${decision.risk.level}）：${payload && payload.verified ? '数据库已确认' : '未能确认'}`,
        requestId: q.requestId,
      });
    } else if (decision.action === 'ask_human') {
      needsHuman.push({
        sessionId: sid,
        requestId: q.requestId,
        title: q.question.slice(0, 80),
        risk: decision.risk.level,
        reasons: decision.risk.reasons,
        why: decision.why,
      });
    }
  }

  // ---------- 3. 卡住的会话 ----------
  for (const item of b.items) {
    if (item.kind !== 'stalled') continue;
    const s = cur.get(item.sessionId);
    if (!s) continue;
    if (pendingBySession.has(item.sessionId)) continue; // 在等回答，不算卡住

    emit({
      key: `stalled:${item.sessionId}:${s.lastId || 0}`,
      at: new Date(now).toISOString(),
      type: 'stalled',
      sessionId: item.sessionId,
      title: s.title || '',
      detail: `末条是你的指令，${item.age}没人回`,
    });

    const lastNudge = prev[item.sessionId] && prev[item.sessionId].nudgedAt
      ? Math.round((now - prev[item.sessionId].nudgedAt) / 60000)
      : undefined;
    const decision = policyMod.decideNudge(s, {
      policy,
      idleSeconds: idle === null ? undefined : idle,
      lastNudgeMinutes: lastNudge,
    });
    if (decision.action !== 'auto_nudge') {
      if (decision.why && !/冷却中/.test(decision.why)) {
        needsHuman.push({ sessionId: item.sessionId, reason: decision.why });
      }
      continue;
    }
    if (actionBudget <= 0) {
      needsHuman.push({ sessionId: item.sessionId, reason: '本轮自动动作额度用完了' });
      continue;
    }
    if (dryRun) {
      actions.push({ tool: 'minimax_send_message', args: { sessionId: item.sessionId }, planned: true, why: decision.why });
      continue;
    }
    const res = execute('minimax_send_message', {
      message: policy.autoNudge.message,
      send: true,
      force: true,
    });
    actionBudget -= 1;
    const payload = safePayload(res);
    if (payload && payload.sessionId) {
      // 催话会插进当前会话，标记一下冷却时间
      if (!state.sessions[payload.sessionId]) state.sessions[payload.sessionId] = {};
      state.sessions[payload.sessionId].nudgedAt = now;
    }
    actions.push({
      tool: 'minimax_send_message',
      args: { sessionId: item.sessionId },
      why: decision.why,
      ok: res && res.isError !== true,
      verified: payload ? payload.verified : null,
    });
    emit({
      key: `auto_nudge:${item.sessionId}:${s.lastId || 0}`,
      at: new Date(now).toISOString(),
      type: 'auto_action',
      sessionId: item.sessionId,
      title: s.title || '',
      detail: `已自动催一次（${payload && payload.verified ? '已入库' : '未确认'}）`,
    });
  }

  // ---------- 4. 出错但没人管的会话 ----------
  // 错误不是"我能修的事"，但它必须出现在 needsHuman 里，
  // 否则消费方只读 needsHuman 就会漏掉"这个会话彻底跑不了"。
  for (const item of b.items) {
    if (item.kind !== 'error') continue;
    needsHuman.push({
      sessionId: item.sessionId,
      title: item.title,
      risk: 'n/a',
      why: item.why,
      next: item.next,
      handled: false,
    });
  }

  // ---------- 5. 后台任务失败 ----------
  for (const tf of b.taskFailures) {
    emit({
      key: `task_failed:${tf.sessionId}:${tf.failures}`,
      at: new Date(now).toISOString(),
      type: 'task_failed',
      sessionId: tf.sessionId,
      title: tf.description || '',
      detail: `${tf.failures} 个 ${tf.kind} 任务失败：${tf.lastError}`.slice(0, 200),
    });
  }

  // ---------- 保存状态 ----------
  const nextSessions = {};
  for (const [sid, s] of cur) {
    nextSessions[sid] = {
      status: s.status,
      lastId: s.lastId,
      lastRole: s.lastRole,
      lastMs: s.lastMs,
      pendingIds: [...pendingBySession.keys()].includes(sid)
        ? [pendingBySession.get(sid).requestId]
        : [],
      nudgedAt: (state.sessions[sid] && state.sessions[sid].nudgedAt) || null,
    };
  }
  const nextState = {
    version: 1,
    lastTick: now,
    sessions: nextSessions,
    emitted,
    lastRun: {
      at: new Date(now).toISOString(),
      idleSeconds: idle,
      events: events.length,
      actions: actions.length,
      needsHuman: needsHuman.length,
    },
  };
  saveState(nextState);
  appendEvents(events);

  const counts = events.reduce((acc, e) => {
    acc[e.type] = (acc[e.type] || 0) + 1;
    return acc;
  }, {});

  const result = {
    at: new Date(now).toISOString(),
    idleSeconds: idle,
    policy: { mode: policy.mode, riskCeiling: policy.riskCeiling, minIdleSeconds: policy.minIdleSeconds },
    dryRun,
    counts,
    events,
    actions,
    needsHuman,
    statePath: STATE_FILE,
    eventPath: EVENT_FILE,
    reportPath: REPORT_FILE,
  };
  writeReport(result, b);
  return result;
}

function safePayload(result) {
  try {
    return JSON.parse(result.content[0].text);
  } catch {
    return null;
  }
}

/** 只读：当前巡检状态（不跑新一轮）。 */
function status() {
  const st = loadState();
  const idle = idleSeconds();
  return {
    statePath: STATE_FILE,
    eventPath: EVENT_FILE,
    lastRun: st.lastRun,
    trackedSessions: Object.keys(st.sessions).length,
    idleSeconds: idle,
  };
}

/** 清掉状态（下次 tick 会重新建立基线，不产生事件）。 */
function reset() {
  try { fs.rmSync(STATE_FILE, { force: true }); } catch { /* 忽略 */ }
  return { reset: true, statePath: STATE_FILE };
}

module.exports = { tick, status, reset, readEvents, idleSeconds, snapshot, STATE_FILE, EVENT_FILE, REPORT_FILE };
