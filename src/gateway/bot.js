'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { MiniMaxCDPDriver, cdp } = require('./cdp');
const { requireFront } = require('./desktop');
const db = require('./db');

const BOT_STATE_PATH = path.join(os.homedir(), '.minimax/v2/plugin-data/liveboards/minimax-bot/state.json');
const BOT_MESSAGES_DIR = path.join(os.homedir(), '.minimax/v2/plugin-data/liveboards/minimax-bot/messages');

const BOT_PLUGIN = 'minimax-bot';
const BOT_PATHS = ['/bot', '/bot/'];
const BOT_OPEN_HINT = '先调用 minimax_bot({action:"open"}) 连接 Bot Studio';
const CHAT_ID = /^(?:bot|group):[A-Za-z0-9_]+$/;
const MESSAGE_ID = /^msg_[A-Za-z0-9]+$/;

const botCdp = new MiniMaxCDPDriver({
  targetName: 'Bot Studio',
  matchesTarget: (target) => {
    if (!['page', 'webview'].includes(target.type)) return false;
    if (!URL.canParse(target.url)) return false;
    const url = new URL(target.url);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && BOT_PATHS.includes(url.pathname);
  },
});

function chatPath(chatId, suffix) {
  if (!CHAT_ID.test(chatId)) throw new Error('无效的 Bot chatId，请从名册复制');
  // Bot Studio routes on URL.pathname and expects the colon literally.
  return `/api/chats/${chatId}/${suffix}`;
}

function serviceError(response) {
  return new Error(`Bot Studio 返回 HTTP ${response.status}${response.data?.message ? '，' + response.data.message : ''}`);
}

function presentBotMessage(message) {
  if (message?.role !== 'bot' || message.status !== 'error' ||
      message.errorCode !== 'REQUEST_CANCELLED' || message.sessionId) return message;

  // The Host rejected the request before delivery. Bot Studio 0.7.24 records the
  // rejection as an error. A missing sessionId alone never proves cancellation.
  const { error, errorCode, retryable, retryInput, ...fields } = message;
  return {
    ...fields,
    status: 'aborted',
    cancellation: { phase: 'before-admission', code: errorCode, pluginStatus: 'error' },
  };
}

/**
 * 读取本地 Bot Studio 架构配置 state.json
 */
