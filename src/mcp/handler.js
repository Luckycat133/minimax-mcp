'use strict';

/** MCP 参数校验、工具分发、错误转换与审计。 */

const path = require('path');
const fs = require('fs');
const db = require('../gateway/db');
const gui = require('../gateway/gui');
const agent = require('../gateway/agent');
const questions = require('../gateway/questions');
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

const READONLY = new Set(Object.keys(ann.LEVEL).filter((name) => ann.levelOf(name) === 'read'));

function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

function fail(message, details = {}) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message, ...details }) }], isError: true };
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
          s.cdp.hint = 'MiniMax 正在运行但未开启 CDP 调试端口 (9223)。可用 scripts/launch-with-debug.js 启用。';
        } else {
          s.cdp.hint = 'MiniMax Code 尚未运行。';
        }

        let brQuotaErrors = 0;
        if (args.includeBrief !== false) {
          try {
            const br = brief.brief({ limit: 20 });
            brQuotaErrors = br.counts.quota_error || 0;
            s.attention = {
              headline: br.headline,
              pendingQuestions: br.pendingQuestions,
              stalledSessions: br.counts.stalled || 0,
              quotaErrorSessions: brQuotaErrors,
            };
          } catch (_) {}
        }

        const quotaLimited = Boolean(s.quota && s.quota.isLimited);
        if (quotaLimited) {
          const rawWait = typeof s.quota.waitSeconds === 'number' ? s.quota.waitSeconds : null;
          const wakeAfterSeconds = rawWait !== null ? Math.max(30, rawWait + 30) : 600;
          const wakeAtMs = typeof s.quota.resetAtMs === 'number'
            ? s.quota.resetAtMs + 30000
            : Date.now() + wakeAfterSeconds * 1000;
          s.wakeup = {
            shouldSchedule: true,
            reason: 'quota_limited',
            wakeAfterSeconds,
            wakeAtMs,
            wakeAt: db.localTime(wakeAtMs),
            exact: rawWait !== null,
            instruction: rawWait !== null
              ? `不要让用户手动唤醒：请立即给自己设一次性定时唤醒（${wakeAfterSeconds} 秒后，即重置时间 +30 秒缓冲）；醒来后先查 minimax_status 确认 quota.isLimited === false，再续跑任务（Bot 对话用 minimax_bot {action:"resume", target}；原生会话用 minimax_agent 对原 sessionId 续发指令）。`
              : '已触达额度上限但未解析出重置时间：请给自己设 600 秒一次性定时唤醒复查 minimax_status，不要让用户手动唤醒。',
          };
        } else if (!cdpUp && brQuotaErrors > 0) {
          const wakeAfterSeconds = 600;
          const wakeAtMs = Date.now() + wakeAfterSeconds * 1000;
          s.wakeup = {
            shouldSchedule: true,
            reason: 'cdp_offline_with_quota_errors',
            wakeAfterSeconds,
            wakeAtMs,
            wakeAt: db.localTime(wakeAtMs),
            exact: false,
            instruction: '检测到近期额度受限会话但 CDP 离线，无法读取精确重置时间：请先运行 scripts/launch-with-debug.js 后重查 minimax_status 获取精确 waitSeconds，或先给自己设 600 秒一次性定时唤醒复查；不要让用户手动唤醒。',
          };
        } else if (cdpUp && s.quota && !s.quota.isLimited && brQuotaErrors > 0) {
          s.wakeup = {
            shouldSchedule: false,
            reason: 'quota_available',
            instruction: '当前额度已恢复可用，可直接续跑受限会话（Bot 对话用 minimax_bot {action:"resume", target}；原生会话用 minimax_agent 对原 sessionId 续发指令）。',
          };
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

      case 'minimax_session': {
        if (args.action === 'list') {
          if (args.perSession !== undefined) {
            const limit = args.limit ?? 3;
            if (limit > 20) return fail('带 perSession 的列表最多采样 20 个会话');
            return ok({ sessions: db.tailSessions(limit, args.perSession, args.maxChars ?? 4000) });
          }
          return ok({ sessions: db.listSessions(args.limit ?? 20) });
        }
        if (args.action === 'read') {
          if (!args.sessionId?.trim()) return fail('read 需要 sessionId');
          const r = db.readSession(args.sessionId, args.limit ?? 30, args.includeThinking, args.before, args.maxChars ?? 4000);
          return r.error ? fail(r.error) : ok(r);
        }
        return ok({ hits: db.search(args.query, args.limit ?? 20) });
      }

      case 'minimax_agent': {
        if (args.action === 'activate') return ok(await agent.activate(ctx));
        if (args.action === 'new') return ok(await agent.newTask(ctx));
        if (args.action === 'stop') return ok(await agent.stop(args, ctx));

        if (args.action === 'result') {
          const sid = args.sessionId === undefined
            ? (db.recentlyTouchedSessions(1)[0] || db.listSessions(1)[0])?.sessionId
            : db.resolveSession(args.sessionId);
          if (!sid) return fail('找不到会话。请用 minimax_session 获取完整 sessionId');
          const result = await db.waitForResult(sid, args.afterMessageId ?? 0, args.timeoutSeconds, 3000, ctx?.shouldStop);
          if (args.sessionId === undefined) result.note = [result.note, '当前显示最近活跃会话'].filter(Boolean).join('。');
          return ok(result);
        }

        const sent = await agent.send(args, ctx);
        if (sent.verified && tasksEnabled) {
          try {
            const task = tasks.create({ sessionId: sent.sessionId, afterMessageId: sent.messageId, messagePreview: args.message.slice(0, 80) });
            sent.taskId = task.taskId;
          } catch {
            sent.note = '消息已入库。请用 minimax_agent 查询结果';
          }
        }
        return ok(sent);
      }

      // ---------- 4. MiniMax Bot 团队协同 (minimax_bot) ----------
      case 'minimax_bot': {
        const { botClient } = require('../gateway/bot');
        const { action, target } = args;

        if (action === 'roster') {
          return ok(botClient.getRoster());
        }
        if (action === 'open') return ok(await agent.control(() => botClient.open(args.sessionId, ctx)));

        if (action !== 'read' && !target?.trim()) return fail('Bot 写入需要明确的 target，请先用 roster 查看名称或 chatId');
        const resolved = botClient.resolveTarget(target, args.mode, { exact: action !== 'read' });

        if (action === 'read') {
          const res = await botClient.listMessages(resolved.chatId, args.limit || 20);
          return ok({ target: resolved, ...res });
        }
        if (action === 'send') {
          if (!args.text?.trim()) return fail('send 需要非空 text');
          const sendText = resolved.prefix ? `${resolved.prefix}${args.text}` : args.text;
          const res = await botClient.sendMessage(resolved.chatId, sendText, args.clientMessageId);
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

      case 'minimax_questionnaire': {
        if (args.action === 'list') return ok({ pending: db.pending() });
        if (!args.requestId?.trim()) return fail('answer 需要 requestId');
        const detail = db.questionnaireDetail(args.requestId);
        if (!detail) return fail('找不到提问: ' + args.requestId);
        if (detail.status !== 'pending') {
          if (!args.preview) return fail('提问状态为 ' + detail.status + '，无法提交');
          return ok({ preview: true, requestId: detail.requestId, status: detail.status, answered: detail.answered });
        }

        const suggestion = db.suggestAnswer(detail);
        const response = {
          requestId: detail.requestId, sessionId: detail.sessionId, title: detail.title, status: detail.status,
          steps: detail.steps, suggestion,
        };
        const raw = args.selections ?? qn.fromSuggestion(suggestion);
        const { answers, errors } = qn.normalizeSelections(detail, raw);
        if (errors.length || !answers.length) {
          if (args.preview && args.selections === undefined) return ok({ ...response, preview: true, selectionErrors: errors });
          return fail(errors.join('\n') || '请提供问卷答案');
        }

        if (args.preview) {
          return ok({
            ...response, preview: true,
            wouldSubmit: qn.buildReplyPayload(detail, answers),
            clickPlan: qn.clickPlan(detail, answers),
          });
        }
        if (!args.force) return fail('问卷提交需要 preview:false 和 force:true');
        return ok(await questions.submit(detail, answers, ctx));
      }

      // ---------- 6. 桌面环境与窗口控制 (minimax_desktop) ----------
      case 'minimax_desktop': {
        const { action } = args;

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
          let debug;
          if (args.relaunchWithDebug) {
            const { launchWithDebug } = require(path.join(__dirname, '..', '..', 'scripts', 'launch-with-debug'));
            debug = await launchWithDebug();
            if (!debug.ok) return fail(`挂载调试端口重启失败: ${debug.error}`);
          }
          const activated = await agent.activate(ctx);
          return debug ? ok({ ...activated, relaunchWithDebug: true, cdp: debug, window: gui.mainWindow() }) : ok(activated);
        }

        return fail(`未知桌面操作: ${action}`);
      }

      default:
        return fail(`未知工具: ${name}`);
    }
  } catch (err) {
    return fail(`${err && err.message ? err.message : String(err)}`);
  }
}

