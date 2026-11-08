'use strict';
/**
 * resume.js — 断点续传核心模块：自动识别因额度耗尽停下的会话，并在额度恢复后自动继续。
 *
 * 核心机制：
 * 1. 精准区分会话类型：
 *    - native (主工作区原生对话)：检测发送按键是否转变为 ▶ 播放键，直接点击触发原生恢复，不输入额外文本；
 *    - bot (MiniMax Bot 团队对话)：定位具体专家或通过 Bot 调度接口恢复。
 * 2. 状态探测与幂等防重：
 *    - 依赖 cdp.getQuotaStatus() 确认 isLimited === false；
 *    - 单一额度重置周期内，每个会话仅允许自动恢复 1 次，防止死循环。
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
 * 扫描当前所有因 2056 / Token Plan 额度耗尽而中断的会话。
 */
function scanQuotaSessions(limit = 50) {
  const botMap = loadBotRegistry();
  const rows = db.query(
    'select s.session_id, s.title, s.workspace_dir, s.status, s.error_message, s.updated_at_ms, ' +
    '(select m.role from local_runtime_message_rows m where m.session_id = s.session_id order by m.id desc limit 1) as last_role, ' +
    "(select substr(json_extract(m.data_json,'$.msg_content'),1,200) from local_runtime_message_rows m where m.session_id = s.session_id order by m.id desc limit 1) as last_text " +
    'from local_runtime_sessions s where s.archived = 0 ' +
    "and (s.error_message like '%2056%' or s.error_message like '%Token Plan%') " +
    'order by s.updated_at_ms desc limit ?',
    [limit]
  );

  return rows.map((r) => {
    const isBot = botMap.has(r.session_id) || String(r.workspace_dir || '').includes('minimax-bot');
    const botMeta = botMap.get(r.session_id);
    return {
      sessionId: r.session_id,
      title: r.title || '(无标题)',
      type: isBot ? 'bot' : 'native',
      botInfo: botMeta ? { scope: botMeta.scope, botId: botMeta.botId } : null,
      status: r.status,
      errorMessage: r.error_message,
      lastRole: r.last_role || null,
      lastText: String(r.last_text || '').replace(/\s+/g, ' ').trim(),
      updatedAtMs: Number(r.updated_at_ms),
    };
  });
}

/**
 * 执行断点续传（单会话或批量）。
 */
async function autoResume({ dryRun = true, limit = 5, sessionId = null } = {}) {
  // 1. 检查实时额度状态
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
    return {
      ok: true,
      quotaAvailable: !quota.isLimited,
      quotaStatus: quota,
      resumedCount: 0,
      sessions: [],
      message: sessionId ? `未找到会话 ${sessionId} 的额度阻断记录` : '当前没有因额度耗尽而挂起的会话',
    };
  }

  // 额度受限时，若非强制预览则直接返回阻断原因
  if (quota.isLimited) {
    return {
      ok: false,
      reason: 'quota_exhausted',
      quotaStatus: quota,
      candidateSessions: targetSessions.map((s) => ({
        sessionId: s.sessionId,
        title: s.title,
        type: s.type,
        lastText: s.lastText.slice(0, 80),
      })),
      message: `Token Plan 额度仍处于受限状态（重置时间：${quota.resetAt || '待定'}）。将在额度恢复后自动继续。`,
    };
  }

  const history = loadResumeHistory();
  const results = [];
  let actionCount = 0;

  for (const s of targetSessions) {
    if (actionCount >= limit) break;
    const lastResumedAt = history.resumed[s.sessionId] || 0;
    // 冷却保护：1 小时内对同一会话不重复自动唤醒
    if (!sessionId && Date.now() - lastResumedAt < 3600 * 1000) {
      results.push({
        sessionId: s.sessionId,
        title: s.title,
        type: s.type,
        skipped: true,
        reason: '该会话已在当前周期内恢复过（冷却中）',
      });
      continue;
    }

    if (dryRun) {
      results.push({
        sessionId: s.sessionId,
        title: s.title,
        type: s.type,
        planned: true,
        action: s.type === 'native' ? 'cdp_click_play_button' : 'bot_trigger_resume',
        note: s.type === 'native' ? '原生对话：点击 ▶ 播放键原生继续' : 'Bot 对话：通过调度接口推进',
      });
      actionCount++;
      continue;
    }

    // 真正执行恢复动作
    try {
      if (s.type === 'native') {
        if (!await cdp.isAvailable()) {
          throw new Error('CDP 未就绪，无法派发原生继续动作');
        }

        // 1. 优先确保已切到该会话
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

        // 2. 点击继续执行按钮 (优先匹配 continue-button / 继续执行，备选 regenerate-button / send-button)
        const clicked = await cdp.clickElement({
          selector: "[data-testid='continue-button'], [aria-label*='继续执行'], [data-testid='regenerate-button'], [aria-label*='继续'], [data-testid='send-button']"
        });

        results.push({
          sessionId: s.sessionId,
          title: s.title,
          type: 'native',
          ok: clicked && clicked.ok,
          action: 'clicked_continue_button',
          detail: clicked,
        });
      } else {
        // Bot 会话：通过 Bot Client 触发继续
        const scope = s.botInfo?.scope || 'group:grp_d631733f2e13';
        const resumed = await botClient.resumePending(scope).catch((e) => ({ error: e.message }));
        const isConflict = Boolean(resumed.error && resumed.error.includes('409'));
        results.push({
          sessionId: s.sessionId,
          title: s.title,
          type: 'bot',
          ok: !resumed.error || isConflict,
          action: 'bot_resume_pending',
          detail: isConflict ? { note: '会话已处于空闲就绪状态，无挂起阻塞消息 (409)' } : resumed,
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
