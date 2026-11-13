'use strict';

/**
 * handler.js — MCP 请求分发与执行引擎（多层触发 Tiered Action 规范版）。
 *
 * 核心架构：
 * 1. 采用渐进式披露的多层分发机制（minimax_session, minimax_agent, minimax_bot, minimax_questionnaire, minimax_desktop）。
 * 2. 界面操作全由底层代码在 CDP / DOM / SQLite 层面自动闭环执行，外部 Agent 零物理坐标接触。
 * 3. 完整保留对遗留单动作工具名的向下透明兼容。
 */

const path = require('path');
const fs = require('fs');
const db = require('../gateway/db');
const gui = require('../gateway/gui');
const ocr = require('../gateway/ocr');
const { cdp } = require('../gateway/cdp');
const qn = require('./questionnaire');
const brief = require('../gateway/brief');
const audit = require('../gateway/audit');
const ann = require('./annotations');
const { validateArgs } = require('./validate');
const { ALL_TOOLS } = require('./tools');
const watch = require('../gateway/watch');
const tasks = require('./tasks');

/** 客户端是否协商了 Tasks 扩展。由 stdio-server 在 initialize 时设置。 */
let tasksEnabled = false;
function setTasksEnabled(v) { tasksEnabled = v === true; }

const READONLY = new Set([
  'minimax_brief', 'minimax_status', 'minimax_session', 'minimax_events', 'minimax_tasks',
  // 兼容别名
  'minimax_list_sessions', 'minimax_read_session', 'minimax_tail_sessions', 'minimax_search',
  'minimax_pending', 'minimax_draft_answer', 'minimax_windows', 'minimax_get_result', 'minimax_bot_roster',
]);

function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: false };
}

function fail(message) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

/**
 * 守卫用的候选会话：合并两个信号——
 *  1. local_runtime_sessions.updated_at_ms 最新的几个（打开/切会话会刷新，最接近"正在看"）
 *  2. 消息活跃度最高的几个（正在跑的会话）
 * 两个信号的并集里，只要有会话在 quietSeconds 内动过就认为"用户正在对话中"。
 * 宁可拦错，不可误发。
 */
function guardCandidates() {
  const seen = new Map();
  for (const s of db.recentlyTouchedSessions(5)) {
    seen.set(s.sessionId, { ...s, source: 'touched' });
  }
  for (const s of db.listSessions(10)) {
    if (!seen.has(s.sessionId)) {
      seen.set(s.sessionId, { ...s, source: 'active' });
    }
  }
  return Array.from(seen.values());
}

/**
 * 点某个坐标前，先看该坐标有没有被 MiniMax 之外的"在屏窗口"盖住。
 */
function blockedByOverlay(targetX, targetY) {
  const onScreen = gui.appWindows();
  for (const w of onScreen) {
    if (w.app === gui.APP) continue;
    if (targetX >= w.x && targetX <= w.x + w.width &&
        targetY >= w.y && targetY <= w.y + w.height) {
      return w;
    }
  }
  return null;
}

function parseAt(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/^\s*(\d+)\s*,\s*(\d+)\s*$/);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]), text: `${m[1]},${m[2]}` };
}

