'use strict';
/**
 * resume.js — 断点续传与队列自愈核心模块：
 * 自动识别因额度耗尽(2056/42212)或引擎熔断(turn-final-failure)挂起的会话，
 * 并在额度恢复后自动解除死锁、恢复队列派发。
 *
 * 核心机制：
 * 1. 会话类型多模态适配：
 *    - channel (Telegram/飞书等 IM 渠道)：清理 SQLite 队列暂停记录(local_runtime_queue_pauses)，触发 IM 轮询消费积压消息；
 *    - native (主工作区原生对话)：点击界面上的「继续队列消息」或「继续执行」按键触发原生渲染层恢复；
 *    - bot (MiniMax Bot 团队对话)：定位具体专家或通过 Bot 调度接口恢复。
 * 2. 状态探测与幂等防重：
 *    - 依赖 cdp.getQuotaStatus() 确认 isLimited === false；
 *    - 单一额度重置周期内对同一会话执行冷却防重，支持指定 sessionId 强制处理；
 *    - 严格自闭环：动作完成后自动释放 CDP 连接，杜绝后台进程泄漏。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const db = require('./db');
const { cdp } = require('./cdp');
const { botClient } = require('./bot');

const BOT_STATE_PATH = path.join(os.homedir(), '.minimax/v2/plugin-data/liveboards/minimax-bot/state.json');
const RESUME_STATE_PATH = path.join(os.homedir(), '.minimax-mcp/resume-history.json');

function loadBotRegistry() {
  const map = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(BOT_STATE_PATH, 'utf8'));
    for (const [scope, subMap] of Object.entries(raw.sessions || {})) {
      for (const [botId, sub] of Object.entries(subMap)) {
        if (sub && sub.sessionId) {
          map.set(sub.sessionId, { scope, botId });
        }
      }
    }
  } catch {}
  return map;
}

function loadResumeHistory() {
  try {
    return JSON.parse(fs.readFileSync(RESUME_STATE_PATH, 'utf8'));
  } catch {
    return { lastResetCheck: 0, resumed: {} };
  }
}

function saveResumeHistory(history) {
  try {
    fs.mkdirSync(path.dirname(RESUME_STATE_PATH), { recursive: true });
    fs.writeFileSync(RESUME_STATE_PATH, `${JSON.stringify(history, null, 2)}\n`);
  } catch {}
}

/**
 * 扫描当前所有因 2056 / Token Plan 额度耗尽、或队列处于暂停/积压状态的会话。
 */
function scanQuotaSessions(limit = 50) {
  const botMap = loadBotRegistry();
  const rows = db.query(
    'SELECT DISTINCT ' +
    '  s.session_id, s.title, s.workspace_dir, s.status, s.error_message, s.updated_at_ms, ' +
    '  qp.cause as pause_cause, qp.trigger_turn_id as pause_turn_id, qp.paused_at_ms as pause_time_ms, ' +
    '  (SELECT count(*) FROM local_runtime_queue_items q WHERE q.session_id = s.session_id AND q.status = \'queued\') as queued_count, ' +
    '  (SELECT m.role FROM local_runtime_message_rows m WHERE m.session_id = s.session_id ORDER BY m.id DESC LIMIT 1) as last_role, ' +
    '  (SELECT substr(json_extract(m.data_json,\'$.msg_content\'),1,200) FROM local_runtime_message_rows m WHERE m.session_id = s.session_id ORDER BY m.id DESC LIMIT 1) as last_text, ' +
    '  (SELECT source FROM local_runtime_queue_items q WHERE q.session_id = s.session_id LIMIT 1) as queue_source ' +
    'FROM local_runtime_sessions s ' +
    'LEFT JOIN local_runtime_queue_pauses qp ON qp.session_id = s.session_id ' +
    'WHERE s.archived = 0 ' +
    '  AND ( ' +
    '    qp.session_id IS NOT NULL ' +
    '    OR s.error_message LIKE \'%2056%\' ' +
    '    OR s.error_message LIKE \'%Token Plan%\' ' +
    '    OR s.error_code = 42212 ' +
    '    OR EXISTS (SELECT 1 FROM local_runtime_queue_items qi WHERE qi.session_id = s.session_id AND qi.status = \'queued\') ' +
    '  ) ' +
    'ORDER BY coalesce(qp.paused_at_ms, s.updated_at_ms) DESC ' +
    'LIMIT ?',
    [limit]
  );

  return rows.map((r) => {
    const isBot = botMap.has(r.session_id) || String(r.workspace_dir || '').includes('minimax-bot');
    const isChannel = Boolean(
      (r.queue_source && String(r.queue_source).startsWith('channel')) ||
      String(r.title || '').includes('/start') ||
      String(r.workspace_dir || '').includes('telegram')
    );
    const botMeta = botMap.get(r.session_id);

    let type = 'native';
    if (isBot) type = 'bot';
    else if (isChannel) type = 'channel';

    return {
      sessionId: r.session_id,
      title: r.title || '(无标题)',
      type,
      botInfo: botMeta ? { scope: botMeta.scope, botId: botMeta.botId } : null,
      status: r.status,
      errorMessage: r.error_message,
      hasQueuePause: Boolean(r.pause_cause),
      pauseCause: r.pause_cause || null,
      pauseTurnId: r.pause_turn_id || null,
      pausedAtMs: r.pause_time_ms ? Number(r.pause_time_ms) : null,
      queuedCount: Number(r.queued_count || 0),
      lastRole: r.last_role || null,
      lastText: String(r.last_text || '').replace(/\s+/g, ' ').trim(),
      updatedAtMs: Number(r.updated_at_ms),
    };
  });
}

