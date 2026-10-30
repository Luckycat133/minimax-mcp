'use strict';
/**
 * brief.js — 态势快照：把"现在该看什么"算出来，而不是把表倒出来。
 *
 * 设计原则（这是我自己的取舍，不是照搬任何东西）：
 *  1. **只输出要处理的**。全部会话一律平铺没有意义——人看的是"哪里卡住了"。
 *  2. **每条都带原因和下一步**。只说"有 137 个会话"等于没说；
 *     要说"这个 70 分钟没动，因为最后一条是你发的、没人回"。
 *  3. **按"要你决定 → 出错 → 卡住 → 在跑 → 刚完成"排序**，越靠前越需要人。
 *  4. **纯读数据库**，不碰 GUI。所以可以随时调用，没有副作用。
 *
 * 时间判断全部用「多久以前」而不是绝对时间——绝对时间读起来要换算，容易错。
 */

const db = require('./db');

/** 默认阈值，全部可被参数覆盖。 */
const DEFAULTS = {
  stalledMinutes: 10,   // 末条是用户消息、超过这么久没回 → 卡住
  activeMinutes: 10,    // 这么久内有动静 → 在跑
  finishedMinutes: 60,  // 这么久内跑完 → 刚完成
  limit: 200,           // 扫多少个会话
};

function minutesAgo(ms, now) {
  if (!ms) return null;
  return Math.max(0, Math.round((now - Number(ms)) / 60000));
}

function humanAge(mins) {
  if (mins === null) return '未知';
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

function oneLine(text, n = 90) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, n);
}

/**
 * 扫最近一批会话，附带最后一条消息的角色/时间/摘要。
 * 一条 SQL 拿全，避免 N+1 查询（137 个会话逐个查会很慢）。
 */
function scanSessions(limit) {
  return db.query(
    'select s.session_id, s.title, s.status, s.updated_at_ms, s.error_message, ' +
    '(select count(*) from local_runtime_message_rows m where m.session_id = s.session_id) as msgs, ' +
    "(select m.role from local_runtime_message_rows m where m.session_id = s.session_id order by m.id desc limit 1) as last_role, " +
    "(select m.created_at_ms from local_runtime_message_rows m where m.session_id = s.session_id order by m.id desc limit 1) as last_ms, " +
    "(select substr(json_extract(m.data_json,'$.msg_content'),1,200) from local_runtime_message_rows m where m.session_id = s.session_id order by m.id desc limit 1) as last_text " +
    'from local_runtime_sessions s where s.archived = 0 ' +
    'order by s.updated_at_ms desc limit ?',
    [limit]
  );
}

/** 后台任务最近的失败，按会话聚合（同一会话刷 10 条失败只算一件事）。 */
function recentTaskFailures(sinceMs, now) {
  const rows = db.query(
    "select owner_session_id, ended_at_ms, " +
    "json_extract(record_json,'$.description') as description, " +
    "json_extract(record_json,'$.kind') as kind, " +
    "json_extract(record_json,'$.lastError') as last_error " +
    "from local_runtime_background_tasks where status = 'failed' and ended_at_ms >= ? " +
    'order by ended_at_ms desc limit 80',
    [sinceMs]
  );

  const bySession = new Map();
  for (const r of rows) {
    const sid = r.owner_session_id;
    if (!bySession.has(sid)) {
      bySession.set(sid, {
        sessionId: sid,
        failures: 0,
        lastMs: Number(r.ended_at_ms),
        kind: r.kind || '',
        description: oneLine(r.description, 60),
        lastError: errorText(r.last_error),
      });
    }
    bySession.get(sid).failures += 1;
  }

  return [...bySession.values()]
    .map((x) => ({ ...x, minutesAgo: minutesAgo(x.lastMs, now), age: humanAge(minutesAgo(x.lastMs, now)) }))
    .sort((a, b) => a.minutesAgo - b.minutesAgo)
    .slice(0, 10);
}

/** lastError 有时是字符串、有时是 JSON 字符串、有时是对象，统一压成一句人话。 */
function errorText(raw) {
  if (!raw) return '';
  let val = raw;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    // sqlite3 的 json_extract 对对象会返回 JSON 字符串，得再解一层
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { val = JSON.parse(trimmed); } catch { return oneLine(trimmed, 140); }
    } else {
      return oneLine(trimmed, 140);
    }
  }
  if (val && typeof val === 'object') {
    return oneLine(val.message || val.error || val.reason || JSON.stringify(val), 140);
  }
  return oneLine(String(val), 140);
}

/**
 * 生成态势快照。
 * opts: {stalledMinutes, activeMinutes, finishedMinutes, limit, now}
 */
