'use strict';

/**
 * handler.js — 工具分发。所有控制类工具先做前台校验，不在前台就直接返回错误，
 * 不硬来，避免点到用户正在用的窗口。
 */

const db = require('../gateway/db');
const gui = require('../gateway/gui');
const ocr = require('../gateway/ocr');
const { cdp } = require('../gateway/cdp');
const qn = require('./questionnaire');
const brief = require('../gateway/brief');
const audit = require('../gateway/audit');
const ann = require('./annotations');
const { validateArgs } = require('./validate');
const { TOOLS } = require('./tools');
const watch = require('../gateway/watch');
const tasks = require('./tasks');

/** 客户端是否协商了 Tasks 扩展。由 stdio-server 在 initialize 时设置。 */
let tasksEnabled = false;
function setTasksEnabled(v) { tasksEnabled = v === true; }

const READONLY = new Set([
  'minimax_brief', 'minimax_status', 'minimax_list_sessions', 'minimax_read_session',
  'minimax_tail_sessions', 'minimax_search', 'minimax_pending', 'minimax_draft_answer',
  'minimax_tasks', 'minimax_windows', 'minimax_find_text', 'minimax_get_result',
  'minimax_events',
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
  for (const s of db.recentlyTouchedSessions(3)) {
    seen.set(s.sessionId, { ...s, source: 'touched' });
  }
  for (const s of db.listSessions(3)) {
    if (!seen.has(s.sessionId)) {
      seen.set(s.sessionId, { sessionId: s.sessionId, title: s.firstUserMessage || '', status: null, lastActivityMs: s.lastActivityMs, source: 'messages' });
    }
  }
  return [...seen.values()];
}

/** 点击前的命中测试：那个点上盖着别的 App 就不能点。 */
function blockedByOverlay(x, y) {
  const hit = gui.topmostAt(x, y);
  if (!hit) return null;
  if (hit.app === gui.APP) return null;
  return hit;
}

/**
 * 解析 "x,y"。格式不对就抛错。
 *
 * 为什么必须挡：`"abc".split(',')` 得到 [NaN]，NaN 一路传到点击就是"点了但什么也没发生"，
 * 调用方还以为是界面没响应。这类静默失败比报错难查得多。
 */
function parseAt(at) {
  const parts = String(at).split(',').map((v) => Number(v.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`at 坐标格式不对：${JSON.stringify(at)}；应该像 "640,880"`);
  }
  const [x, y] = parts;
  if (x < 0 || y < 0) throw new Error(`at 坐标不能是负数：${x},${y}`);
  if (x > 20000 || y > 20000) throw new Error(`at 坐标看起来不在任何屏幕上：${x},${y}`);
  return { x, y, text: `${x},${y}` };
}

/**
 * 按锚点找文字，找不到就缩短再试。
 * 原因：选项文案常常换行渲染，OCR 会把它切成两条观测，长锚点跨行必然匹配不上。
 */
function findByAnchor(anchor, region) {
  const text = String(anchor || '').trim();
  if (!text) return null;
  const tries = [text];
  for (const n of [12, 8, 5]) {
    if (text.length > n) tries.push(text.slice(0, n));
  }
  for (const q of tries) {
    const r = ocr.find(q, { region, refresh: true, mode: 'contains' });
    if (r.picked) return { ...r.picked, matchedBy: q };
  }
  return null;
}

async function dispatch(name, args = {}, ctx = null) {
  try {
    switch (name) {
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
          // 自动动作也走 callTool，这样审计和注解都一致
          execute: (tool, toolArgs) => callTool(tool, toolArgs, ctx),
        });
        return ok(r);
      }

      case 'minimax_events': {
        const r = watch.readEvents(args.since, args.limit ?? 50);
        return ok(r);
      }

      case 'minimax_brief':
        return ok(brief.brief({
          stalledMinutes: args.stalledMinutes,
          activeMinutes: args.activeMinutes,
          finishedMinutes: args.finishedMinutes,
          limit: args.limit,
        }));

      case 'minimax_status': {
        const s = db.status();
        if (await cdp.isAvailable()) {
          try {
            s.quota = await cdp.getQuotaStatus();
          } catch (_) {}
        }
        return ok(s);
      }

      case 'minimax_list_sessions':
        return ok({ sessions: db.listSessions(args.limit ?? 20) });

      case 'minimax_read_session': {
        const target = args.session || args.sessionId;
        if (!target) return fail('缺少必填参数 session 或 sessionId');
        const r = db.readSession(target, args.limit ?? 30, args.includeThinking === true, args.before ?? null);
        return r.error ? fail(r.error) : ok(r);
      }

      case 'minimax_tail_sessions':
        return ok({ sessions: db.tailSessions(args.count ?? 3, args.perSession ?? 2) });

      case 'minimax_search':
        return ok({ hits: db.search(args.query, args.limit ?? 20, args.includeTitles !== false) });

      case 'minimax_pending':
        return ok({ pending: db.pending() });

      case 'minimax_tasks':
        return ok({ tasks: db.tasks(args.limit ?? 20, args.status ?? null) });

      case 'minimax_windows': {
        const onScreen = gui.appWindows();
        const all = gui.windowsAll().filter((w) => w.app === gui.APP);
        const hidden = all.filter((w) => !onScreen.some((o) => o.pid === w.pid && o.x === w.x));
        return ok({
          onScreenCount: onScreen.length,
          windows: onScreen,
          hiddenOrOtherSpace: hidden.map((w) => ({ pid: w.pid, x: w.x, y: w.y, width: w.width, height: w.height, title: w.title })),
          note: hidden.length
            ? '有窗口不在当前屏上（被隐藏/最小化/在别的 Space）。激活用 minimax_activate，它会自己拉回来。'
            : null,
        });
      }

      case 'minimax_activate': {
        let win = gui.mainWindow();
        let recovered = null;
        let launched = false;
        if (!win) {
          // 没窗口可能只是没启动。对"别的 agent 来用"这个场景，能自己拉起来比报错有用。
          try {
            gui.openApp();
            gui.sleep(2500);
            launched = true;
          } catch (err) {
            return fail(String(err.message || err));
          }
          win = gui.mainWindow();
          if (!win) {
            return fail('尝试启动 MiniMax Code 后仍然找不到窗口，请手动打开一次确认。');
          }
        }
        if (!win.visible) {
          // 窗口被隐藏、最小化或跑到别的 Space：OnScreenOnly 拿不到它，
          // activate(PID) 也未必能拉回来，用 LaunchServices 打开最稳。
          recovered = gui.openApp();
          const after = gui.mainWindow();
          win = after || win;
        } else {
          gui.activate(win.pid);
          gui.sleep(900);
        }
        return ok({
          recovered,
          launched,
          activeApp: gui.activeApp(),
          topmostWindow: gui.topmostApp(),
          window: win,
        });
      }

      case 'minimax_screenshot': {
        const region = args.mode === 'region'
          ? { x: args.x, y: args.y, width: args.width, height: args.height }
          : null;
        if (args.mode === 'region' && (!region || [region.x, region.y, region.width, region.height].some((v) => typeof v !== 'number'))) {
          return fail('mode=region 需要同时提供 x/y/width/height');
        }
        const shot = gui.screenshot(args.name || 'minimax', args.mode || 'screen', region);
        return ok(shot);
      }

      case 'minimax_send_message': {
        const layout = args.layout || 'chat';
        const quietSeconds = args.quietSeconds === undefined ? 300 : Number(args.quietSeconds);
        const force = args.force === true;

        const win = gui.mainWindow();
        const atParsed = args.at !== undefined && args.at !== null ? parseAt(args.at) : null;
        const coords = gui.inputCoords(win, atParsed ? atParsed.text : null, layout);
        if (!coords) return fail('拿不到 MiniMax 窗口位置，请用 at 指定输入框坐标');

        // 预览模式：只报告会发生什么，不点、不粘、不发。只读，所以不受守卫限制。
        if (args.preview === true) {
          const overlay = blockedByOverlay(coords.x, coords.y);
          const busy = guardCandidates()
            .map((s) => ({ ...s, idleSeconds: Math.round((Date.now() - s.lastActivityMs) / 1000) }))
            .filter((s) => s.idleSeconds < quietSeconds);
          return ok({
            preview: true,
            wouldSend: args.send === true,
            inputAt: coords,
            overlay: overlay ? { app: overlay.app, title: overlay.title } : null,
            activeApp: gui.activeApp(),
            busySessions: busy.map((s) => ({ sessionId: s.sessionId, title: s.title, idleSeconds: s.idleSeconds, source: s.source })),
            guard: { busy: busy.length > 0, quietSeconds },
          });
        }

        // 守卫：候选会话里有刚动过的就不发，除非显式 force。
        // 防止把自动化/测试消息插进用户正在进行的工作。
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

        // 1. 优先走 CDP 零权限高速通道（无视遮挡、无需剪贴板污染、无需前台置顶）
        if (!atParsed && await cdp.isAvailable()) {
          try {
            await cdp.typeMessage(args.message);
            if (args.send !== true) {
              return ok({ sent: false, note: '已通过 CDP 注入未发送；send=true 才会发送', via: 'cdp' });
            }
            const before = db.maxMessageId();
            await cdp.sendMessage();
            const hit = db.waitForUserMessage(before, args.message);
            if (hit.ok) {
              const payload = { sent: true, verified: true, sessionId: hit.sessionId, messageId: hit.messageId, via: 'cdp' };
              if (tasksEnabled) {
                const t = tasks.create({
                  sessionId: hit.sessionId,
                  afterMessageId: hit.messageId,
                  messagePreview: String(args.message).slice(0, 80),
                });
                payload.taskId = t.taskId;
                payload.note = '已创建任务；用 tasks/get 看状态、tasks/result 取结果，完成时会收到 notifications/tasks/status';
              }
              return ok(payload);
            }
          } catch (_) {}
        }

        // 2. 降级走传统的 CoreGraphics 模拟点击与系统剪贴板注入
        if (!gui.ensureFront()) {
          return fail('MiniMax 不是活跃应用（你可能正在用别的 App），已放弃操作，避免点到别的窗口');
        }
        const overlay = blockedByOverlay(coords.x, coords.y);
        if (overlay) {
          return fail(`输入框位置 (${coords.x},${coords.y}) 被别的应用盖住了：${overlay.app} / ${overlay.title || '(无标题)'}。先关掉或移开它，或用 at 指定别的坐标`);
        }
        gui.click(coords.x, coords.y);
        gui.sleep(400);
        gui.clipboard(args.message);
        gui.sleep(120);
        gui.pressKey('v', ['cmd']);
        gui.sleep(700);
        if (args.send !== true) {
          return ok({ sent: false, note: '已粘贴未发送；send=true 才会回车', inputAt: coords });
        }
        const before = db.maxMessageId();
        gui.pressKey('return');
        const hit = db.waitForUserMessage(before, args.message);
        if (hit.ok) {
          const payload = { sent: true, verified: true, sessionId: hit.sessionId, messageId: hit.messageId };
          // 客户端支持 Tasks 扩展时，顺手建一条持久任务，host 可以订阅而不必轮询
          if (tasksEnabled) {
            const t = tasks.create({
              sessionId: hit.sessionId,
              afterMessageId: hit.messageId,
              messagePreview: String(args.message).slice(0, 80),
            });
            payload.taskId = t.taskId;
            payload.note = '已创建任务；用 tasks/get 看状态、tasks/result 取结果，完成时会收到 notifications/tasks/status';
          }
          return ok(payload);
        }
        return ok({
          sent: true,
          verified: false,
          warning: '回车了但数据库里没出现这条消息，大概率没发出去；请截图检查输入框是否还留着文字',
        });
      }

      case 'minimax_click': {
        if (!gui.ensureFront()) return fail('MiniMax 不是活跃应用，已放弃操作');
        const overlay = blockedByOverlay(args.x, args.y);
        if (overlay) {
          return fail(`坐标 (${args.x},${args.y}) 被别的应用盖住了：${overlay.app} / ${overlay.title || '(无标题)'}，点下去会点到它`);
        }
        return ok(gui.click(args.x, args.y, args.button || 'left'));
      }

      case 'minimax_type': {
        // 打字会往用户正在编辑的输入框里塞东西，同样过活跃守卫。
        const busy = guardCandidates()
          .map((s) => ({ ...s, idleSeconds: Math.round((Date.now() - s.lastActivityMs) / 1000) }))
          .filter((s) => s.idleSeconds < 300);
        if (busy.length > 0 && args.force !== true) {
          return fail(`有会话刚还在活动（${busy.map((s) => `${s.idleSeconds}s 前`).join('；')}），已拒绝输入以免打扰。确认要输就加 force: true`);
        }

        // 1. 优先走 CDP 零权限输入（无需前台聚焦，直接注入 TipTap/ProseMirror）
        if (await cdp.isAvailable()) {
          try {
            const res = await cdp.typeMessage(args.text, { append: true });
            if (res && res.ok) {
              return ok({ typed: args.text.length, via: 'cdp', currentText: res.currentText });
            }
          } catch (_) {}
        }

        if (!gui.ensureFront()) return fail('MiniMax 不是活跃应用，已放弃操作');
        return ok(gui.typeText(args.text));
      }

      case 'minimax_get_result': {
        let sid = null;
        let fallback = false;
        if (args.sessionId) {
          sid = db.resolveSession(args.sessionId);
          // 显式指定了却解析不出来，必须报错。
          // 悄悄退回"最近活跃会话"会让调用方拿到别人的结果还以为是自己要的——这比报错危险得多。
          if (!sid) return fail(`找不到会话: ${args.sessionId}`);
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

      case 'minimax_draft_answer': {
        const detail = db.questionnaireDetail(args.requestId);
        if (!detail) return fail(`找不到提问: ${args.requestId}`);
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
          note: '以上是草稿。要提交用 minimax_answer_question，默认也只 preview。',
        });
      }

      case 'minimax_answer_question': {
        const detail = db.questionnaireDetail(args.requestId);
        if (!detail) return fail(`找不到提问: ${args.requestId}`);
        if (detail.status !== 'pending') {
          return fail(`这条提问已经是 ${detail.status}，不能再答`);
        }
        const suggestion = db.suggestAnswer(detail);
        const raw = Array.isArray(args.selections) && args.selections.length
          ? args.selections
          : qn.fromSuggestion(suggestion);
        const { answers, errors } = qn.normalizeSelections(detail, raw);
        if (errors.length) {
          return fail(`答案有问题，未提交：\n- ${errors.join('\n- ')}`);
        }
        // 防御：问卷没有步骤、或所有步骤都不是必答时，answers 会是空的。
        // 这时候如果继续走下去，会"点了提交按钮但什么都没选"——比报错更糟。
        if (!answers.length) {
          return fail('这条提问解析不出任何可答的步骤，拒绝提交空答案。用 minimax_draft_answer 看看原始结构。');
        }
        const payload = qn.buildReplyPayload(detail, answers);
        const plan = qn.clickPlan(detail, answers);

        // 默认只预览：答了等于替用户做决定，不当默认行为。
        if (args.preview !== false) {
          return ok({
            preview: true,
            requestId: detail.requestId,
            sessionId: detail.sessionId,
            title: detail.title,
            wouldSubmit: payload,
            clickPlan: plan,
            steps: detail.steps,
            note: 'preview 模式没有做任何操作。要真提交：preview:false + force:true。' +
              '提交会按 clickPlan 用 OCR 找选项文字并点击，最后找提交按钮，然后核对数据库状态。',
          });
        }

        if (args.force !== true) {
          return fail('这是在替用户做决定。确认要提交就显式加 force:true');
        }
        if (!gui.ensureFront()) return fail('MiniMax 不是活跃应用，已放弃操作');
        const win = gui.mainWindow();
        if (!win) return fail('找不到 MiniMax 窗口');
        const region = args.region || { x: win.x, y: win.y, width: win.width, height: win.height };

        // 逐个点选。每一步都重新 OCR（界面会因为选择而变化）。
        const clicked = [];
        const missed = [];
        for (const step of plan) {
          const hit = findByAnchor(step.anchor, region);
          if (!hit) {
            missed.push({ stepId: step.stepId, anchor: step.anchor, reason: '屏幕上找不到这段文字' });
            continue;
          }
          const overlay = blockedByOverlay(hit.cx, hit.cy);
          if (overlay) {
            missed.push({ stepId: step.stepId, anchor: step.anchor, reason: `被 ${overlay.app} 盖住` });
            continue;
          }
          gui.click(hit.cx, hit.cy);
          clicked.push({ stepId: step.stepId, optionId: step.optionId, at: [hit.cx, hit.cy], text: hit.text, matchedBy: hit.matchedBy });
          gui.sleep(600);
          if (step.thenType) {
            gui.typeText(step.thenType);
            gui.sleep(300);
          }
        }

        if (missed.length) {
          return ok({
            submitted: false,
            clicked,
            missed,
            warning: '有选项没点到，已停下（不会盲点提交）。截图确认界面状态，补 at/region 后重试，或手动点完。',
          });
        }

        // 有的问卷点完选项就直接提交了，没有独立的提交按钮。
        // 所以先看数据库状态变没变，变了就别再去找按钮瞎点。
        const afterClicks = db.questionnaireDetail(detail.requestId);
        if (afterClicks && afterClicks.status !== 'pending') {
          return ok({
            submitted: true,
            verified: true,
            status: afterClicks.status,
            clicked,
            note: '点选项后状态已变成 ' + afterClicks.status + '，这类问卷是"选中即提交"，不需要再找提交按钮。',
          });
        }

        // 找提交按钮：常见文案都试一遍
        const submitLabels = ['提交', '确定', '确认', '发送', '完成', 'Submit', 'Send'];
        let submitHit = null;
        for (const label of submitLabels) {
          const r = ocr.find(label, { region, refresh: true, mode: 'exact' });
          if (r.picked) { submitHit = { label, ...r.picked }; break; }
        }
        if (!submitHit) {
          return ok({
            submitted: false,
            verified: false,
            clicked,
            warning: '选项都点了，但数据库状态还是 pending，也没找到提交按钮（试过：' + submitLabels.join('/') + '）。' +
              '可能是选中后还需要点别的地方，或者这个界面是"选中即提交但没生效"。' +
              '用 minimax_screenshot 看当前界面，再用 minimax_click_text 点真正的确认按钮。',
          });
        }
        const submitOverlay = blockedByOverlay(submitHit.cx, submitHit.cy);
        if (submitOverlay) {
          return ok({ submitted: false, clicked, warning: `提交按钮被 ${submitOverlay.app} 盖住了` });
        }
        gui.click(submitHit.cx, submitHit.cy);
        gui.sleep(1200);

        // 真验证：数据库里这条提问的状态必须从 pending 变掉
        const after = db.questionnaireDetail(detail.requestId);
        const done = after && after.status !== 'pending';
        return ok({
          submitted: true,
          verified: Boolean(done),
          status: after?.status || 'unknown',
          clicked,
          submitAt: [submitHit.cx, submitHit.cy],
          ...(done ? {} : { warning: '点了提交但数据库里状态还是 pending，可能没提交成功，截图核对' }),
        });
      }

      case 'minimax_find_text': {
        const region = args.region || (() => {
          const w = gui.mainWindow();
          return w ? { x: w.x, y: w.y, width: w.width, height: w.height } : null;
        })();
        const r = ocr.find(args.text, {
          region,
          mode: args.mode || 'contains',
          index: args.index || 0,
          refresh: args.refresh !== false,
        });
        return ok({
          query: r.query,
          total: r.total,
          picked: r.picked,
          matches: r.matches,
          scanned: r.scanned,
          region: r.region,
          hint: r.total ? '用 minimax_click_text 或 minimax_click 点 picked.cx/cy' : '没找到；换更短的片段，或用 minimax_screenshot 看图',
        });
      }

      case 'minimax_click_text': {
        // 1. 优先尝试 CDP DOM 点击（免权限、100% 精准）
        if (await cdp.isAvailable()) {
          try {
            const r = await cdp.clickElement({ text: args.text });
            if (r && r.ok) {
              return ok({ clicked: r.text || args.text, via: 'cdp', tag: r.clickedTag });
            }
          } catch (_) {}
        }

        // 2. 降级走 OCR 识别 + GUI 事件注入
        if (!gui.ensureFront()) return fail('MiniMax 不是活跃应用，已放弃操作');
        const win = gui.mainWindow();
        const region = args.region || (win ? { x: win.x, y: win.y, width: win.width, height: win.height } : null);
        const r = ocr.find(args.text, {
          region,
          mode: args.mode || 'contains',
          index: args.index || 0,
          refresh: true,
        });
        if (!r.picked) {
          return fail(`屏幕上找不到「${args.text}」（扫了 ${r.scanned} 段文字）`);
        }
        const overlay = blockedByOverlay(r.picked.cx, r.picked.cy);
        if (overlay) {
          return fail(`「${r.picked.text}」的位置被 ${overlay.app} 盖住了，先移开它`);
        }
        gui.click(r.picked.cx, r.picked.cy);
        return ok({ clicked: r.picked.text, at: [r.picked.cx, r.picked.cy], confidence: r.picked.conf, total: r.total });
      }

      case 'minimax_new_task': {
        if (!gui.ensureFront()) return fail('MiniMax 不是活跃应用，已放弃操作');
        const win = gui.mainWindow();
        if (!win) return fail('找不到 MiniMax 窗口');
        const region = { x: win.x, y: win.y, width: win.width, height: win.height };

        const before = gui.appWindows().map((w) => `${w.pid}:${w.x},${w.y},${w.width}x${w.height}`).sort();
        // 记下切换前主区域的文字量。⌘N 多数情况是"同一窗口内换视图"，
        // 会话页有一大坨消息，新建页只剩问候语 + 占位符，文字量会塌下来。
        const beforeText = (() => {
          try { return ocr.read(region).items.map((i) => i.text).join('').length; } catch { return null; }
        })();

        gui.pressKey('n', ['cmd']);
        gui.sleep(2500);

        const after = gui.appWindows().map((w) => `${w.pid}:${w.x},${w.y},${w.width}x${w.height}`).sort();
        const newWindows = after.filter((w) => !before.includes(w));
        const afterText = (() => {
          try { return ocr.read(region).items.map((i) => i.text).join('').length; } catch { return null; }
        })();

        if (newWindows.length) {
          const m = newWindows[0].match(/^(\d+):(-?[\d.]+),(-?[\d.]+),(\d+)x(\d+)$/);
          const geo = m ? { x: Number(m[2]), y: Number(m[3]), width: Number(m[4]), height: Number(m[5]) } : null;
          return ok({
            opened: true,
            via: 'new-window',
            newWindow: newWindows,
            window: geo,
            hint: geo ? `新任务页输入框大约在 (${Math.round(geo.x + geo.width * 0.416)}, ${Math.round(geo.y + geo.height * 0.418)})，或直接用 layout:"newtask"` : null,
          });
        }

        // 视图切换的判据：主区域文字量掉到原来的一半以下
        const shrank = beforeText !== null && afterText !== null && beforeText > 40 && afterText < beforeText * 0.5;
        if (shrank) {
          const coords = gui.inputCoords(win, null, 'newtask');
          return ok({
            opened: true,
            via: 'view-switch',
            textBefore: beforeText,
            textAfter: afterText,
            window: { x: win.x, y: win.y, width: win.width, height: win.height },
            hint: `已在同一窗口切到新建任务页（文字量 ${beforeText} → ${afterText}）。` +
              `输入框估算 (${coords.x},${coords.y})，不准就用 minimax_find_text 找占位符再点。`,
          });
        }

        return ok({
          opened: false,
          via: 'unknown',
          textBefore: beforeText,
          textAfter: afterText,
          note: '按了 ⌘N 但既没新窗口、主区域文字量也没明显变化。可能焦点不在 MiniMax 输入区，或快捷键被占用——截图确认。',
          windows: after,
        });
      }

      case 'minimax_open_session': {
        const sid = db.resolveSession(args.session);
        if (!sid) return fail(`找不到会话: ${args.session}`);
        if (!gui.ensureFront()) return fail('MiniMax 不是活跃应用，已放弃操作');
        const win = gui.mainWindow();
        if (!win) return fail('找不到 MiniMax 窗口');

        // 显式给了坐标就用坐标；否则用会话标题去**左侧栏**里 OCR 找。
        // 注意：标题在侧栏和主区域顶部都会出现，必须只认左侧那一列，否则会点到顶栏。
        let target = null;
        if (args.at !== undefined && args.at !== null) {
          const p = parseAt(args.at);
          target = { cx: p.x, cy: p.y, text: '(手动坐标)' };
        } else {
          const meta = db.sessionMeta(sid);
          const candidates = [meta?.title, meta?.firstUserMessage]
            .map((s) => String(s || '').trim())
            .filter((s) => s.length >= 2);
          if (!candidates.length) {
            return fail('这个会话没有标题可用于定位，请用 at 给出侧栏坐标');
          }
          // 标题在侧栏和主区域顶部都会出现，取**最靠左那一列**的命中（侧栏就是最左列）
          for (const c of candidates) {
            for (const q of [c.slice(0, 14), c.slice(0, 8)]) {
              const r = ocr.find(q, {
                region: { x: win.x, y: win.y, width: win.width, height: win.height },
                refresh: true,
                mode: 'contains',
                limit: 20,
              });
              if (!r.matches.length) continue;
              const picked = ocr.pickLeftmostColumn(r.matches);
              if (!picked) continue;
              target = { ...picked, matchedBy: q, alternatives: r.matches.length };
              break;
            }
            if (target) break;
          }
          if (!target) {
            return ok({
              opened: false,
              sessionId: sid,
              tried: candidates,
              hint: '侧栏里没找到这个标题（可能被滚动到视野外，或标题被截断）。用 minimax_screenshot 看侧栏，或用 at:"x,y" 指定坐标。',
            });
          }
        }

        const overlay = blockedByOverlay(target.cx, target.cy);
        if (overlay) {
          return fail(`目标位置被别的应用盖住了：${overlay.app} / ${overlay.title || '(无标题)'}`);
        }
        gui.click(target.cx, target.cy);
        gui.sleep(1200);
        return ok({
          opened: true,
          sessionId: sid,
          clicked: [target.cx, target.cy],
          matchedText: target.text,
          note: '点完了。要确认切对了，用 minimax_read_session 看这个会话的末尾是否与界面一致。',
        });
      }

      case 'minimax_stop_generation': {
        if (!gui.ensureFront()) return fail('MiniMax 不是活跃应用，已放弃操作');
        gui.pressKey('escape');
        return ok({ stopped: true, via: 'escape' });
      }

      case 'minimax_key': {
        if (!gui.ensureFront()) return fail('MiniMax 不是活跃应用，已放弃操作');
        return ok(gui.pressKey(args.key, args.modifiers || []));
      }

      case 'minimax_bot_message': {
        const { botClient } = require('../gateway/bot');
        const chatId = args.chatId || 'group:grp_d631733f2e13';
        const action = args.action || (args.text ? 'send' : 'read');
        if (action === 'read') {
          const res = await botClient.listMessages(chatId, args.limit || 20);
          return ok(res);
        }
        if (action === 'cancel') {
          const res = await botClient.cancelTurn(chatId);
          return ok(res);
        }
        if (action === 'resume_pending') {
          const res = await botClient.resumePending(chatId);
          return ok(res);
        }
        if (!args.text) return fail('action=send 时 text 不能为空');
        const res = await botClient.sendMessage(chatId, args.text);
        return ok(res);
      }

      case 'minimax_auto_resume': {
        const { autoResume } = require('../gateway/resume');
        const dryRun = args.dryRun !== false;
        const limit = args.limit || 5;
        const res = await autoResume({ dryRun, limit, sessionId: args.sessionId });
        return ok(res);
      }

      default:
        return fail(`未知工具: ${name}`);
    }
  } catch (err) {
    return fail(`${err && err.message ? err.message : String(err)}`);
  }
}

