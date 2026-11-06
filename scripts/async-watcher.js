'use strict';

/**
 * async-watcher.js — 异步事件监听器。
 * 
 * 解决 MCP 被动请求-响应机制无法主动推流的问题：
 * 作为后台守护或异步等待任务运行，轮询 MiniMax 本地运行时数据库。
 * 一旦检测到任务完成、新消息输出、提问挂起或状态报错，立即输出结构化事件并退出，
 * 触发宿主系统的 Reactive Wakeup（响应式唤醒），使 AI 能够主动向用户汇报。
 */

const db = require('../src/gateway/db');

const targetSessionId = process.argv[2] || null;
const maxWaitSeconds = Number(process.argv[3]) || 3600; // 默认最长守候 1 小时

async function main() {
  const initialMaxId = db.maxMessageId();
  const recent = targetSessionId 
    ? { sessionId: targetSessionId, title: targetSessionId, status: db.sessionMeta(targetSessionId)?.status || 'idle' }
    : (db.recentlyTouchedSessions(1)[0] || { status: 'idle' });
  
  const initialStatus = recent.status || 'idle';
  const initialPendingCount = (db.pending() || []).length;
  const startedAt = Date.now();
  const deadline = startedAt + maxWaitSeconds * 1000;

  let currentObservedStatus = initialStatus;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));

    // 1. 检查是否有新的提问挂起
    const currentPending = db.pending() || [];
    if (currentPending.length > initialPendingCount) {
      const q = currentPending[0];
      console.log(JSON.stringify({
        event: 'QUESTION_PENDING',
        requestId: q.requestId,
        sessionId: q.sessionId,
        title: q.title,
        message: 'MiniMax 出现待回答的人工问卷'
      }));
      process.exit(0);
    }

    // 2. 检查会话状态变化
    const curRecent = targetSessionId
      ? { sessionId: targetSessionId, title: targetSessionId, status: db.sessionMeta(targetSessionId)?.status || 'idle' }
      : (db.recentlyTouchedSessions(1)[0] || { status: 'idle' });

    if (!curRecent) continue;

    // 跟踪状态转移
    if (curRecent.status === 'started' && currentObservedStatus !== 'started') {
      currentObservedStatus = 'started';
    } else if (currentObservedStatus === 'started' && curRecent.status !== 'started') {
      // 运行中的任务闭环了（变成 idle 或 error）
      const msgs = db.readSession(curRecent.sessionId, 1);
      const lastMsg = msgs.messages?.[0]?.content || '';
      console.log(JSON.stringify({
        event: 'TASK_FINISHED',
        sessionId: curRecent.sessionId,
        title: curRecent.title,
        status: curRecent.status,
        result: lastMsg.slice(0, 500),
        message: `会话「${curRecent.title}」已运行完毕（状态: ${curRecent.status}）`
      }));
      process.exit(0);
    }

    // 3. 检查是否有新的 Assistant 消息落地
    const curMaxId = db.maxMessageId();
    if (curMaxId > initialMaxId) {
      const msgs = db.readSession(curRecent.sessionId, 1);
      const last = msgs.messages?.[0];
      if (last && last.role === 'assistant' && curRecent.status === 'idle') {
        console.log(JSON.stringify({
          event: 'MESSAGE_RECEIVED',
          sessionId: curRecent.sessionId,
          title: curRecent.title,
          status: curRecent.status,
          messageId: last.id,
          result: last.content.slice(0, 500),
          message: `会话「${curRecent.title}」收到新回复`
        }));
        process.exit(0);
      }
    }
  }

  console.log(JSON.stringify({
    event: 'TIMEOUT',
    waitedSeconds: Math.round((Date.now() - startedAt) / 1000),
    message: '等待超时，未检测到新事件'
  }));
  process.exit(0);
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'ERROR', error: String(err && err.message || err) }));
  process.exit(1);
});
