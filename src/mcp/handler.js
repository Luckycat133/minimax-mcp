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
        const list = gui.appWindows();
        return ok({ count: list.length, windows: list });
      }

      case 'minimax_activate': {
        const w = gui.mainWindow();
        if (!w) return fail('找不到 MiniMax Code 窗口，可能没启动');
        gui.activate(w.pid);
        gui.sleep(900);
        const f = gui.front();
        return ok({ activated: w.pid, front: f });
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
        if (!gui.ensureFront()) {
          return fail('MiniMax 不在前台（你可能正在用别的 App），已放弃操作，避免点到别的窗口');
        }
        const win = gui.mainWindow();
        const coords = gui.inputCoords(win, args.at, args.layout || 'chat');
        if (!coords) return fail('拿不到 MiniMax 窗口位置，请用 at 指定输入框坐标');
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
        if (!gui.ensureFront()) return fail('MiniMax 不在前台，已放弃操作');
        return ok(gui.click(args.x, args.y, args.button || 'left'));
      }

      case 'minimax_type': {
        if (!gui.ensureFront()) return fail('MiniMax 不在前台，已放弃操作');
        return ok(gui.typeText(args.text));
      }

      case 'minimax_key': {
        if (!gui.ensureFront()) return fail('MiniMax 不在前台，已放弃操作');
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