function brief(opts = {}) {
  // 过滤掉 undefined：否则会覆盖掉默认值，最后拼出 limit NULL 这种 SQL
  const given = Object.fromEntries(
    Object.entries(opts).filter(([, v]) => v !== undefined && v !== null)
  );
  const cfg = { ...DEFAULTS, ...given };
  const now = cfg.now || Date.now();
  const sessions = scanSessions(cfg.limit);

  // 待回答的提问按会话索引，后面挂到会话上
  const pendingBySession = new Map();
  for (const q of db.pending()) {
    pendingBySession.set(q.sessionId, q);
  }

  const items = [];

  for (const s of sessions) {
    const ageMin = minutesAgo(s.last_ms || s.updated_at_ms, now);
    const lastRole = s.last_role || null;
    const title = s.title || oneLine(s.last_text, 40) || '(无标题)';
    const base = {
      sessionId: s.session_id,
      title,
      status: s.status,
      messages: Number(s.msgs || 0),
      lastRole,
      ageMinutes: ageMin,
      age: humanAge(ageMin),
      lastText: oneLine(s.last_text, 120),
    };

    // 1) 等你决定
    const q = pendingBySession.get(s.session_id);
    if (q) {
      items.push({
        ...base,
        priority: 1,
        kind: 'needs_decision',
        why: `${q.agent || 'agent'} 在等你回答「${oneLine(q.question, 60)}」`,
        next: `minimax_draft_answer {requestId:"${q.requestId}"} 先看选项和一份建议，再决定要不要 minimax_answer_question`,
        requestId: q.requestId,
      });
      continue;
    }

    // 2) 出错
    if (s.status === 'error') {
      items.push({
        ...base,
        priority: 2,
        kind: 'error',
        why: `会话报错：${oneLine(s.error_message, 100) || '(没有错误信息)'}`,
        next: '读末条消息看上下文：minimax_read_session {session:"<ID>", limit:3}；这是应用层错误，通常要用户处理（配额/授权）',
      });
      continue;
    }

    // 3) 卡住：最后一条是用户指令，且已经很久没人回
    if (lastRole === 'user' && ageMin !== null && ageMin >= cfg.stalledMinutes) {
      items.push({
        ...base,
        priority: 3,
        kind: 'stalled',
        why: `最后一条是你的指令，${humanAge(ageMin)}没人回`,
        next: '确认是不是真的没在跑（可能是状态没落库）：minimax_read_session 看末尾，必要时 minimax_send_message 催一下',
      });
      continue;
    }

    // 4) 在跑
    if (s.status === 'started' || (ageMin !== null && ageMin < cfg.activeMinutes)) {
      items.push({
        ...base,
        priority: 4,
        kind: 'active',
        why: s.status === 'started' ? '状态是 started（这轮还没结束）' : `${humanAge(ageMin)}还有新消息`,
        next: '要收结果用 minimax_get_result；不要重复发指令，会插进正在跑的这轮',
      });
      continue;
    }

    // 5) 刚完成
    if (lastRole === 'assistant' && ageMin !== null && ageMin < cfg.finishedMinutes) {
      items.push({
        ...base,
        priority: 5,
        kind: 'finished',
        why: `${humanAge(ageMin)}刚收工`,
        next: '读结论：minimax_read_session {session:"<ID>", limit:2}',
      });
    }
    // 其余（安静的旧会话）不输出——这正是 brief 的意义
  }

  // 任务失败单独列，因为它们不改变会话状态，容易被忽略
  const taskFailures = recentTaskFailures(now - cfg.finishedMinutes * 60000 * 6, now);

  items.sort((a, b) => a.priority - b.priority || (a.ageMinutes ?? 1e9) - (b.ageMinutes ?? 1e9));

  const counts = items.reduce((acc, it) => {
    acc[it.kind] = (acc[it.kind] || 0) + 1;
    return acc;
  }, {});

  const total = sessions.length;
  const quiet = total - items.length;

  return {
    generatedAt: db.localTime(now),
    scannedSessions: total,
    quietSessions: quiet,
    counts,
    taskFailures,
    items,
    headline: buildHeadline(counts, quiet, taskFailures.length),
  };
}

/** 一句话总结，放在最前面，让人三秒知道要不要细看。 */
function buildHeadline(counts, quiet, taskFailureCount) {
  const parts = [];
  if (counts.needs_decision) parts.push(`${counts.needs_decision} 个在等你决定`);
  if (counts.error) parts.push(`${counts.error} 个报错`);
  if (counts.stalled) parts.push(`${counts.stalled} 个卡住`);
  if (counts.active) parts.push(`${counts.active} 个在跑`);
  if (counts.finished) parts.push(`${counts.finished} 个刚完成`);
  if (taskFailureCount) parts.push(`${taskFailureCount} 个会话有后台任务失败`);
  if (!parts.length) return `都很安静（${quiet} 个会话没有新动静）`;
  return parts.join(' · ') + `；其余 ${quiet} 个没动静`;
}

module.exports = { brief, scanSessions, humanAge, minutesAgo, DEFAULTS };
