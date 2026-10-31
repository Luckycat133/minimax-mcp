#!/usr/bin/env node
'use strict';
/**
 * watch-tick.js — 跑一轮巡检，给 launchd / cron 用的入口。
 *
 * 为什么单独一个脚本而不是让 MCP 常驻：
 * MCP 是 stdio 的，宿主一关就没了。而"主动"要求人不在的时候它也在跑，
 * 所以必须有个脱离宿主的进程。用 launchd 定时唤醒比常驻进程省电，
 * 也不会因为一次崩溃就永久停掉。
 *
 * 用法:
 *   node scripts/watch-tick.js            # 按默认策略跑一轮
 *   node scripts/watch-tick.js --dry-run  # 只算不做
 *   node scripts/watch-tick.js --quiet    # 无事件时不输出（给定时任务用）
 */

const path = require('node:path');
const { callTool } = require(path.join(__dirname, '..', 'src/mcp/handler'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const quiet = args.includes('--quiet');

// 从环境变量读策略，方便在不改代码的前提下调
const policy = {};
if (process.env.MINIMAX_WATCH_MODE) policy.mode = process.env.MINIMAX_WATCH_MODE;
if (process.env.MINIMAX_WATCH_RISK_CEILING) policy.riskCeiling = process.env.MINIMAX_WATCH_RISK_CEILING;
if (process.env.MINIMAX_WATCH_MIN_IDLE) policy.minIdleSeconds = Number(process.env.MINIMAX_WATCH_MIN_IDLE);
if (process.env.MINIMAX_WATCH_MAX_ACTIONS) policy.maxActionsPerTick = Number(process.env.MINIMAX_WATCH_MAX_ACTIONS);

function main() {
  const res = callTool('minimax_watch', { action: 'tick', dryRun, policy });
  if (res.isError) {
    console.error(res.content[0].text);
    process.exit(1);
  }
  const r = JSON.parse(res.content[0].text);
  const total = r.events.length + r.actions.length + r.needsHuman.length;

  if (quiet && total === 0) return;

  console.log(`[${r.at}] 闲置 ${r.idleSeconds ?? '?'}s | 事件 ${r.events.length} | 动作 ${r.actions.length} | 待处理 ${r.needsHuman.length}`);
  for (const e of r.events) console.log(`  · ${e.type.padEnd(11)} ${String(e.title || '').slice(0, 40)} — ${String(e.detail || '').slice(0, 80)}`);
  for (const a of r.actions) console.log(`  > ${a.tool} ${a.planned ? '(计划)' : a.ok ? '✓' : '✗'} ${a.why || ''}`);
  for (const n of r.needsHuman) console.log(`  ! 需要人：${n.title || n.sessionId} — ${n.why || n.reason}`);
}

main();