async function dispatch(name, args = {}, ctx = null) {
  try {
    switch (name) {
      // ---------- 1. 态势与巡检 ----------
      case 'minimax_brief':
        return ok(brief.brief({
          stalledMinutes: args.stalledMinutes,
          activeMinutes: args.activeMinutes,
          finishedMinutes: args.finishedMinutes,
          limit: args.limit,
        }));

      case 'minimax_status': {
        const s = db.status();
        const pid = gui.minimaxPid();
        s.app = {
          running: Boolean(pid),
          pid: pid || null,
        };
        const cdpUp = await cdp.isAvailable();
        s.cdp = {
          online: cdpUp,
          port: cdp.port,
        };
        if (cdpUp) {
          try {
            s.quota = await cdp.getQuotaStatus();
          } catch (_) {}
        } else if (s.app.running) {
          s.cdp.hint = 'MiniMax 正在运行但未开启 CDP 调试端口 (9223)。可调用 activate 挂载调试端口。';
        } else {
          s.cdp.hint = 'MiniMax Code 尚未运行。发送指令时会自动启动。';
        }

        if (args.includeBrief !== false) {
          try {
            const pending = db.pending();
            const br = brief.brief({ limit: 20 });
            s.attention = {
              headline: br.headline,
              pendingQuestions: pending.length,
              stalledSessions: (br.items || []).filter((it) => it.kind === 'stalled').length,
            };
          } catch (_) {}
        }
        return ok(s);
      }

      case 'minimax_watch': {
        const action = args.action || 'tick';
        if (action === 'status') return ok(watch.status());
        if (action === 'reset') return ok(watch.reset());
        if (action === 'config') {
          const saved = args.policy ? watch.savePolicy(args.policy) : watch.loadPolicy();
          return ok({
            policyPath: watch.POLICY_FILE,
            saved: Boolean(args.policy),
            policy: watch.effectivePolicy(),
            file: saved,
          });
        }
        const r = await watch.tick({
          policy: args.policy,
          dryRun: args.dryRun === true,
          stalledMinutes: args.stalledMinutes,
          finishedMinutes: args.finishedMinutes,
          execute: (tool, toolArgs) => callTool(tool, toolArgs, ctx),
        });
        return ok(r);
      }

      case 'minimax_events': {
        const r = watch.readEvents(args.since, args.limit ?? 50);
        return ok(r);
      }

      case 'minimax_tasks':
        return ok({ tasks: db.tasks(args.limit ?? 20, args.status ?? null) });

      case 'minimax_auto_resume': {
        const { autoResume } = require('../gateway/resume');
        const dryRun = args.dryRun !== false;
        const limit = args.limit || 5;
        const res = await autoResume({ dryRun, limit, sessionId: args.sessionId });
        return ok(res);
      }

      // ---------- 2. 原生会话统一管理 (minimax_session) ----------
      case 'minimax_session': {
        const action = args.action || 'list';
        if (action === 'list') {
          return ok({ sessions: db.listSessions(args.limit ?? 20) });
        }
        if (action === 'read') {
          const target = args.session || args.sessionId;
          if (!target) return fail('action=read 时缺少参数 session 或 sessionId');
          const r = db.readSession(target, args.limit ?? 30, args.includeThinking === true, args.before ?? null);
          return r.error ? fail(r.error) : ok(r);
        }
        if (action === 'tail') {
          return ok({ sessions: db.tailSessions(args.count ?? 3, args.perSession ?? 2) });
        }
        if (action === 'search') {
          const query = args.query || args.q;
          if (!query) return fail('action=search 时 query 不能为空');
          return ok({ hits: db.search(query, args.limit ?? 20, true) });
        }
        return fail(`未知会话操作类型: ${action}`);
      }

      // ---------- 3. 原生通用智能体调度 (minimax_agent) ----------
      case 'minimax_agent': {
        const action = args.action || 'send';

        if (action === 'new') {
          if (await cdp.isAvailable()) {
            try {
              const r = await cdp.newTask();
              return ok({ opened: true, via: r.via || 'cdp', note: '已通过 CDP 快速切换至新建任务页' });
            } catch (_) {}
          }
          if (!gui.ensureFront()) return fail('MiniMax 不是活跃应用，已放弃操作');
          gui.pressKey('n', ['cmd']);
          gui.sleep(1200);
          return ok({ opened: true, via: 'gui-cmd-n', note: '已发送 ⌘N 新建任务快捷键' });
        }

        if (action === 'stop') {
          if (await cdp.isAvailable()) {
            try {
              const r = await cdp.evaluate(`
                (() => {
                  const stopBtn = document.querySelector("[data-testid*='stop'], button[aria-label*='停止'], .stop-button");
                  if (stopBtn && !stopBtn.disabled) {
                    stopBtn.click();
                    return { ok: true, via: 'cdp-button' };
                  }
                  return { ok: false };
                })()
              `);
              if (r && r.ok) return ok({ stopped: true, via: 'cdp-stop-button' });
            } catch (_) {}
          }
          if (!gui.ensureFront()) return fail('MiniMax 不是活跃应用，已放弃操作');
          gui.pressKey('escape');
          return ok({ stopped: true, via: 'escape' });
        }

        if (action === 'result') {
          let sid = null;
          let fallback = false;
          if (args.sessionId || args.session) {
            sid = db.resolveSession(args.sessionId || args.session);
            if (!sid) return fail(`找不到会话: ${args.sessionId || args.session}`);
          } else {
            const recent = db.recentlyTouchedSessions(1)[0] || db.listSessions(1)[0];
            if (!recent) return fail('找不到会话');
            sid = recent.sessionId;
            fallback = true;
          }
          const after = Number(args.afterMessageId || 0);
          const timeout = args.timeoutSeconds !== undefined ? Number(args.timeoutSeconds) : 0;
          const out = await db.waitForResult(sid, after, timeout, 3000, ctx && ctx.shouldStop);
          if (fallback) out.note = '没指定 sessionId，用的是最近活跃会话；要精确请显式传 sessionId';
          return ok(out);
        }

        if (action === 'send') {
          const messageText = args.message || args.text || args.content;
          if (!messageText) return fail('action=send 时 message 不能为空');

          const quietSeconds = args.quietSeconds === undefined ? 300 : Number(args.quietSeconds);
          const force = args.force === true;
          let atParsed = null;
          if (args.at !== undefined && args.at !== null) {
            atParsed = parseAt(args.at);
            if (!atParsed) return fail(`at 坐标格式不正确: "${args.at}"，期望 "x,y" 格式如 "640,880"`);
          }

          // 目标会话切换（若显式指定 sessionId 或 newSession）
          const targetSid = (args.sessionId || args.session) ? db.resolveSession(args.sessionId || args.session) : null;
          if (await cdp.isAvailable()) {
            if (targetSid) {
              await cdp.switchSession(targetSid);
            } else if (args.newSession === true) {
              await cdp.newTask();
            }
          }

          // 预览模式：只报告会发生什么，不点、不粘、不发。只读，所以不受守卫限制。
          if (args.preview === true) {
            const busy = guardCandidates()
              .map((s) => ({ ...s, idleSeconds: Math.round((Date.now() - s.lastActivityMs) / 1000) }))
              .filter((s) => s.idleSeconds < quietSeconds);

            const win = gui.mainWindow();
            const coords = gui.inputCoords(win, atParsed ? atParsed.text : null, 'chat');

            return ok({
              preview: true,
              wouldSend: args.send === true,
              via: await cdp.isAvailable() ? 'cdp' : 'gui',
              inputAt: coords || { via: 'cdp' },
              targetSessionId: targetSid,
              newSession: args.newSession === true,
              overlay: coords ? blockedByOverlay(coords.x, coords.y) : null,
              activeApp: gui.activeApp(),
              busySessions: busy.map((s) => ({ sessionId: s.sessionId, title: s.title, idleSeconds: s.idleSeconds, source: s.source })),
              guard: { busy: busy.length > 0, quietSeconds },
            });
          }

          const win = gui.mainWindow();
          const coords = gui.inputCoords(win, atParsed ? atParsed.text : null, 'chat');
          if (!coords && !await cdp.isAvailable()) return fail('拿不到 MiniMax 窗口位置且 CDP 未就绪');

          // 守卫：候选会话里有刚动过的就不发，除非显式 force。
          const busy = guardCandidates()
            .map((s) => ({ ...s, idleSeconds: Math.round((Date.now() - s.lastActivityMs) / 1000) }))
            .filter((s) => s.idleSeconds < quietSeconds);
          if (busy.length > 0 && !force) {
            const list = busy.map((s) => `${s.sessionId}${s.title ? `（${s.title}）` : ''} ${s.idleSeconds}s 前`).join('；');
            return fail(
              `有会话刚还在活动，看起来你正在对话中，已拒绝发送以免打扰：${list}。` +
              `确认要发就加 force: true；或者调大 quietSeconds（当前 ${quietSeconds}）。`
            );
          }

          // 1. 优先走 CDP 零权限高速通道
          if (!atParsed && await cdp.isAvailable()) {
            try {
              await cdp.typeMessage(messageText);
              if (args.send !== true) {
                return ok({ sent: false, note: '已通过 CDP 注入未发送；send=true 才会发送', via: 'cdp', sessionId: targetSid });
              }
              const before = db.maxMessageId();
              await cdp.sendMessage();
              const hit = db.waitForUserMessage(before, messageText);
              if (hit.ok) {
                const payload = { sent: true, verified: true, sessionId: hit.sessionId, messageId: hit.messageId, via: 'cdp' };
                if (tasksEnabled) {
                  const t = tasks.create({
                    sessionId: hit.sessionId,
                    afterMessageId: hit.messageId,
                    messagePreview: String(messageText).slice(0, 80),
                  });
                  payload.taskId = t.taskId;
                  payload.note = '已创建任务；用 tasks/get 看状态、tasks/result 取结果，完成时会收到 notifications/tasks/status';
                }
                return ok(payload);
              }
            } catch (_) {}
          }

          // 2. 降级走 GUI 模拟
          if (!gui.ensureFront()) return fail('MiniMax 不是活跃应用，已放弃操作');
          gui.click(coords.x, coords.y);
          gui.sleep(300);
          gui.clipboard(messageText);
          gui.sleep(100);
          gui.pressKey('v', ['cmd']);
          gui.sleep(500);
          if (args.send !== true) {
            return ok({ sent: false, note: '已粘贴未发送；send=true 才会发送', inputAt: coords });
          }
          const before = db.maxMessageId();
          gui.pressKey('return');
          const hit = db.waitForUserMessage(before, messageText);
          return ok({ sent: true, verified: hit.ok, sessionId: hit.sessionId, messageId: hit.messageId, inputAt: coords });
        }

        return fail(`未知智能体动作: ${action}`);
      }

      // ---------- 4. MiniMax Bot 团队协同 (minimax_bot) ----------
      case 'minimax_bot': {
        const { botClient } = require('../gateway/bot');
        const action = args.action || (args.text ? 'send' : (args.target ? 'read' : 'roster'));

        if (action === 'roster') {
          return ok(botClient.getRoster());
        }

        const targetArg = args.target || args.chatId;
        const resolved = botClient.resolveTarget(targetArg, args.mode || 'direct');

        if (action === 'read') {
          const res = await botClient.listMessages(resolved.chatId, args.limit || 20);
          return ok({ target: resolved, ...res });
        }
        if (action === 'send') {
          if (!args.text) return fail('action=send 时 text 不能为空');
          const sendText = resolved.prefix ? `${resolved.prefix}${args.text}` : args.text;
          const res = await botClient.sendMessage(resolved.chatId, sendText);
          return ok({ target: resolved, text: sendText, ...res });
        }
        if (action === 'cancel') {
          const res = await botClient.cancelTurn(resolved.chatId);
          return ok({ target: resolved, action, ...res });
        }
        if (action === 'resume') {
          const res = await botClient.resumePending(resolved.chatId);
          return ok({ target: resolved, action, ...res });
        }
        if (action === 'answer') {
          if (!args.messageId || !args.answers) {
            return fail('action=answer 时 messageId 和 answers 均不能为空');
          }
          const res = await botClient.answerQuestion(resolved.chatId, args.messageId, args.answers);
          return ok({ target: resolved, action, ...res });
        }

        return fail(`未知 Bot 操作类型: ${action}`);
      }

      // ---------- 5. 人工问卷与卡片管理 (minimax_questionnaire) ----------
      case 'minimax_questionnaire': {
        const action = args.action || (args.selections || args.force !== undefined ? 'answer' : (args.requestId || args.id ? 'draft' : 'list'));

        if (action === 'list') {
          return ok({ pending: db.pending() });
        }

        const reqId = args.requestId || args.id;
        if (!reqId) return fail('action=draft 或 answer 时缺少 requestId');

        const detail = db.questionnaireDetail(reqId);
        if (!detail) return fail(`找不到提问: ${reqId}`);

        if (action === 'draft') {
          if (detail.status !== 'pending') {
            return ok({
              requestId: detail.requestId,
              status: detail.status,
              note: `这条提问已经是 ${detail.status}，不用再答`,
              answered: detail.answered,
            });
          }
          const suggestion = db.suggestAnswer(detail);
          return ok({
            requestId: detail.requestId,
            sessionId: detail.sessionId,
            title: detail.title,
            steps: detail.steps,
            suggestion,
            note: '以上是草稿。要提交用 action="answer"，默认也只 preview。',
          });
        }

        if (action === 'answer') {
          if (detail.status !== 'pending') return fail(`这条提问已经是 ${detail.status}，不能再答`);
          const suggestion = db.suggestAnswer(detail);
          const raw = Array.isArray(args.selections) && args.selections.length
            ? args.selections
            : qn.fromSuggestion(suggestion);
          const { answers, errors } = qn.normalizeSelections(detail, raw);
          if (errors.length) return fail(`答案有问题，未提交：\n- ${errors.join('\n- ')}`);
          if (!answers.length) return fail('这条提问解析不出任何可答的步骤，拒绝提交空答案。');

          const payload = qn.buildReplyPayload(detail, answers);
          const plan = qn.clickPlan(detail, answers);

          if (args.preview !== false) {
            return ok({
              preview: true,
              requestId: detail.requestId,
              sessionId: detail.sessionId,
              title: detail.title,
              wouldSubmit: payload,
              clickPlan: plan,
              steps: detail.steps,
              note: 'preview 模式未实际提交。确认提交加 preview:false, force:true。',
            });
          }

          if (args.force !== true) return fail('这是在替用户做决定。确认要提交就显式加 force:true');
          if (!gui.ensureFront()) return fail('MiniMax 不是活跃应用，已放弃操作');
          const win = gui.mainWindow();
          if (!win) return fail('找不到 MiniMax 窗口');
          const region = { x: win.x, y: win.y, width: win.width, height: win.height };

          const clicked = [];
          for (const step of plan) {
            const hit = ocr.find(step.anchor, { region, refresh: true, mode: 'contains' })?.picked;
            if (hit) {
              gui.click(hit.cx, hit.cy);
              clicked.push({ stepId: step.stepId, at: [hit.cx, hit.cy] });
              gui.sleep(500);
            }
          }

          const submitHit = ocr.find('确定', { region, refresh: true, mode: 'exact' })?.picked
            || ocr.find('提交', { region, refresh: true, mode: 'exact' })?.picked;
          if (submitHit) {
            gui.click(submitHit.cx, submitHit.cy);
            gui.sleep(1000);
          }

          const after = db.questionnaireDetail(detail.requestId);
          return ok({
            submitted: true,
            verified: Boolean(after && after.status !== 'pending'),
            status: after?.status || 'unknown',
            clicked,
          });
        }

        return fail(`未知问卷操作: ${action}`);
      }

      // ---------- 6. 桌面环境与窗口控制 (minimax_desktop) ----------
      case 'minimax_desktop': {
        const action = args.action || (args.mode || args.width ? 'screenshot' : (args.windows ? 'windows' : 'activate'));

        if (action === 'windows') {
          const onScreen = gui.appWindows();
          const all = gui.windowsAll().filter((w) => w.app === gui.APP);
          const hidden = all.filter((w) => !onScreen.some((o) => o.pid === w.pid && o.x === w.x));
          return ok({
            onScreenCount: onScreen.length,
            windows: onScreen,
            hiddenOrOtherSpace: hidden.map((w) => ({ pid: w.pid, x: w.x, y: w.y, width: w.width, height: w.height, title: w.title })),
          });
        }

        if (action === 'screenshot') {
          const region = args.mode === 'region'
            ? { x: args.x, y: args.y, width: args.width, height: args.height }
            : null;
          if (args.mode === 'region' && (!region || [region.x, region.y, region.width, region.height].some((v) => typeof v !== 'number'))) {
            return fail('mode=region 需要同时提供 x/y/width/height');
          }

          if (await cdp.isAvailable() && args.mode !== 'region') {
            try {
              const outDir = path.join(__dirname, '..', '..', 'scripts', 'screenshots');
              fs.mkdirSync(outDir, { recursive: true });
              const safe = String(args.name || 'minimax').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'minimax';
              const targetPath = path.join(outDir, `${safe}_${Date.now()}.png`);
              const res = await cdp.captureScreenshot(targetPath);
              if (res && res.path) {
                return ok({ path: res.path, bytes: res.bytes, via: 'cdp' });
              }
            } catch (_) {}
          }
          return ok(gui.screenshot(args.name || 'minimax', args.mode || 'screen', region));
        }

        if (action === 'activate') {
          if (args.relaunchWithDebug) {
            const { launchWithDebug } = require(path.join(__dirname, '..', '..', 'scripts', 'launch-with-debug'));
            const r = await launchWithDebug();
            if (!r.ok) return fail(`挂载调试端口重启失败: ${r.error}`);
            return ok({ relaunchWithDebug: true, cdp: r, window: gui.mainWindow() });
          }
          if (await cdp.isAvailable()) {
            try {
              const r = await cdp.bringToFront();
              if (r && r.ok) return ok({ via: 'cdp', note: '已通过 CDP 将 MiniMax 唤醒至前台' });
            } catch (_) {}
          }
          gui.openApp();
          return ok({ via: 'gui-open', window: gui.mainWindow() });
        }

        return fail(`未知桌面操作: ${action}`);
      }

      // ---------- 7. 遗留别名透明映射 (Backward Compatibility) ----------
      case 'minimax_list_sessions':
        return await dispatch('minimax_session', { action: 'list', ...args }, ctx);
      case 'minimax_read_session':
        return await dispatch('minimax_session', { action: 'read', ...args }, ctx);
      case 'minimax_tail_sessions':
        return await dispatch('minimax_session', { action: 'tail', ...args }, ctx);
      case 'minimax_search':
        return await dispatch('minimax_session', { action: 'search', ...args }, ctx);
      case 'minimax_send_message':
        return await dispatch('minimax_agent', { action: 'send', ...args }, ctx);
      case 'minimax_get_result':
        return await dispatch('minimax_agent', { action: 'result', ...args }, ctx);
      case 'minimax_stop_generation':
        return await dispatch('minimax_agent', { action: 'stop', ...args }, ctx);
      case 'minimax_new_task':
        return await dispatch('minimax_agent', { action: 'new', ...args }, ctx);
      case 'minimax_bot_roster':
        return await dispatch('minimax_bot', { action: 'roster', ...args }, ctx);
      case 'minimax_bot_message':
        return await dispatch('minimax_bot', { action: args.action || (args.text ? 'send' : 'read'), ...args }, ctx);
      case 'minimax_bot_turn':
        return await dispatch('minimax_bot', args, ctx);
      case 'minimax_pending':
        return await dispatch('minimax_questionnaire', { action: 'list', ...args }, ctx);
      case 'minimax_draft_answer':
        return await dispatch('minimax_questionnaire', { action: 'draft', ...args }, ctx);
      case 'minimax_answer_question':
        return await dispatch('minimax_questionnaire', { action: 'answer', ...args }, ctx);
      case 'minimax_activate':
        return await dispatch('minimax_desktop', { action: 'activate', ...args }, ctx);
      case 'minimax_screenshot':
        return await dispatch('minimax_desktop', { action: 'screenshot', ...args }, ctx);
      case 'minimax_windows':
        return await dispatch('minimax_desktop', { action: 'windows', ...args }, ctx);

      default:
        return fail(`未知工具: ${name}`);
    }
  } catch (err) {
    return fail(`${err && err.message ? err.message : String(err)}`);
  }
}

