'use strict';
/**
 * bot.js — MiniMax Bot 团队通信客户端与名册解析引擎。
 *
 * 1. 零代理直连：通过 CDP 动态探测 MiniMax Bot 本地服务 (loopback 端口与认证令牌)。
 * 2. 团队名册与人类可读解析：解析 ~/.minimax/v2/plugin-data/liveboards/minimax-bot/state.json，
 *    支持直接使用中文名称（如「剪辑师」、「导演」、「幸喵剪辑室」）分发指令。
 * 3. 双模容灾读取：优先走本地 HTTP 实时 API，若未激活 Webview 则无缝回退至本地磁盘 JSON 归档，
 *    确保 100% 读可靠性。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const BOT_STATE_PATH = path.join(os.homedir(), '.minimax/v2/plugin-data/liveboards/minimax-bot/state.json');
const BOT_MESSAGES_DIR = path.join(os.homedir(), '.minimax/v2/plugin-data/liveboards/minimax-bot/messages');

let cachedPort = null;
let cachedToken = null;
let lastDiscoveryAt = 0;
let discoveryPromise = null;

async function discoverBotTarget(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedPort && cachedToken && (now - lastDiscoveryAt < 60000)) {
    return { port: cachedPort, token: cachedToken };
  }

  if (discoveryPromise) return discoveryPromise;

  discoveryPromise = (async () => {
    try {
      const cdpPort = Number(process.env.MINIMAX_CDP_PORT) || 9223;
      const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
      if (!r || !r.ok) {
        throw new Error('MiniMax CDP 未在线 (端口 ' + cdpPort + ')，无法自动探测 Bot 目标');
      }
      const targets = await r.json();
      const botTarget = targets.find((t) => t.url && t.url.includes('/bot'));
      if (!botTarget) {
        throw new Error('MiniMax Bot webview 尚未在客户端中激活（可通过 CDP 点击「插件・技能」或启动 Bot）');
      }

      const port = new URL(botTarget.url).port;
      const wsUrl = botTarget.webSocketDebuggerUrl;
      if (!wsUrl) throw new Error('Bot target 缺少调试 WebSocket');

      const token = await new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => {
          try { ws.close(); } catch {}
          reject(new Error('捕获 Bot 本地令牌超时 (5s)'));
        }, 5000);

        ws.onopen = () => {
          ws.send(JSON.stringify({ id: 1, method: 'Network.enable' }));
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.id === 1) {
              ws.send(JSON.stringify({
                id: 2,
                method: 'Runtime.evaluate',
                params: { expression: 'fetch("/api/state").then(r => r.status)' },
              }));
            }
            if (msg.method === 'Network.requestWillBeSentExtraInfo') {
              clearTimeout(timer);
              const headers = msg.params.headers || {};
              const captured = headers['x-mavis-miniapp-token'] || headers['X-Mavis-Miniapp-Token'];
              try { ws.close(); } catch {}
              if (captured) resolve(captured);
              else reject(new Error('未在请求头中发现 x-mavis-miniapp-token'));
            }
          } catch (e) {
            clearTimeout(timer);
            try { ws.close(); } catch {}
            reject(e);
          }
        };

        ws.onerror = (err) => {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          reject(err);
        };
      });

      cachedPort = port;
      cachedToken = token;
      lastDiscoveryAt = Date.now();
      return { port, token };
    } finally {
      discoveryPromise = null;
    }
  })();

  return discoveryPromise;
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

  async _request(path, options = {}) {
    let url = '';
    const headers = { ...(options.headers || {}) };

    if (this.customBaseUrl) {
      url = `${this.customBaseUrl}${path}`;
    } else {
      const { port, token } = await discoverBotTarget();
      url = `http://127.0.0.1:${port}${path}`;
      headers['x-mavis-miniapp-token'] = token;
    }

    let res = await fetch(url, { ...options, headers });
    if (res.status === 401 && !this.customBaseUrl) {
      const refreshed = await discoverBotTarget(true);
      headers['x-mavis-miniapp-token'] = refreshed.token;
      url = `http://127.0.0.1:${refreshed.port}${path}`;
      res = await fetch(url, { ...options, headers });
    }
    return res;
  }

  /**
   * 获取团队名册与架构（群聊流水线、成员角色、工具与底层 sessionId 映射）。
   * 优先读磁盘 state.json（极速、免开销、无论 webview 是否运行均可用）。
   */
  getRoster() {
    const state = readBotStateOnDisk();
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
  resolveTarget(target, mode = 'direct') {
    const roster = this.getRoster();
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

    const trimmed = String(target).trim();

    // 1. 直接是 chatId 格式
    if (trimmed.startsWith('group:') || trimmed.startsWith('bot:')) {
      return {
        type: trimmed.startsWith('group:') ? 'group' : 'bot',
        chatId: trimmed,
        id: trimmed.split(':')[1],
        name: trimmed,
      };
    }

    // 2. 匹配群聊名称
    const matchedGroup = roster.groups.find((g) => g.name === trimmed || g.id === trimmed);
    if (matchedGroup) {
      return {
        type: 'group',
        chatId: matchedGroup.chatId,
        id: matchedGroup.id,
        name: matchedGroup.name,
      };
    }

    // 3. 匹配 Bot 成员名称或角色
    const matchedBot = roster.bots.find((b) => b.name === trimmed || b.role === trimmed || b.id === trimmed || (b.name && trimmed.includes(b.name)));
    if (matchedBot) {
      if (mode === 'group') {
        const group = roster.groups[0];
        if (!group) throw new Error('无法在群聊模式中指定 Bot：当前没有配置群聊');
        return {
          type: 'group',
          chatId: group.chatId,
          groupId: group.id,
          groupName: group.name,
          botId: matchedBot.id,
          botName: matchedBot.name,
          prefix: `@${matchedBot.name} `,
          sessionId: matchedBot.groupSessionId,
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

  async getState() {
    try {
      const res = await this._request('/api/state');
      if (res.ok) return await res.json();
    } catch {}
    // 回退磁盘数据
    return readBotStateOnDisk() || { error: 'Bot 本地服务未连接且无本地缓存' };
  }

  async listMessages(chatId = 'group:grp_d631733f2e13', limit = 20) {
    try {
      const res = await this._request(`/api/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}`);
      if (res.ok) {
        const data = await res.json();
        return { source: 'live', chatId, messages: data };
      }
    } catch {
      // 容灾走本地磁盘归档
    }

    const diskMsgs = readMessagesFromDisk(chatId, limit);
    return {
      source: 'disk',
      chatId,
      messages: diskMsgs,
      note: 'Bot 本地 Webview 未激活，已从磁盘数据归档读取历史消息',
    };
  }

  async sendMessage(chatId, text) {
    if (!chatId || !text) throw new Error('chatId 和 text 不能为空');
    try {
      const res = await this._request(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`发送消息失败 (${chatId}): HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      // 若是由于 webview 未激活导致无法发送，给出明确引导
      const roster = this.getRoster();
      const bot = roster.bots.find((b) => b.chatId === chatId || b.directSessionId === chatId);
      let sessionNote = '';
      if (bot && bot.directSessionId) {
        sessionNote = `。提示：该 Bot 对应的 Native Agent 会话 ID 为 ${bot.directSessionId}，你也可以使用 minimax_send_message(sessionId="${bot.directSessionId}") 直接对其驱动执行。`;
      }
      throw new Error(`无法发送消息到 Bot 本地服务: ${err.message}${sessionNote}`);
    }
  }

  async cancelTurn(chatId) {
    if (!chatId) throw new Error('chatId 不能为空');
    const res = await this._request(`/api/chats/${encodeURIComponent(chatId)}/cancel`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`取消轮次失败 (${chatId}): HTTP ${res.status}`);
    return await res.json();
  }

  async resumePending(chatId) {
    if (!chatId) throw new Error('chatId 不能为空');
    const res = await this._request(`/api/chats/${encodeURIComponent(chatId)}/resume-pending`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`恢复待处理消息失败 (${chatId}): HTTP ${res.status}`);
    return await res.json();
  }

  async answerQuestion(chatId, messageId, answers) {
    if (!chatId || !messageId || !answers) throw new Error('chatId, messageId, answers 均不能为空');
    const res = await this._request(`/api/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
    });
    if (!res.ok) throw new Error(`提交问卷回答失败 (${messageId}): HTTP ${res.status}`);
    return await res.json();
  }
}

const defaultBotClient = new MiniMaxBotClient();

module.exports = {
  MiniMaxBotClient,
  botClient: defaultBotClient,
  discoverBotTarget,
};
