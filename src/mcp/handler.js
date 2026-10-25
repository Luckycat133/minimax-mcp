'use strict';

/**
 * handler.js — 工具分发。所有控制类工具先做前台校验，不在前台就直接返回错误，
 * 不硬来，避免点到用户正在用的窗口。
 */

const db = require('../gateway/db');
const gui = require('../gateway/gui');

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
 * 目标会话最近是否还在活动。
 * 「最近活跃的会话」基本就是当前打开的那个——用它判断用户是否正在对话中，
 * 避免把测试/自动化消息插进人家正在进行的工作。
 */
function mostRecentSessionActivity() {
  const list = db.listSessions(1);
  if (!list.length) return null;
  return list[0];
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
          const recent = mostRecentSessionActivity();
          const idleMs = recent?.lastActivityMs ? Date.now() - recent.lastActivityMs : Infinity;
          return ok({
            preview: true,
            wouldSend: args.send === true,
            inputAt: coords,
            overlay: overlay ? { app: overlay.app, title: overlay.title } : null,
            activeApp: gui.activeApp(),
            mostRecentSession: recent
              ? { sessionId: recent.sessionId, idleSeconds: Math.round(idleMs / 1000) }
              : null,
            guard: { busy: idleMs < quietSeconds * 1000, quietSeconds },
          });
        }

        // 守卫：当前会话还在活跃就不发，除非显式 force。
        // 防止把自动化/测试消息插进用户正在进行的工作。
        const recent = mostRecentSessionActivity();
        const idleMs = recent?.lastActivityMs ? Date.now() - recent.lastActivityMs : Infinity;
        if (idleMs < quietSeconds * 1000 && !force) {
          return fail(
            `当前会话 ${recent.sessionId} ${Math.round(idleMs / 1000)} 秒前还在活动，` +
            `看起来你正在对话中。已拒绝发送以免打扰。` +
            `确认要发就加 force: true；或者调整 quietSeconds（当前 ${quietSeconds}）。`
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
          return ok({ sent: true, verified: true, sessionId: hit.sessionId, messageId: hit.messageId });
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
        return ok(gui.typeText(args.text));
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

module.exports = { callTool, READONLY };