const LEGACY_MAP = {
  minimax_list_sessions: (a) => ({ name: 'minimax_session', args: { action: 'list', ...a } }),
  minimax_read_session: (a) => ({ name: 'minimax_session', args: { action: 'read', ...a } }),
  minimax_tail_sessions: (a) => ({ name: 'minimax_session', args: { action: 'tail', ...a } }),
  minimax_search: (a) => ({ name: 'minimax_session', args: { action: 'search', ...a } }),
  minimax_send_message: (a) => ({ name: 'minimax_agent', args: { action: 'send', ...a } }),
  minimax_get_result: (a) => ({ name: 'minimax_agent', args: { action: 'result', ...a } }),
  minimax_stop_generation: (a) => ({ name: 'minimax_agent', args: { action: 'stop', ...a } }),
  minimax_new_task: (a) => ({ name: 'minimax_agent', args: { action: 'new', ...a } }),
  minimax_bot_roster: (a) => ({ name: 'minimax_bot', args: { action: 'roster', ...a } }),
  minimax_bot_message: (a) => ({ name: 'minimax_bot', args: { action: a.action || (a.text ? 'send' : 'read'), ...a } }),
  minimax_bot_turn: (a) => ({ name: 'minimax_bot', args: a }),
  minimax_pending: (a) => ({ name: 'minimax_questionnaire', args: { action: 'list', ...a } }),
  minimax_draft_answer: (a) => ({ name: 'minimax_questionnaire', args: { action: 'draft', ...a } }),
  minimax_answer_question: (a) => ({ name: 'minimax_questionnaire', args: { action: 'answer', ...a } }),
  minimax_activate: (a) => ({ name: 'minimax_desktop', args: { action: 'activate', ...a } }),
  minimax_screenshot: (a) => ({ name: 'minimax_desktop', args: { action: 'screenshot', ...a } }),
  minimax_windows: (a) => ({ name: 'minimax_desktop', args: { action: 'windows', ...a } }),
};

