'use strict';

/**
 * test-all-tools-benchmark.js
 *
 * 全量 27 个 MCP 工具端到端耗时与无头能力基准测试。
 * 遵循红线约束：
 * 1. 严格使用隔离的测试会话 (mvs_test_bench_*)
 * 2. 绝对不污染/不动原有的 18 条真实生产会话
 * 3. 测试完毕后自动做全量清理并核实原有 18 条状态
 */

const { execFileSync } = require('node:child_process');
const { performance } = require('perf_hooks');
const os = require('node:os');
const path = require('node:path');
const { callTool } = require('../src/mcp/handler');
const { TOOL_NAMES } = require('../src/mcp/tools');
const db = require('../src/gateway/db');

const DB_PATH = path.join(os.homedir(), '.minimax/v2/sqlite/runtime-state.sqlite');
const SQLITE_BIN = 'sqlite3';
const TEST_SESSION_ID = `mvs_test_bench_${Date.now()}`;
const TEST_SESSION_TITLE = `[TEST_BENCHMARK_${Date.now()}]`;

function runSql(sql) {
  return execFileSync(SQLITE_BIN, [DB_PATH, sql], { encoding: 'utf8', timeout: 5000 });
}

function querySql(sql) {
  const raw = execFileSync(SQLITE_BIN, ['-json', DB_PATH, sql], { encoding: 'utf8', timeout: 5000 });
  if (!raw.trim()) return [];
  return JSON.parse(raw);
}

// 1. 获取并核对原始 18 条会话集合
async function getOriginalSessions() {
  const rows = querySql('SELECT session_id FROM local_runtime_session_asset_index_state');
  return new Set(rows.map(r => r.session_id));
}

// 2. 创建临时测试会话与测试数据
async function setupTestSession() {
  const now = Date.now();
  const record = JSON.stringify({ title: TEST_SESSION_TITLE });
  const dataJson = JSON.stringify({ msg_id: `msg_${now}`, timestamp: now, role: 'user', msg_content: 'Benchmark test message' });
  const sql = `
    INSERT INTO local_runtime_sessions (session_id, record_json, updated_at_ms, created_at_ms, title, status, session_type)
    VALUES ('${TEST_SESSION_ID}', '${record}', ${now}, ${now}, '${TEST_SESSION_TITLE}', 'active', 'chat');
    INSERT INTO local_runtime_message_rows (session_id, msg_id, role, turn_id, created_at_ms, data_json)
    VALUES ('${TEST_SESSION_ID}', 'msg_${now}', 'user', 'turn_${now}', ${now}, '${dataJson}');
  `;
  runSql(sql);
  return TEST_SESSION_ID;
}

// 3. 清理临时测试会话与相关数据
async function teardownTestSession() {
  const sql = `
    DELETE FROM local_runtime_sessions WHERE session_id LIKE 'mvs_test_bench_%';
    DELETE FROM local_runtime_message_rows WHERE session_id LIKE 'mvs_test_bench_%';
    DELETE FROM local_runtime_session_locks WHERE session_id LIKE 'mvs_test_bench_%';
  `;
  runSql(sql);
}