// Legacy names and parameters stay callable without appearing in tools/list.
const LEGACY_TOOLS = {
  minimax_list_sessions: ['minimax_session', 'list'],
  minimax_read_session: ['minimax_session', 'read'],
  minimax_tail_sessions: ['minimax_session', 'tail'],
  minimax_search: ['minimax_session', 'search'],
  minimax_send_message: ['minimax_agent', 'send'],
  minimax_get_result: ['minimax_agent', 'result'],
  minimax_stop_generation: ['minimax_agent', 'stop'],
  minimax_new_task: ['minimax_agent', 'new'],
  minimax_bot_roster: ['minimax_bot', 'roster'],
  minimax_bot_message: ['minimax_bot'],
  minimax_bot_turn: ['minimax_bot'],
  minimax_pending: ['minimax_questionnaire', 'list'],
  minimax_draft_answer: ['minimax_questionnaire', 'draft'],
  minimax_answer_question: ['minimax_questionnaire', 'answer'],
  minimax_activate: ['minimax_desktop', 'activate'],
  minimax_screenshot: ['minimax_desktop', 'screenshot'],
  minimax_windows: ['minimax_desktop', 'windows'],
};

const ALIASES = {
  minimax_session: { session: 'sessionId', q: 'query' },
  minimax_agent: { session: 'sessionId', text: 'message', content: 'message' },
  minimax_bot: { chatId: 'target' },
  minimax_questionnaire: { id: 'requestId' },
};