/**
 * 对外入口：参数归一化、Schema 校验、分发与审计。
 */
async function callTool(name, args = {}, ctx = null) {
  const started = Date.now();
  const callerName = name;

  if (LEGACY_MAP[name]) {
    const mapped = LEGACY_MAP[name](args);
    name = mapped.name;
    args = mapped.args;
  }

  // 入参别名按工具精准归一化
  if (args && typeof args === 'object') {
    if (name === 'minimax_session') {
      if (args.sessionId && !args.session) args.session = args.sessionId;
      if (args.q && !args.query) args.query = args.q;
      if (!args.action) {
        if (args.session || args.sessionId) args.action = 'read';
        else if (args.query || args.q) args.action = 'search';
        else if (args.count || args.perSession) args.action = 'tail';
        else args.action = 'list';
      }
    } else if (name === 'minimax_agent') {
      if (args.text && !args.message) args.message = args.text;
      if (args.content && !args.message) args.message = args.content;
      if (args.session && !args.sessionId) args.sessionId = args.session;
      if (!args.action) {
        if (args.message || args.text || args.content) args.action = 'send';
        else if (args.afterMessageId || args.timeoutSeconds !== undefined) args.action = 'result';
        else args.action = 'send';
      }
    } else if (name === 'minimax_bot') {
      if (args.chatId && !args.target) args.target = args.chatId;
      if (args.target && !args.chatId) args.chatId = args.target;
      if (!args.action) {
        if (args.text) args.action = 'send';
        else if (args.target) args.action = 'read';
        else args.action = 'roster';
      }
    } else if (name === 'minimax_questionnaire') {
      if (args.id && !args.requestId) args.requestId = args.id;
      if (!args.action) {
        if (args.selections || args.force !== undefined) args.action = 'answer';
        else if (args.requestId || args.id) args.action = 'draft';
        else args.action = 'list';
      }
    } else if (name === 'minimax_desktop') {
      if (!args.action) {
        if (args.mode || args.width) args.action = 'screenshot';
        else if (args.relaunchWithDebug !== undefined) args.action = 'activate';
        else args.action = 'activate';
      }
    }
  }

  // 工具 Schema 校验
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (tool) {
    const v = validateArgs(tool, args);
    if (!v.ok) {
      return fail(`参数不合法，未执行：\n- ${v.errors.join('\n- ')}`);
    }
    args = v.args;
  }

  let result;
  try {
    result = await dispatch(name, args, ctx);
  } catch (err) {
    const auditTool = ann.needsAudit(callerName) ? callerName : name;
    if (ann.needsAudit(auditTool)) {
      audit.record({
        tool: auditTool,
        level: ann.levelOf(auditTool),
        args,
        ok: false,
        ms: Date.now() - started,
        error: err && err.message ? err.message : String(err),
      });
    }
    throw err;
  }
  const auditTool = ann.needsAudit(callerName) ? callerName : name;
  if (ann.needsAudit(auditTool)) {
    const payload = parsePayload(result);
    audit.record({
      tool: auditTool,
      level: ann.levelOf(auditTool),
      args,
      ok: result && result.isError !== true,
      ms: Date.now() - started,
      target: payload && (payload.at || payload.clicked || payload.sessionId)
        ? { at: payload.at, clicked: payload.clicked, sessionId: payload.sessionId }
        : undefined,
      error: result && result.isError === true ? (payload && payload.error) : undefined,
    });
  }
  return result;
  return result;
}

function parsePayload(result) {
  try {
    return JSON.parse(result.content[0].text);
  } catch {
    return null;
  }
}

module.exports = { callTool, READONLY, setTasksEnabled };