/**
 * 执行断点续传与队列自愈（单会话或批量）。
 */
async function autoResume({ dryRun = true, limit = 5, sessionId = null } = {}) {
  let quota = { isLimited: false, resetAt: null };
  try {
    if (await cdp.isAvailable()) {
      quota = await cdp.getQuotaStatus();
    }
  } catch {}

  const allHalted = scanQuotaSessions(50);
  const targetSessions = sessionId
    ? allHalted.filter((s) => s.sessionId === sessionId)
    : allHalted;

  if (!targetSessions.length) {
    cdp.close();
    return {
      ok: true,
      quotaAvailable: !quota.isLimited,
      quotaStatus: quota,
      resumedCount: 0,
      sessions: [],
      message: sessionId ? `未找到会话 ${sessionId} 的额度阻断或队列暂停记录` : '当前没有因额度耗尽或熔断挂起的会话',
    };
  }

  // 额度受限时，若非 dryRun 预览则直接返回阻断原因及精准唤醒时间
  if (quota.isLimited && !dryRun) {
    cdp.close();
    return {
      ok: false,
      reason: 'quota_exhausted',
      quotaStatus: quota,
      resetAtMs: quota.resetAtMs || null,
      waitSeconds: quota.waitSeconds || null,
      candidateSessions: targetSessions.map((s) => ({
        sessionId: s.sessionId,
        title: s.title,
        type: s.type,
        hasQueuePause: s.hasQueuePause,
        queuedCount: s.queuedCount,
        lastText: s.lastText.slice(0, 80),
      })),
      message: `Token Plan 额度仍处于受限状态（重置时间：${quota.resetAt || '待定'}，预计剩余 ${quota.waitSeconds ? Math.ceil(quota.waitSeconds / 60) + ' 分钟' : '未知'}）。将在额度恢复后精准自动唤醒。`,
    };
  }

  const history = loadResumeHistory();
  const results = [];
  let actionCount = 0;

  try {
    for (const s of targetSessions) {
      if (actionCount >= limit) break;
      const lastResumedAt = history.resumed[s.sessionId] || 0;
      // 智能冷却保护：
      // 1. 若会话在上次恢复后有新消息、新状态变更或新发生熔断（updated/paused > lastResumedAt），立即放行；
      // 2. 否则保持 180 秒（3 分钟）防重抖动冷却，避免短时间内同一会话反复重试；
      // 3. 显式传 sessionId 或处于 dryRun 预览时不拦截。
      const hasNewActivity = (s.updatedAtMs && s.updatedAtMs > lastResumedAt) || (s.pausedAtMs && s.pausedAtMs > lastResumedAt);
      const inCooldown = !sessionId && !dryRun && !hasNewActivity && (Date.now() - lastResumedAt < 180 * 1000);
      if (inCooldown) {
        results.push({
          sessionId: s.sessionId,
          title: s.title,
          type: s.type,
          skipped: true,
          reason: '该会话已在当前周期内恢复过（冷却中，剩余 ' + Math.ceil((180 * 1000 - (Date.now() - lastResumedAt)) / 1000) + 's）',
        });
        continue;
      }

      if (dryRun) {
        let action = 'cdp_click_play_button';
        let note = '原生对话：点击 ▶ 播放键原生继续';
        if (s.hasQueuePause) {
          action = 'unpause_queue_and_resume';
          note = `解除引擎级 ${s.pauseCause || 'turn-final-failure'} 熔断锁，派发积压的 ${s.queuedCount} 条消息`;
        } else if (s.type === 'bot') {
          action = 'bot_trigger_resume';
          note = 'Bot 对话：通过调度接口推进';
        } else if (s.type === 'channel') {
          action = 'unpause_channel_queue';
          note = `Channel 渠道：解除队列暂停，排队消息数: ${s.queuedCount}`;
        }

        results.push({
          sessionId: s.sessionId,
          title: s.title,
          type: s.type,
          hasQueuePause: s.hasQueuePause,
          queuedCount: s.queuedCount,
          planned: true,
          action,
          note,
        });
        actionCount++;
        continue;
      }

      // 真正执行自愈/恢复动作
      try {
        let unpausedDb = false;
        // 1. 如果存在数据库级别的队列暂停锁，先安全解除
        if (s.hasQueuePause) {
          try {
            db.execute('DELETE FROM local_runtime_queue_pauses WHERE session_id = ?', [s.sessionId]);
            db.execute("UPDATE local_runtime_sessions SET status = 'idle', error_message = NULL, error_code = NULL WHERE session_id = ? AND status = 'error'", [s.sessionId]);
            unpausedDb = true;
          } catch (dbErr) {
            console.error('Failed to clear queue pause in sqlite:', dbErr.message);
          }
        }

        if (s.type === 'bot') {
          // Bot 会话：通过 Bot Client 触发继续
          const scope = s.botInfo?.scope || 'group:grp_d631733f2e13';
          const resumed = await botClient.resumePending(scope).catch((e) => ({ error: e.message }));
          const isConflict = Boolean(resumed.error && resumed.error.includes('409'));
          results.push({
            sessionId: s.sessionId,
            title: s.title,
            type: 'bot',
            ok: !resumed.error || isConflict,
            unpausedDb,
            action: 'bot_resume_pending',
            detail: isConflict ? { note: '会话已处于空闲就绪状态，无挂起阻塞消息 (409)' } : resumed,
          });
        } else {
          // Native 原生对话 或 Channel 渠道对话：通过 CDP 点击唤醒渲染层
          let clicked = null;
          if (await cdp.isAvailable()) {
            // 切换到目标会话
            const meta = db.sessionMeta(s.sessionId);
            const cands = [meta?.title, meta?.firstUserMessage, s.title]
              .map((str) => String(str || '').trim())
              .filter((str) => str.length >= 2);

            await cdp.evaluate(`
              (() => {
                const cands = ${JSON.stringify(cands)}.map(x => x.toLowerCase());
                const items = Array.from(document.querySelectorAll('*')).filter(el => {
                  return el.children.length === 0 && el.innerText && el.innerText.trim();
                });
                for (const el of items) {
                  const t = el.innerText.trim().toLowerCase();
                  if (cands.some(c => t.includes(c.slice(0, 10)) || c.includes(t.slice(0, 10)))) {
                    const clickable = el.closest('button, a, [role="button"], div[tabindex], div[class*="item"]') || el.parentElement || el;
                    clickable.click();
                    return true;
                  }
                }
                return false;
              })()
            `);

            // 点击恢复按钮（涵盖队列暂停恢复按键与主输入框恢复按键）
            clicked = await cdp.clickElement({
              selector: "button[aria-label='继续队列消息'], [data-testid='queue-toggle'] button, [data-testid='pending-queue'] button, [aria-label*='继续队列'], [data-testid='continue-button'], [aria-label*='继续执行'], [data-testid='regenerate-button'], [aria-label*='继续'], [data-testid='send-button']"
            });
          }

          results.push({
            sessionId: s.sessionId,
            title: s.title,
            type: s.type,
            ok: unpausedDb || (clicked && clicked.ok),
            unpausedDb,
            clickedUi: clicked && clicked.ok,
            action: unpausedDb ? 'unpaused_queue_and_clicked_ui' : 'clicked_continue_button',
            detail: clicked,
          });
        }

        history.resumed[s.sessionId] = Date.now();
        actionCount++;
      } catch (err) {
        results.push({
          sessionId: s.sessionId,
          title: s.title,
          type: s.type,
          ok: false,
          error: err.message,
        });
      }
    }
  } finally {
    cdp.close();
  }

  if (!dryRun) {
    saveResumeHistory(history);
  }

  return {
    ok: true,
    dryRun,
    quotaAvailable: true,
    quotaStatus: quota,
    resumedCount: actionCount,
    results,
  };
}

module.exports = {
  scanQuotaSessions,
  autoResume,
};