function normalizeArgs(name, args, legacyAction, callerName) {
  if (args.action !== undefined && typeof args.action !== 'string') return ['action 必须是字符串'];
  const errors = [];
  for (const [alias, canonical] of Object.entries(ALIASES[name] || {})) {
    if (!Object.hasOwn(args, alias)) continue;
    const value = args[alias];
    if (typeof value !== 'string') {
      errors.push(alias + ' 必须是字符串');
    } else if (args[canonical] === undefined) {
      args[canonical] = value;
    } else if (args[canonical] !== value) {
      errors.push(`参数 ${canonical} 和旧别名 ${alias} 的值冲突，请只保留 ${canonical}`);
    }
    delete args[alias];
  }
  if (errors.length) return errors;
  if (legacyAction) {
    if (args.action !== undefined && args.action !== legacyAction) {
      return ['该旧工具名只支持 action=' + legacyAction];
    }
    args.action = legacyAction;
  }

  switch (name) {
    case 'minimax_session':
      if (args.count !== undefined && (!Number.isInteger(args.count) || args.count < 1 || args.count > 20)) {
        return ['count 必须是 1 到 20 的整数'];
      }
      if (args.action === 'tail' || (args.action === undefined && args.count !== undefined &&
          args.sessionId === undefined && args.query === undefined)) {
        args.action = 'list';
        args.limit = args.count ?? args.limit ?? 3;
        args.perSession ??= 2;
      }
      delete args.count;
      args.action ??= args.sessionId !== undefined ? 'read' : args.query !== undefined ? 'search' : 'list';
      break;
    case 'minimax_agent':
      args.action ??= args.message !== undefined || args.send === true || args.newSession === true ? 'send' : 'result';
      if (args.preview === true && args.action !== 'send') return ['preview 仅用于 send'];
      if (args.action === 'stop' && args.sessionId === undefined && callerName !== 'minimax_stop_generation') {
        return ['stop 需要目标 sessionId'];
      }
      break;
    case 'minimax_bot':
      if (args.action === 'resume_pending') args.action = 'resume';
      args.action ??= args.text !== undefined ? 'send' : args.target !== undefined || callerName === 'minimax_bot_message' ? 'read' : 'roster';
      if (args.action === 'answer' && args.answers && typeof args.answers === 'object' && !Array.isArray(args.answers)) {
        args.answers = Object.entries(args.answers).map(([stepId, value]) => ({
          stepId,
          selectedOptionIds: typeof value === 'string' ? [value] : value,
        }));
      }
      break;
    case 'minimax_questionnaire':
      if (args.action === 'draft') {
        args.action = 'answer';
        args.preview = true;
      }
      args.action ??= args.requestId !== undefined || args.selections !== undefined || args.preview === false ? 'answer' : 'list';
      if (Array.isArray(args.selections)) {
        args.selections = args.selections.map((selection) => {
          if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return selection;
          const { selectedOptionIds, ...rest } = selection;
          if (rest.optionIds === undefined && selectedOptionIds !== undefined) rest.optionIds = selectedOptionIds;
          if (rest.selectedOther === true && rest.optionIds === undefined) rest.optionIds = [];
          return rest;
        });
      }
      break;
    case 'minimax_desktop':
      args.action ??= args.mode !== undefined || args.width !== undefined ? 'screenshot' : 'activate';
      break;
  }
  return errors;
}