function readBotStateOnDisk() {
  if (!fs.existsSync(BOT_STATE_PATH)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(BOT_STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

/**
 * 从磁盘读取指定会话的历史消息
 */
function readMessagesFromDisk(chatId, limit = 20) {
  if (!fs.existsSync(BOT_MESSAGES_DIR)) return [];
  const fileName = `${chatId.replace(':', '_')}.json`;
  const filePath = path.join(BOT_MESSAGES_DIR, fileName);
  if (!fs.existsSync(filePath)) return [];

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const messages = JSON.parse(raw);
    if (!Array.isArray(messages)) return [];
    return messages.slice(-limit);
  } catch {
    return [];
  }
}

class MiniMaxBotClient {
  constructor(customBaseUrl = process.env.MINIMAX_BOT_GATEWAY || null) {
    this.customBaseUrl = customBaseUrl ? customBaseUrl.replace(/\/+$/, '') : null;
  }

  async _request(route, method = 'GET', body) {
    const options = {
      method, redirect: 'error', cache: 'no-store',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    };
    if (this.customBaseUrl) {
      const response = await fetch(this.customBaseUrl + route, { ...options, signal: AbortSignal.timeout(3500) });
      return { status: response.status, ok: response.ok, data: await response.json().catch(() => null) };
    }

    // Let Electron authenticate the same-origin request in the registered webview.
    const response = await botCdp.evaluate(`(async ({ route, options, paths }) => {
      if (location.protocol !== 'http:' || location.hostname !== '127.0.0.1' ||
          !paths.includes(location.pathname) || document.title !== 'MiniMax Bot' || !document.querySelector('#side-list')) {
        return { pageUnavailable: true };
      }
      const response = await fetch(route, { ...options, signal: AbortSignal.timeout(3500) });
      return { status: response.status, ok: response.ok, data: await response.json().catch(() => null) };
    })(${JSON.stringify({ route, options, paths: BOT_PATHS })})`).catch((error) => {
      if (error.message.startsWith('CDP discovery failed:')) return { pageUnavailable: true };
      throw error;
    });
    if (response?.pageUnavailable) throw Object.assign(new Error(BOT_OPEN_HINT), { code: 'BOT_PAGE_UNAVAILABLE' });
    if (!response) throw new Error('Bot Studio 未返回可解析的接口响应');
    return response;
  }

  async _get(route, method, body) {
    const response = await this._request(route, method, body);
    if (!response.ok) throw serviceError(response);
    if (!response.data || typeof response.data !== 'object') throw new Error('Bot Studio 返回了未知格式');
    return response.data;
  }

  async open(sessionId, ctx) {
    if (ctx?.shouldStop?.()) throw new Error('客户端已取消打开 Bot Studio');
    const sid = sessionId === undefined ? null : db.resolveSession(sessionId);
    if (sessionId !== undefined && !sid) throw new Error('找不到会话或前缀不唯一，请使用完整 sessionId');
    const isReady = () => this._get('/api/state').then((state) => Array.isArray(state?.bots)).catch(() => false);
    if (await isReady()) return { opened: true, source: 'live', via: this.customBaseUrl ? 'gateway' : 'existing-tab' };
    if (this.customBaseUrl) throw new Error('已配置的 Bot Studio 网关未返回有效状态');
    requireFront();
    if (!await cdp.isAvailable()) throw new Error('打开 Bot Studio 需要 MiniMax CDP 已连接');

    if (sid) {
      if (ctx?.shouldStop?.()) throw new Error('客户端已取消打开 Bot Studio');
      const selected = await cdp.switchSession(sid);
      if (!selected?.ok) throw new Error(selected?.error || '未能打开目标会话');
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const current = await cdp.controlContext(sid);
        if (current?.windowFocused === false) throw new Error('MiniMax 窗口已失去前台焦点');
        if (current?.activeSessionId === sid) break;
        if (attempt === 11) throw new Error('MiniMax 未确认目标会话');
        await delay(150);
      }
    }
    if (ctx?.shouldStop?.()) throw new Error('客户端已取消打开 Bot Studio');
    requireFront();
    const result = await cdp.openMiniApp(BOT_PLUGIN, sid);
    if (result?.code === 'session_not_active') throw new Error('请指定现有原生会话的 sessionId 来打开 Bot Studio');
    if (!result?.success || result.tab?.surfaceKind !== 'miniapp' || result.tab?.miniApp?.pluginId !== BOT_PLUGIN) {
      throw new Error(`MiniMax 未确认 Bot Studio 标签页${result?.code ? '，' + result.code : ''}`);
    }
    const deadline = Date.now() + 4500;
    do {
      if (await isReady()) return { opened: true, source: 'live', via: 'miniapp', tabId: result.tab.tabId };
      if (ctx?.shouldStop?.()) {
        return { opened: true, source: null, tabId: result.tab.tabId, note: '标签页已打开，客户端已取消等待实时服务' };
      }
      await delay(250);
    } while (Date.now() < deadline);
    return { opened: true, source: null, tabId: result.tab.tabId, note: 'Bot Studio 标签页已打开，实时服务尚未确认' };
  }

  /**
   * 获取团队名册与架构（群聊流水线、成员角色、工具与底层 sessionId 映射）。
   * 优先读磁盘 state.json（极速、免开销、无论 webview 是否运行均可用）。
   */
  getRoster(state = readBotStateOnDisk()) {
    if (!state) {
      return {
        groups: [],
        bots: [],
        totalGroups: 0,
        totalBots: 0,
        note: '未在磁盘找到 Bot 状态数据 (~/.minimax/v2/plugin-data/liveboards/minimax-bot/state.json)',
      };
    }

    const groupsRaw = state.groups || [];
    const botsRaw = state.bots || [];
    const sessions = state.sessions || {};

    // 格式化群聊信息
    const groups = groupsRaw.map((g) => {
      let pipeline = null;
      if (g.notice && g.notice.includes('【流水线】')) {
        const match = g.notice.match(/【流水线】\s*\n([^\n]+)/);
        if (match) pipeline = match[1].trim();
      }
      const adminBot = botsRaw.find((b) => b.id === g.adminId);
      const members = (g.memberIds || []).map((mid) => {
        const mb = botsRaw.find((b) => b.id === mid);
        return {
          id: mid,
          name: mb ? mb.name : mid,
          role: mb ? mb.role : '成员',
        };
      });

      return {
        id: g.id,
        chatId: `group:${g.id}`,
        name: g.name,
        pipeline,
        admin: adminBot ? { id: adminBot.id, name: adminBot.name, role: adminBot.role } : { id: g.adminId },
        members,
        notice: g.notice ? g.notice.slice(0, 300) : '',
        replyMode: g.replyMode,
      };
    });

    // 格式化 Bot 成员信息
    const defaultGroupId = groups[0] ? groups[0].id : null;
    const bots = botsRaw.map((b) => {
      // 提取引用的工具
      const tools = [];
      if (b.instructions && b.instructions.includes('davinci_resolve')) {
        tools.push('davinci_resolve');
      }

      // 底层映射的 Native Agent SessionId
      const directSessionId = sessions[`bot:${b.id}`]?.[b.id]?.sessionId || null;
      const groupSessionId = defaultGroupId ? sessions[`group:${defaultGroupId}`]?.[b.id]?.sessionId || null : null;

      return {
        id: b.id,
        chatId: `bot:${b.id}`,
        name: b.name,
        role: b.role || '专家',
        effort: b.effort || 'default',
        tools,
        instructions: b.instructions ? b.instructions.slice(0, 200) + (b.instructions.length > 200 ? '...' : '') : '',
        directSessionId,
        groupSessionId,
      };
    });

    return {
      groups,
      bots,
      totalGroups: groups.length,
      totalBots: bots.length,
      version: state.version,
    };
  }

  /**
   * 将人类可读的名称（如「剪辑师」、「幸喵剪辑室」）解析为内部目标规范。
   */
  resolveTarget(target, mode = 'direct', { exact = false } = {}) {
    const trimmed = String(target ?? '').trim();
    if (trimmed.startsWith('group:') || trimmed.startsWith('bot:')) {
      if (!CHAT_ID.test(trimmed)) throw new Error('无效的 Bot chatId，请从名册复制');
      const [type, id] = trimmed.split(':');
      return { type, chatId: trimmed, id, name: trimmed };
    }
    const state = readBotStateOnDisk();
    const roster = this.getRoster(state);
    if (!target) {
      // 默认第一个群聊
      if (roster.groups.length > 0) {
        return {
          type: 'group',
          chatId: roster.groups[0].chatId,
          id: roster.groups[0].id,
          name: roster.groups[0].name,
        };
      }
      throw new Error('未指定 target 且本地无群聊配置');
    }

    const groups = roster.groups.filter((g) => g.name === trimmed || g.id === trimmed);
    const bots = roster.bots.filter((b) => b.name === trimmed || b.role === trimmed || b.id === trimmed);
    if (exact && groups.length + bots.length > 1) throw new Error('目标名称匹配多个对话，请使用名册中的 chatId');
    const matchedGroup = groups[0];
    if (matchedGroup) {
      return {
        type: 'group',
        chatId: matchedGroup.chatId,
        id: matchedGroup.id,
        name: matchedGroup.name,
      };
    }

    const matchedBot = bots[0] || (!exact && roster.bots.find((b) => b.name && trimmed.includes(b.name)));
    if (matchedBot) {
      if (mode === 'group') {
        const matches = roster.groups.filter((g) => g.members.some((member) => member.id === matchedBot.id));
        if (matches.length !== 1) throw new Error('成员需要唯一的所属群聊。请直接指定群聊 chatId 并在消息中 @成员');
        const [group] = matches;
        return {
          type: 'group',
          chatId: group.chatId,
          groupId: group.id,
          groupName: group.name,
          botId: matchedBot.id,
          botName: matchedBot.name,
          prefix: `@${matchedBot.name} `,
          sessionId: state?.sessions?.[group.chatId]?.[matchedBot.id]?.sessionId || null,
        };
      }

      return {
        type: 'bot',
        chatId: matchedBot.chatId,
        id: matchedBot.id,
        name: matchedBot.name,
        role: matchedBot.role,
        sessionId: matchedBot.directSessionId,
      };
    }

    // 4. 容错尝试模糊匹配
    const botNames = roster.bots.map((b) => b.name).join('、');
    const groupNames = roster.groups.map((g) => g.name).join('、');
    throw new Error(`找不到目标「${trimmed}」。可选群聊: [${groupNames}]；可选成员: [${botNames}]`);
  }

  async listMessages(chatId, limit = 20) {
    const route = chatPath(chatId, `messages?limit=${limit}`);
    let response;
    let reason;
    try {
      response = await this._request(route);
    } catch (error) {
      reason = error.message;
    }
    if (response?.status === 404) throw serviceError(response);
    const { data } = response || {};
    const messages = Array.isArray(data) ? data : data?.messages;
    if (response?.ok && Array.isArray(messages) && (!data.chatId || data.chatId === chatId)) {
      return { source: 'live', chatId, messages: messages.map(presentBotMessage) };
    }

    return {
      source: 'disk',
      chatId,
      messages: readMessagesFromDisk(chatId, limit).map(presentBotMessage),
      note: '实时历史暂不可用，已查询本地缓存。' + (reason || (response?.ok ? '实时服务返回了未知格式' : serviceError(response).message)),
    };
  }

  async sendMessage(chatId, text, clientMessageId = randomUUID()) {
    const route = chatPath(chatId, 'messages');
    const uncertain = (note) => ({ sent: null, verified: false, clientMessageId, note: note + '。请先读历史核对该 clientMessageId' });
    let response;
    try {
      response = await this._request(route, 'POST', { text, clientMessageId });
    } catch (error) {
      if (error.code === 'BOT_PAGE_UNAVAILABLE') throw error;
      return uncertain('未收到 Bot Studio 发送回执');
    }
    if (response.status >= 500 || response.data?.error === 'delivery_uncertain') return uncertain(serviceError(response).message);
    if (!response.ok) throw serviceError(response);
    const message = response.data?.message;
    if (!message?.id || message.chatId !== chatId || message.role !== 'user' ||
        typeof message.text !== 'string' || message.text.trim() !== text.trim() || message.clientMessageId !== clientMessageId) {
      return uncertain('Bot Studio 发送回执与请求不符');
    }
    return { sent: true, verified: true, messageId: message.id, clientMessageId, message };
  }

  cancelTurn(chatId) {
    return this._get(chatPath(chatId, 'cancel'), 'POST');
  }

  resumePending(chatId) {
    return this._get(chatPath(chatId, 'resume-pending'), 'POST');
  }

  async answerQuestion(chatId, messageId, answers) {
    if (!MESSAGE_ID.test(messageId)) throw new Error('无效的 Bot 卡片 messageId');
    const payload = answers.map((answer) => ({ selectedOther: false, ...answer }));
    const data = await this._get(chatPath(chatId, `messages/${messageId}/answer`), 'POST', { answers: payload });
    return { ...data, accepted: data?.ok === true };
  }
}

const defaultBotClient = new MiniMaxBotClient();

module.exports = {
  MiniMaxBotClient,
  botClient: defaultBotClient,
};
