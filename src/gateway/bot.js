'use strict';
/**
 * bot.js — MiniMax Bot 本地服务通信客户端。
 *
 * 通过 miniapp-remote-proxy (http://127.0.0.1:18888) 或直连本地 MiniMax Bot Mini App，
 * 提供群聊消息收发、问卷答复、轮次取消与状态监控。
 */

const DEFAULT_GATEWAY = process.env.MINIMAX_BOT_GATEWAY || 'http://127.0.0.1:18888';

class MiniMaxBotClient {
  constructor(baseUrl = DEFAULT_GATEWAY) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async getState() {
    const res = await fetch(`${this.baseUrl}/api/state`);
    if (!res.ok) throw new Error(`获取 Bot 状态失败: HTTP ${res.status}`);
    return await res.json();
  }

  async listMessages(chatId = 'group:grp_d631733f2e13', limit = 20) {
    const res = await fetch(`${this.baseUrl}/api/chats/${chatId}/messages?limit=${limit}`);
    if (!res.ok) throw new Error(`获取消息失败 (${chatId}): HTTP ${res.status}`);
    return await res.json();
  }

  async sendMessage(chatId, text) {
    if (!chatId || !text) throw new Error('chatId 和 text 不能为空');
    const res = await fetch(`${this.baseUrl}/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`发送消息失败 (${chatId}): HTTP ${res.status}`);
    return await res.json();
  }

  async cancelTurn(chatId) {
    if (!chatId) throw new Error('chatId 不能为空');
    const res = await fetch(`${this.baseUrl}/api/chats/${chatId}/cancel`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`取消轮次失败 (${chatId}): HTTP ${res.status}`);
    return await res.json();
  }

  async resumePending(chatId) {
    if (!chatId) throw new Error('chatId 不能为空');
    const res = await fetch(`${this.baseUrl}/api/chats/${chatId}/resume-pending`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`恢复待处理消息失败 (${chatId}): HTTP ${res.status}`);
    return await res.json();
  }

  async answerQuestion(chatId, messageId, answers) {
    if (!chatId || !messageId || !answers) throw new Error('chatId, messageId, answers 均不能为空');
    const res = await fetch(`${this.baseUrl}/api/chats/${chatId}/messages/${encodeURIComponent(messageId)}/answer`, {
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
};
