'use strict';
/**
 * bot.js — MiniMax Bot 本地服务通信客户端。
 *
 * 直连本地 MiniMax Bot Mini App（通过 CDP 动态探测 loopback 端口与认证令牌），
 * 杜绝外部常驻代理进程依赖。提供群聊消息收发、问卷答复、轮次取消与状态监控。
 */

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
        throw new Error('MiniMax Bot webview 尚未在客户端中激活（未打开 Bot 标签页）');
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
      // 令牌过期自动刷新重试一次
      const refreshed = await discoverBotTarget(true);
      headers['x-mavis-miniapp-token'] = refreshed.token;
      url = `http://127.0.0.1:${refreshed.port}${path}`;
      res = await fetch(url, { ...options, headers });
    }
    return res;
  }

  async getState() {
    const res = await this._request('/api/state');
    if (!res.ok) throw new Error(`获取 Bot 状态失败: HTTP ${res.status}`);
    return await res.json();
  }

  async listMessages(chatId = 'group:grp_d631733f2e13', limit = 20) {
    const res = await this._request(`/api/chats/${chatId}/messages?limit=${limit}`);
    if (!res.ok) throw new Error(`获取消息失败 (${chatId}): HTTP ${res.status}`);
    return await res.json();
  }

  async sendMessage(chatId, text) {
    if (!chatId || !text) throw new Error('chatId 和 text 不能为空');
    const res = await this._request(`/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`发送消息失败 (${chatId}): HTTP ${res.status}`);
    return await res.json();
  }

  async cancelTurn(chatId) {
    if (!chatId) throw new Error('chatId 不能为空');
    const res = await this._request(`/api/chats/${chatId}/cancel`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`取消轮次失败 (${chatId}): HTTP ${res.status}`);
    return await res.json();
  }

  async resumePending(chatId) {
    if (!chatId) throw new Error('chatId 不能为空');
    const res = await this._request(`/api/chats/${chatId}/resume-pending`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`恢复待处理消息失败 (${chatId}): HTTP ${res.status}`);
    return await res.json();
  }

  async answerQuestion(chatId, messageId, answers) {
    if (!chatId || !messageId || !answers) throw new Error('chatId, messageId, answers 均不能为空');
    const res = await this._request(`/api/chats/${chatId}/messages/${encodeURIComponent(messageId)}/answer`, {
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