const TOOL_BY_NAME = new Map(ALL_TOOLS.map((tool) => [tool.name, tool]));
const LEGACY_AGENT_FIELDS = { at: { type: 'string' }, quietSeconds: { type: 'integer', minimum: 0 } };

function auditLevel(name, args) {
  switch (name) {
    case 'minimax_agent':
      if (args.action === 'result' || (args.action === 'send' && args.preview)) return 'read';
      return args.action === 'send' && args.send ? 'commit' : 'ui';
    case 'minimax_bot':
      if (['roster', 'read'].includes(args.action)) return 'read';
      return args.action === 'open' ? 'ui' : 'commit';
    case 'minimax_questionnaire':
      return args.action === 'list' || args.preview ? 'read' : 'commit';
    case 'minimax_desktop':
      return args.action === 'windows' ? 'read' : 'ui';
    case 'minimax_watch':
      return args.action === 'status' || (args.action === 'config' && !args.policy) ||
        ((args.action ?? 'tick') === 'tick' && args.dryRun) ? 'read' : 'commit';
    default:
      return ann.levelOf(name);
  }
}

async function callTool(name, args = {}, ctx = null) {
  const started = Date.now();
  const callerName = name;
  const legacy = Object.hasOwn(LEGACY_TOOLS, name) ? LEGACY_TOOLS[name] : null;
  if (legacy) [name] = legacy;
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return fail('未知工具: ' + name);
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return fail('参数必须是对象');

  args = { ...args };
  const normalizationErrors = normalizeArgs(name, args, legacy?.[1], callerName);
  if (normalizationErrors.length) return fail(normalizationErrors.join('\n'));
  const schema = name === 'minimax_agent'
    ? { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, ...LEGACY_AGENT_FIELDS } }
    : tool.inputSchema;
  const validation = validateArgs({ inputSchema: schema }, args);
  if (!validation.ok) return fail('参数不合法，未执行：\n- ' + validation.errors.join('\n- '));
  args = validation.args;

  const level = auditLevel(name, args);
  const operationId = level === 'commit' ? audit.admit({ tool: callerName, level, args }) : null;
  if (level === 'commit' && !operationId) {
    return fail('审计日志不可写，已阻止提交。修复本地审计日志后再调用。', {
      code: 'AUDIT_UNAVAILABLE',
      executed: false,
    });
  }

  const result = await dispatch(name, args, ctx);
  if (level !== 'read') {
    const payload = parsePayload(result);
    const recorded = audit.record({
      tool: callerName, level, args, ms: Date.now() - started,
      ...(operationId ? { phase: 'outcome', operationId } : {}),
      ok: result.isError !== true && payload?.verified !== false,
      target: payload && (payload.inputAt || payload.clicked || payload.sessionId)
        ? { at: payload.inputAt, clicked: payload.clicked, sessionId: payload.sessionId }
        : undefined,
      error: result.isError ? payload?.error : undefined,
    });
    if (operationId && !recorded) {
      // A driver may already have committed the action. Preserve its outcome
      // and expose the audit failure without telling the caller to retry.
      return {
        ...result,
        content: [{ type: 'text', text: JSON.stringify({
          ...payload, audit: { state: 'outcome-unavailable', operationId },
        }) }],
      };
    }
  }
  return result;
}

function isKnownTool(name) {
  return TOOL_BY_NAME.has(name) || Object.hasOwn(LEGACY_TOOLS, name);
}

function parsePayload(result) {
  try {
    return JSON.parse(result.content[0].text);
  } catch {
    return null;
  }
}

module.exports = { callTool, isKnownTool, READONLY, setTasksEnabled };
