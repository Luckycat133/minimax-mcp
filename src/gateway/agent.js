'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const db = require('./db');
const gui = require('./gui');
const { cdp } = require('./cdp');
const { activateDesktop, requireFront } = require('./desktop');

const CDP_UNAVAILABLE = 'MiniMax CDP 未连接。请启用 CDP 后再控制会话';
let lastControl = Promise.resolve();

function control(action) {
  const next = lastControl.then(action);
  lastControl = next.catch(() => {});
  return next;
}

function resolveTarget(sessionId) {
  if (sessionId === undefined) return null;
  const sid = db.resolveSession(sessionId);
  if (!sid) throw new Error(`找不到会话或前缀不唯一: ${sessionId}。请使用完整 sessionId`);
  return sid;
}

function recentActivity(quietSeconds) {
  if (!quietSeconds) return [];
  const now = Date.now();
  const candidates = new Map();
  for (const session of db.recentlyTouchedSessions(5)) {
    candidates.set(session.sessionId, { ...session, source: 'touched' });
  }
  for (const session of db.listSessions(10)) {
    if (!candidates.has(session.sessionId)) candidates.set(session.sessionId, { ...session, source: 'active' });
  }
  return [...candidates.values()].map((session) => ({
    sessionId: session.sessionId,
    title: session.title,
    idleSeconds: Math.round((now - session.lastActivityMs) / 1000),
    source: session.source,
  })).filter((session) => session.idleSeconds < quietSeconds);
}

function checkActivity(quietSeconds) {
  const busy = recentActivity(quietSeconds);
  if (!busy.length) return;
  const examples = busy.slice(0, 3).map((s) => `${s.title || s.sessionId}（${s.idleSeconds}s 前）`);
  throw new Error(`MiniMax 近期有会话活动，草稿和消息均未写入。确认后可用 force:true。${examples.join('、')}`);
}

function requireSuccess(result, fallback) {
  if (result?.ok !== true) throw new Error(result?.error || fallback);
  return result;
}

function checkStop(ctx) {
  if (ctx?.shouldStop?.()) throw new Error('客户端已取消操作');
}

async function waitForTarget(target) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const state = await cdp.controlContext(target.sessionId);
    if (state?.windowFocused === false) throw new Error('MiniMax 窗口已失去前台焦点，等待目标会话已停止');
    if (state?.composerReady && (target.newSession ? state.newTaskOpen : state.activeSessionId === target.sessionId)) return;
    if (attempt < 11) await delay(150);
  }
  throw new Error('MiniMax 未确认目标会话，操作已停止');
}

async function openNewTask() {
  requireFront();
  const result = requireSuccess(await cdp.newTask(), '打开新任务失败');
  await waitForTarget({ newSession: true });
  return { opened: true, via: result.via || 'cdp' };
}

async function stop({ sessionId, afterMessageId }, ctx) {
  checkStop(ctx);
  const targetId = resolveTarget(sessionId);
  requireFront();
  if (!await cdp.isAvailable()) throw new Error(CDP_UNAVAILABLE);
  const activeId = targetId || (await cdp.controlContext())?.activeSessionId;
  if (!activeId) throw new Error('没有可验证的当前会话');
  const active = db.activeTurn(activeId);
  if (afterMessageId) {
    const expected = db.turnForMessage(activeId, afterMessageId);
    if (!expected) throw new Error('afterMessageId 对应的消息不属于目标会话的原生轮次');
    if (active?.turnId !== expected.turnId) {
      throw new Error(`目标消息已不在运行（轮次状态 ${expected.status}）`);
    }
  }
  if (!active) throw new Error('目标会话没有可停止的轮次');

  const { turnId } = active;
  checkStop(ctx);
  requireFront();
  const request = await cdp.stopGeneration({ sessionId: activeId, turnId }).catch(() => null);
  if (request?.error) throw new Error(request.error);
  let receipt;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try { receipt = db.turnOutcome(activeId, turnId); } catch { /* Try again before declaring an uncertain outcome. */ }
    if (receipt?.completedAtMs != null || request?.ok === false || ctx?.shouldStop?.()) break;
    if (attempt < 11) await delay(200);
  }
  const turnStatus = receipt?.status || 'unknown';
  const terminal = receipt?.completedAtMs != null;
  const verified = turnStatus === 'aborted' && terminal;
  const stopped = verified ? true : (terminal || request?.ok === false ? false : null);
  const note = terminal ? `原轮次已结束，状态为 ${turnStatus}`
    : request?.ok === false ? `停止请求返回 HTTP ${request.status}`
      : ctx?.shouldStop?.() ? '客户端已取消等待，请用 result 核对该轮状态'
        : request ? '未确认原轮次已停止' : '未收到停止接口回执，请用 result 核对该轮状态';
  return {
    stopped, verified, sessionId: activeId, turnId, turnStatus, via: 'cdp-runtime',
    ...(!verified ? { note } : {}),
  };
}

async function confirmSend({ before, message, sessionId, newSession, via, inputAt }) {
  const hit = await db.waitForUserMessage(before, message, { sessionId, newSession }).catch(() => ({ ok: false }));
  if (hit.ok) return { sent: true, verified: true, sessionId: hit.sessionId, messageId: hit.messageId, via, ...(inputAt ? { inputAt } : {}) };
  return {
    sent: null, verified: false, sessionId, afterMessageId: before, via,
    note: '提交后未确认入库。请检查会话记录再决定是否重试',
  };
}