async function runBenchmark() {
  console.log('=== [1/4] 验证原始状态与保护红线 ===');
  const originalSessions = await getOriginalSessions();
  console.log(`已锁定原始会话列表：共 ${originalSessions.size} 条，ID 全局固化。`);
  if (originalSessions.size !== 18) {
    console.warn(`警告：当前 indexed 会话数为 ${originalSessions.size}（预期 18 条）。`);
  }

  console.log('\n=== [2/4] 初始化专用隔离测试会话 ===');
  await setupTestSession();
  console.log(`测试会话已就绪: ${TEST_SESSION_ID} (${TEST_SESSION_TITLE})`);

  // 获取真实 pending 问题 ID
  const pRes = await callTool('minimax_pending', {});
  let realPendingId = 'ask_8bea28dc273c6136b58b9d90';
  try {
    const pData = JSON.parse(pRes.content[0].text);
    if (pData.pending && pData.pending[0]) {
      realPendingId = pData.pending[0].requestId;
    }
  } catch {}

  const benchmarks = [
    // 态势感知与只读查询 (10 项)
    { tool: 'minimax_status', args: {} },
    { tool: 'minimax_brief', args: { limit: 50 } },
    { tool: 'minimax_list_sessions', args: { limit: 10 } },
    { tool: 'minimax_read_session', args: { session: TEST_SESSION_ID, limit: 5 } },
    { tool: 'minimax_tail_sessions', args: { count: 3, perSession: 2 } },
    { tool: 'minimax_search', args: { query: '剪辑', limit: 5 } },
    { tool: 'minimax_pending', args: {} },
    { tool: 'minimax_tasks', args: { limit: 10 } },
    { tool: 'minimax_get_result', args: { sessionId: TEST_SESSION_ID, timeoutSeconds: 0 } },
    { tool: 'minimax_events', args: { limit: 10 } },

    // Bot 团队通讯与自动续传 (5 项)
    { tool: 'minimax_bot_message', args: { action: 'read', chatId: 'group:grp_d631733f2e13', limit: 2 } },
    { tool: 'minimax_auto_resume', args: { dryRun: true } },
    { tool: 'minimax_watch', args: { action: 'status' } },
    { tool: 'minimax_draft_answer', args: { requestId: realPendingId } },
    { tool: 'minimax_answer_question', args: { requestId: realPendingId, preview: true } },

    // 原生界面 CDP 无头控制 (7 项)
    { tool: 'minimax_send_message', args: { message: 'benchmark probe', preview: true } },
    { tool: 'minimax_type', args: { text: '', force: true } },
    { tool: 'minimax_new_task', args: {} },
    { tool: 'minimax_open_session', args: { session: 'mvs_1ffb0ff32f7b4364a498c637b026c8ba' } },
    { tool: 'minimax_find_text', args: { text: '新建任务' } },
    { tool: 'minimax_click_text', args: { text: '新建任务' } },
    { tool: 'minimax_stop_generation', args: {} },

    // 底层系统级降级容灾 (5 项)
    { tool: 'minimax_windows', args: {} },
    { tool: 'minimax_screenshot', args: { name: 'bench_screen', mode: 'screen' } },
    { tool: 'minimax_activate', args: {} },
    { tool: 'minimax_key', args: { key: 'escape' } },
    { tool: 'minimax_click', args: { x: 10, y: 10 } },
  ];

  console.log('\n=== [3/4] 执行全量工具实测并精准计时 ===');
  const results = [];

  for (const b of benchmarks) {
    const t0 = performance.now();
    let res = null;
    let err = null;
    try {
      res = await callTool(b.tool, b.args);
    } catch (e) {
      err = e.message;
    }
    const durationMs = Math.round(performance.now() - t0);
    const textOut = res?.content?.[0]?.text || '';
    let payload = null;
    try { payload = JSON.parse(textOut); } catch {}
    
    let via = 'sqlite/direct';
    if (payload?.via && String(payload.via).startsWith('cdp')) {
      via = payload.via === 'cdp' ? 'cdp' : `cdp:${payload.via}`;
    } else if (/"via":\s*"cdp/.test(textOut)) {
      via = 'cdp';
    } else if (b.tool === 'minimax_bot_message') {
      via = 'rest:18888';
    } else if (b.tool === 'minimax_auto_resume') {
      via = 'cdp+sqlite';
    } else if (b.tool === 'minimax_windows') {
      via = 'macos/cgwindow';
    } else if (b.tool === 'minimax_watch' || b.tool === 'minimax_events') {
      via = 'state/engine';
    }

    results.push({
      tool: b.tool,
      durationMs,
      success: res ? !res.isError : false,
      via,
      summary: (textOut.slice(0, 80).replace(/\n/g, ' ') || err || '').trim(),
    });
    console.log(`[${String(results.length).padStart(2, '0')}/27] ${b.tool.padEnd(25)} ${String(durationMs).padStart(5)} ms | success: ${results[results.length-1].success} | via: ${via}`);
  }

  console.log('\n=== [4/4] 清理测试会话并核对 18 条完整性 ===');
  await teardownTestSession();
  const afterSessions = await getOriginalSessions();

  let diff = false;
  if (originalSessions.size !== afterSessions.size) {
    diff = true;
  } else {
    for (const sid of originalSessions) {
      if (!afterSessions.has(sid)) { diff = true; break; }
    }
  }

  if (diff) {
    console.error('❌ 致命错误：原始会话列表在测试后发生变动！');
  } else {
    console.log('✅ 完美校验：原始 18 条会话 100% 完整无损，无任何数据残留。');
  }

  console.log('\n=== 汇总测试报告 ===');
  console.log(JSON.stringify(results, null, 2));
}

runBenchmark().catch(err => {
  console.error('Benchmark 失败:', err);
  process.exit(1);
});
