'use strict';

/**
 * handler.js — 工具分发。所有控制类工具先做前台校验，不在前台就直接返回错误，
 * 不硬来，避免点到用户正在用的窗口。
 */

const db = require('../gateway/db');
const gui = require('../gateway/gui');
const tasks = require('./tasks');

/** 客户端是否协商了 Tasks 扩展。由 stdio-server 在 initialize 时设置。 */
let tasksEnabled = false;
function setTasksEnabled(v) { tasksEnabled = v === true; }

const READONLY = new Set([
  'minimax_status', 'minimax_list_sessions', 'minimax_read_session',
  'minimax_tail_sessions', 'minimax_search', 'minimax_pending',
  'minimax_tasks', 'minimax_windows',
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

function callTool(name, args = {}) {
  try {
    switch (name) {
      case 'minimax_status':
        return ok(db.status());

      case 'minimax_list_sessions':
        return ok({ sessions: db.listSessions(args.limit ?? 20) });

      case 'minimax_read_session': {
        const r = db.readSession(args.session, args.limit ?? 30, args.includeThinking === true);
        return r.error ? fail(r.error) : ok(r);
      }

      case 'minimax_tail_sessions':
        return ok({ sessions: db.tailSessions(args.count ?? 3, args.perSession ?? 2) });

      case 'minimax_search':
        return ok({ hits: db.search(args.query, args.limit ?? 20) });

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
        if (!win) {
          return fail('找不到 MiniMax Code 窗口，进程可能没启动');
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
        const coords = gui.inputCoords(win, args.at, layout);
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
        if (!gui.ensureFront()) return fail('MiniMax 不是活跃应用，已放弃操作');
        // 打字会往用户正在编辑的输入框里塞东西，同样过活跃守卫。
        const busy = guardCandidates()
          .map((s) => ({ ...s, idleSeconds: Math.round((Date.now() - s.lastActivityMs) / 1000) }))
          .filter((s) => s.idleSeconds < 300);
        if (busy.length > 0 && args.force !== true) {
          return fail(`有会话刚还在活动（${busy.map((s) => `${s.idleSeconds}s 前`).join('；')}），已拒绝输入以免打扰。确认要输就加 force: true`);
        }
        return ok(gui.typeText(args.text));
      }

      case 'minimax_get_result': {
        let sid = args.sessionId ? db.resolveSession(args.sessionId) : null;
        if (!sid) {
          const recent = db.recentlyTouchedSessions(1)[0] || db.listSessions(1)[0];
          if (!recent) return fail('找不到会话');
          sid = recent.sessionId;
        }
        const after = Number(args.afterMessageId || 0);
        const timeout = Number(args.timeoutSeconds || 300);
        return ok(db.waitForResult(sid, after, timeout));
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
        const selections = Array.isArray(args.selections) && args.selections.length
          ? args.selections
          : suggestion.answers;

        // 默认只预览：答了等于替用户做决定，不当默认行为。
        if (args.preview !== false) {
          return ok({
            preview: true,
            requestId: detail.requestId,
            sessionId: detail.sessionId,
            title: detail.title,
            wouldSubmit: {
              schemaVersion: 2,
              requestId: detail.requestId,
              answers: selections.map((s) => ({ stepId: s.stepId, selectedOptionIds: s.optionIds, selectedOther: false })),
            },
            steps: detail.steps,
            note: 'preview 模式没有做任何操作。要真提交：preview:false + force:true，并先用截图确认问卷 UI 的选项位置。',
          });
        }

        if (args.force !== true) {
          return fail('这是在替用户做决定。确认要提交就显式加 force:true');
        }
        if (!gui.ensureFront()) return fail('MiniMax 不是活跃应用，已放弃操作');
        if (!args.at) {
          return fail('需要 at 坐标（问卷第一个选项的位置）。先截图确定，再传 "x,y"');
        }
        // GUI 提交路径：尚未用真实问卷验证过（没有可测的 pending 提问）。
        // 这里只实现第一步——点到第一个选项，剩下的交给调用方按截图继续。
        const [ax, ay] = String(args.at).split(',').map(Number);
        const overlay = blockedByOverlay(ax, ay);
        if (overlay) {
          return fail(`坐标 (${ax},${ay}) 被别的应用盖住了：${overlay.app} / ${overlay.title || '(无标题)'}`);
        }
        gui.click(ax, ay);
        return ok({
          submitted: false,
          clickedFirstOption: [ax, ay],
          pendingSelections: selections,
          warning: '只点了第一个选项。问卷多为多步，后续步骤需要按截图继续点，最后点提交。这条 GUI 路径没有用真实问卷验证过——每步之后都截图核对。',
        });
      }

      case 'minimax_new_task': {
        if (!gui.ensureFront()) return fail('MiniMax 不是活跃应用，已放弃操作');
        const before = gui.appWindows().map((w) => `${w.pid}:${w.x},${w.y},${w.width}x${w.height}`).sort();
        gui.pressKey('n', ['cmd']);
        gui.sleep(2500);
        const after = gui.appWindows().map((w) => `${w.pid}:${w.x},${w.y},${w.width}x${w.height}`).sort();
        const opened = after.filter((w) => !before.includes(w));
        if (opened.length) {
          const m = opened[0].match(/^(\d+):(-?[\d.]+),(-?[\d.]+),(\d+)x(\d+)$/);
          const geo = m ? { x: Number(m[2]), y: Number(m[3]), width: Number(m[4]), height: Number(m[5]) } : null;
          return ok({
            opened: true,
            newWindow: opened,
            window: geo,
            hint: geo ? `新任务页输入框大约在 (${Math.round(geo.x + geo.width * 0.416)}, ${Math.round(geo.y + geo.height * 0.418)})，或直接用 layout:"newtask"` : null,
          });
        }
        return ok({
          opened: false,
          note: '按了 ⌘N 但没检测到新窗口。可能快捷键没注册、或新任务页是在当前窗口内切换的视图——截图确认一下。',
          windows: after,
        });
      }

      case 'minimax_open_session': {
        const sid = db.resolveSession(args.session);
        if (!sid) return fail(`找不到会话: ${args.session}`);
        if (!args.at) {
          return ok({
            opened: false,
            sessionId: sid,
            hint: '没给 at 坐标，没有乱点。先 minimax_screenshot 看左侧列表，确定该条目的坐标后用 at:"x,y" 重试。',
            currentWindow: gui.mainWindow(),
          });
        }
        if (!gui.ensureFront()) return fail('MiniMax 不是活跃应用，已放弃操作');
        const [x, y] = String(args.at).split(',').map(Number);
        const overlay = blockedByOverlay(x, y);
        if (overlay) {
          return fail(`坐标 (${x},${y}) 被别的应用盖住了：${overlay.app} / ${overlay.title || '(无标题)'}`);
        }
        gui.click(x, y);
        gui.sleep(1200);
        return ok({ opened: true, sessionId: sid, clicked: [x, y], note: '点完了，截图核对一下是不是这个会话' });
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

      default:
        return fail(`未知工具: ${name}`);
    }
  } catch (err) {
    return fail(`${err && err.message ? err.message : String(err)}`);
  }
}

module.exports = { callTool, READONLY, setTasksEnabled };