async function verifyGuiSession(expectedId = null) {
  const context = await cdp.controlContext(expectedId).catch(() => null);
  if (!context?.windowFocused || !context.composerReady || context.newTaskOpen || !context.activeSessionId) {
    throw new Error('无法确认 MiniMax 窗口焦点或当前会话的输入框。请在 MiniMax 打开目标会话后重试');
  }
  if (expectedId && context.activeSessionId !== expectedId) {
    throw new Error('MiniMax 当前会话已切换，已取消坐标写入');
  }
  requireFront();
  return context.activeSessionId;
}

// Legacy coordinates still need a verified session for typing and delivery receipts.
async function sendViaGui(args, at, ctx) {
  if (!await cdp.isAvailable()) throw new Error(CDP_UNAVAILABLE);
  const sessionId = await verifyGuiSession();
  const coords = gui.inputCoords(gui.mainWindow(), at, 'chat');
  if (!coords || gui.topmostAt(coords.x, coords.y)?.app !== gui.APP) {
    throw new Error('无法确认 MiniMax 输入框坐标');
  }
  gui.click(coords.x, coords.y);
  gui.sleep(300);
  await verifyGuiSession(sessionId);
  checkStop(ctx);
  gui.clipboard(args.message);
  gui.pressKey('v', ['cmd']);
  if (!args.send) return { sent: false, sessionId, inputAt: coords, via: 'gui' };

  gui.sleep(500);
  const before = db.maxMessageId();
  await verifyGuiSession(sessionId);
  checkStop(ctx);
  try { gui.pressKey('return'); } catch { /* 发送结果不确定，仍查库 */ }
  return confirmSend({ before, message: args.message, sessionId, via: 'gui', inputAt: coords });
}

async function send(args, ctx) {
  const { message, newSession, force, preview, quietSeconds = 300 } = args;
  if (!message?.trim()) throw new Error('send 需要非空 message');
  if (newSession && args.sessionId !== undefined) throw new Error('newSession 和 sessionId 互斥');
  const sessionId = resolveTarget(args.sessionId);
  const coords = args.at?.match(/^\s*(\d+)\s*,\s*(\d+)\s*$/);
  if (args.at !== undefined && !coords) throw new Error('at 坐标须采用 "x,y" 格式');
  const at = coords ? `${coords[1]},${coords[2]}` : null;
  if (at && (sessionId || newSession)) throw new Error('目标会话发送不能使用 at');
  if (preview) {
    const online = await cdp.isAvailable();
    const target = online ? await cdp.controlContext(sessionId).catch(() => null) : null;
    const busy = recentActivity(quietSeconds);
    const via = at ? 'gui' : online ? 'cdp' : 'unavailable';
    const inputAt = at ? gui.inputCoords(null, at) : undefined;
    return {
      preview: true, wouldSend: args.send === true, via, newSession, inputAt,
      ...target,
      targetSessionId: newSession ? null : sessionId || target?.activeSessionId || null,
      busySessions: busy.slice(0, 3),
      guard: { busy: busy.length > 0, quietSeconds, wouldBlock: busy.length > 0 && !force },
    };
  }

  return control(async () => {
    checkStop(ctx);
    if (!force) checkActivity(quietSeconds);
    requireFront();
    if (at) return sendViaGui(args, at, ctx);
    if (!await cdp.isAvailable()) throw new Error(CDP_UNAVAILABLE);

    if (newSession) await openNewTask();
    if (sessionId) {
      requireFront();
      requireSuccess(await cdp.switchSession(sessionId), '切换会话失败');
      await waitForTarget({ sessionId });
    }
    const current = await cdp.controlContext(sessionId);
    const target = { sessionId: sessionId || (!newSession ? current?.activeSessionId : null) || null, newSession: newSession || current?.newTaskOpen === true };
    if (!target.sessionId && !target.newSession) throw new Error('无法确认当前会话或新任务页');
    if (target.sessionId && target.newSession) throw new Error('当前会话已切换到新任务页');
    checkStop(ctx);
    requireFront();
    requireSuccess(await cdp.typeMessage(message, target), 'MiniMax 未确认草稿内容');
    if (!args.send) return { sent: false, sessionId: target.sessionId, via: 'cdp', note: '草稿已填入，send:true 才会提交' };

    if (ctx?.shouldStop?.()) throw new Error('客户端已取消发送，草稿已填入');
    requireFront();
    const before = db.maxMessageId();
    const submission = await cdp.sendMessage(message, target).catch(() => null);
    if (submission?.ok === false) throw new Error(submission.error);
    return confirmSend({ before, message, ...target, via: 'cdp' });
  });
}

module.exports = {
  control,
  send,
  activate: (ctx) => control(() => {
    checkStop(ctx);
    return activateDesktop();
  }),
  stop: (args, ctx) => control(() => stop(args, ctx)),
  newTask: (ctx) => control(() => {
    checkStop(ctx);
    return openNewTask();
  }),
};
