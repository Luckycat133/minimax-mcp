#!/usr/bin/env node
/**
 * auto-checkin.js — MiniMax Code 100% 全自动每日签到引擎
 *
 * 双通道高可用架构：
 * 1. 【首选 Headless API 通道】：直接读取本地 ~/.minimax 凭证，无视客户端是否启动，200ms 纯后台静默完成。
 * 2. 【备选 CDP 客户端通道】：若本地凭证过期，自动切换至 CDP 实时环境借用活跃会话完成签到。
 *
 * 保证：
 * - MiniMax Code 关闭状态下依然全自动按时签到
 * - 电脑断网恢复、开机、盒盖唤醒后自动补签
 * - 严格幂等，今日已签绝不重复请求
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { MiniMaxCDPDriver } = require('../src/gateway/cdp');

const HOME = process.env.HOME || '';
const LOG_DIR = path.join(HOME, '.minimax', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'daily-checkin.log');
const AUTH_FILE = path.join(HOME, '.minimax', 'auth', 'prod', 'cn', 'mcode-public', 'auth.json');

const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
const BASE_URL = 'https://agent.minimax.cn';

function log(msg) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false, timeZone: TIMEZONE });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (_) {}
}

/**
 * 从本地 ~/.minimax 凭证库中提取当前有效的 AccessToken
 */
function getLocalAccessToken() {
  try {
    if (!fs.existsSync(AUTH_FILE)) return null;
    const authData = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    const records = authData.records || {};
    for (const key of Object.keys(records)) {
      const rec = records[key];
      if (rec && rec.accessToken) {
        return rec.accessToken;
      }
    }
  } catch (_) {}
  return null;
}

/**
 * 通道 1：Headless API 直接交互（无需运行 MiniMax Code）
 */
async function checkinViaHeadless(token, options = {}) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'token': token,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 MiniMax-Code/3.1.9 (Macintosh; Intel Mac OS X 10_15_7)',
  };

  // 1. 获取签到状态
  const statusUrl = `${BASE_URL}/minimax-cloud/api/v1/signin/status?timezone_id=${encodeURIComponent(TIMEZONE)}`;
  const statusRes = await fetch(statusUrl, { headers });
  if (!statusRes.ok) {
    throw new Error(`HTTP ${statusRes.status} ${statusRes.statusText}`);
  }
  const statusJson = await statusRes.json();
  if (statusJson.base_resp && statusJson.base_resp.status_code !== 0) {
    throw new Error(statusJson.base_resp.status_msg || '获取签到状态接口返回错误');
  }

  const rawData = statusJson.data || {};
  const days = rawData.days || [];
  const today = days.find((d) => d.is_today);
  const dayNo = today?.day_no || '?';
  const points = today?.points || 0;
  const isClaimed = today ? today.status === 3 : false;
  const isClaimable = today ? today.status === 2 : false;

  if (options.statusOnly) {
    log(`【签到查询 (Headless)】第 ${dayNo} 天，今日状态: ${isClaimed ? '已签到' : isClaimable ? '待签到' : '不可签'}，积分: ${points}`);
    return { ok: true, via: 'headless', dayNo, points, claimed: isClaimed, claimable: isClaimable, days };
  }

  if (isClaimed) {
    log(`【今日已签 (Headless)】第 ${dayNo} 天已完成打卡，奖励已入账 (+${points} 积分)`);
    return { ok: true, via: 'headless', action: 'already_claimed', dayNo, points };
  }

  // 2. 执行签到领取
  const claimUrl = `${BASE_URL}/minimax-cloud/api/v1/signin/claim?timezone_id=${encodeURIComponent(TIMEZONE)}`;
  const claimRes = await fetch(claimUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ timezone_id: TIMEZONE }),
  });
  if (!claimRes.ok) {
    throw new Error(`HTTP ${claimRes.status} ${claimRes.statusText}`);
  }
  const claimJson = await claimRes.json();
  if (claimJson.base_resp && claimJson.base_resp.status_code !== 0) {
    throw new Error(claimJson.base_resp.status_msg || '签到领取接口返回错误');
  }

  const claimData = claimJson.data || {};
  const earned = claimData.points || points;
  const curDay = claimData.day_no || dayNo;
  log(`【签到成功 (Headless)】成功领取第 ${curDay} 天奖励 +${earned} 积分！`);
  return { ok: true, via: 'headless', action: 'claimed', dayNo: curDay, points: earned, claimId: claimData.claim_id };
}

/**
 * 通道 2：CDP 客户端环境降级交互（在客户端打开时备用）
 */
async function checkinViaCDP(options = {}) {
  const driver = new MiniMaxCDPDriver();
  const available = await driver.isAvailable();
  if (!available) {
    throw new Error('MiniMax Code 客户端窗口未就绪');
  }

  await driver.connect();
  try {
    const status = await driver.getCheckinStatus();
    if (!status || !status.ok) {
      throw new Error(status?.error || 'CDP 读取状态失败');
    }

    const { today, claimable, claimed } = status;
    const dayNo = today?.day_no || '?';
    const points = today?.points || 0;

    if (options.statusOnly) {
      log(`【签到查询 (CDP)】第 ${dayNo} 天，今日状态: ${claimed ? '已签到' : claimable ? '待签到' : '不可签'}，积分: ${points}`);
      return { ok: true, via: 'cdp', status };
    }

    if (claimed) {
      log(`【今日已签 (CDP)】第 ${dayNo} 天已完成打卡，奖励已入账 (+${points} 积分)`);
      return { ok: true, via: 'cdp', action: 'already_claimed', dayNo, points };
    }

    if (claimable) {
      const claimRes = await driver.claimCheckin();
      if (claimRes && claimRes.ok) {
        log(`【签到成功 (CDP)】成功领取第 ${claimRes.dayNo || dayNo} 天奖励 +${claimRes.points || points} 积分！`);
        return { ok: true, via: 'cdp', action: 'claimed', points: claimRes.points || points, dayNo: claimRes.dayNo || dayNo };
      }
      throw new Error(claimRes?.error || 'CDP 领取接口返回失败');
    }

    return { ok: false, message: '今日不可签到', today };
  } finally {
    driver.close();
  }
}

/**
 * 全自动统一入口
 */
async function runCheckin(options = {}) {
  // 1. 优先尝试 Headless 纯后台静默通道
  const token = getLocalAccessToken();
  if (token) {
    try {
      return await checkinViaHeadless(token, options);
    } catch (err) {
      log(`【Headless 通道失败】${err.message}，尝试切换 CDP 备用通道...`);
    }
  }

  // 2. 备选尝试 CDP 客户端通道
  try {
    return await checkinViaCDP(options);
  } catch (err) {
    log(`【全部通道签到失败】${err.message}`);
    return { ok: false, error: err.message };
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const statusOnly = args.includes('--status') || args.includes('-s');
  runCheckin({ statusOnly }).then((res) => {
    if (args.includes('--json')) console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  });
}

module.exports = { runCheckin };