/**
 * 对外入口：先分发，再按风险级别决定要不要落审计。
 * 审计放在最外层，保证"调了但抛错"也留下记录——那种情况恰恰最需要回溯。
 */
async function callTool(name, args = {}, ctx = null) {
  const started = Date.now();

  // 入参别名按工具精准归一化：抹平不同大模型（Claude/Gemini/GPT/开源模型）命名习惯差异，且不污染其他工具
  if (args && typeof args === 'object') {
    if (name === 'minimax_read_session') {
      if (args.sessionId && !args.session) args.session = args.sessionId;
    } else if (name === 'minimax_open_session' || name === 'minimax_get_result' || name === 'minimax_stop_generation') {
      if (args.session && !args.sessionId) args.sessionId = args.session;
    } else if (name === 'minimax_send_message') {
      if (args.text && !args.message) args.message = args.text;
      if (args.content && !args.message) args.message = args.content;
    } else if (name === 'minimax_search') {
      if (args.q && !args.query) args.query = args.q;
      if (args.keyword && !args.query) args.query = args.keyword;
    } else if (name === 'minimax_draft_answer' || name === 'minimax_answer_question') {
      if (args.id && !args.requestId) args.requestId = args.id;
    } else if (name === 'minimax_find_text' || name === 'minimax_click_text') {
      if (args.query && !args.text) args.text = args.query;
    }
  }

  // 先用工具自己的 schema 挡一道。参数错就立刻报清楚，别让它变成 NaN 点歪坐标。
  const tool = TOOLS.find((t) => t.name === name);
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
    if (ann.needsAudit(name)) {
      audit.record({
        tool: name,
        level: ann.levelOf(name),
        args,
        ok: false,
        ms: Date.now() - started,
        error: err && err.message ? err.message : String(err),
      });
    }
    throw err;
  }
  if (ann.needsAudit(name)) {
    const payload = parsePayload(result);
    audit.record({
      tool: name,
      level: ann.levelOf(name),
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
}

/** 从工具返回的 JSON 文本里取几个字段，取不到就算了。 */
function parsePayload(result) {
  try {
    return JSON.parse(result.content[0].text);
  } catch {
    return null;
  }
}

module.exports = { callTool, READONLY, setTasksEnabled };
