'use strict';
/**
 * edge.test.js — 边界与回归测试。
 *
 * 这里的每一条都对应一个真实踩到的坑。写在这里的目的是：
 * 下次有人"顺手简化"掉这些防御时，测试会立刻红。
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 把数据目录指到临时目录：watch/audit/tasks 会写文件，不隔离就会污染真实状态
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-mcp-test-'));
process.env.MINIMAX_MCP_HOME = TMP_HOME;

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'src/gateway/db'));
const qn = require(path.join(ROOT, 'src/mcp/questionnaire'));

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (err) {
    results.push({ name, pass: false, detail: err.message });
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (err) {
    results.push({ name, pass: false, detail: err.message });
  }
}

/** 从工具返回里取 JSON。 */
function payload(res) {
  return JSON.parse(res.content[0].text);
}

(async () => {
// ---------- SQL 占位符扫描 ----------

  await check('SQL 字面量里的 ? 不会被当成占位符', async () => {
  // 老实现是 sql.replace(/\?/g)，会把 '?' 这个字面量也替换掉，参数直接错位
  const rows = db.query("select '?' as a, ? as b, 'x?y' as c", ['hello']);
  assert.strictEqual(rows[0].a, '?');
  assert.strictEqual(rows[0].b, 'hello');
  assert.strictEqual(rows[0].c, 'x?y');
});

  await check('占位符数量与参数不一致会报错', async () => {
  assert.throws(() => db.query('select ? as a, ? as b', ['only-one']), /占位符/);
  assert.throws(() => db.query('select 1', ['extra']), /占位符/);
});

  await check('字符串参数里的单引号被正确转义', async () => {
  const rows = db.query('select ? as v', ["O'Brien"]);
  assert.strictEqual(rows[0].v, "O'Brien");
});

  await check('注入式参数不会改变语义', async () => {
  const rows = db.query('select ? as v', ["' OR 1=1 --"]);
  assert.strictEqual(rows[0].v, "' OR 1=1 --");
});

// ---------- 结果判定 ----------

  await check('checkResult 对不存在的会话不崩', async () => {
  const r = db.checkResult('mvs_does_not_exist', 0);
  assert.strictEqual(r.done, false);
  assert.strictEqual(r.status, null);
});

  await check('checkResult 结构完整', async () => {
  const sid = db.listSessions(1)[0]?.sessionId;
  assert.ok(sid, '至少应该有一个会话');
  const r = db.checkResult(sid, 0);
  for (const k of ['status', 'lastSeen', 'best', 'done']) {
    assert.ok(k in r, `缺字段 ${k}`);
  }
  assert.strictEqual(typeof r.done, 'boolean');
});

// ---------- 显式会话解析 ----------

  await check('get_result 对不存在的 sessionId 报错，不静默换成别的会话', async () => {
  const { callTool } = require(path.join(ROOT, 'src/mcp/handler'));
  const res = await callTool('minimax_get_result', { sessionId: 'mvs_nope', timeoutSeconds: 1 });
  assert.strictEqual(res.isError, true, '必须报错');
  assert.ok(/找不到会话/.test(payload(res).error), payload(res).error);
});

// ---------- 坐标校验 ----------

  await check('at 格式不对要报错，不能变成 NaN 点出去', async () => {
  const { callTool } = require(path.join(ROOT, 'src/mcp/handler'));
  for (const bad of ['abc', '12,abc', '1,2,3', '', ' -1,5']) {
    const res = await callTool('minimax_send_message', { message: 'x', at: bad, preview: true });
    assert.strictEqual(res.isError, true, `"${bad}" 应该被拒绝`);
  }
});

  await check('合法 at 能通过校验', async () => {
  const { callTool } = require(path.join(ROOT, 'src/mcp/handler'));
  const res = await callTool('minimax_send_message', { message: 'x', at: ' 640 , 880 ', preview: true });
  // preview 是只读的，不该因为坐标合法就真发
  assert.strictEqual(res.isError, false, payload(res).error);
  const p = payload(res);
  if (p.preview) assert.strictEqual(p.inputAt.x, 640);
});

// ---------- 问卷规范化 ----------

  await check('selections 传成字符串不崩，报可读错误', async () => {
  const detail = {
    requestId: 'ask_x', steps: [{ stepId: 's1', options: [{ optionId: 'o1' }], selectionMode: 'single' }],
  };
  const r = qn.normalizeSelections(detail, 'o1');
  assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
});

  await check('selections 传 null 走必答校验', async () => {
  const detail = {
    requestId: 'ask_x', steps: [{ stepId: 's1', options: [{ optionId: 'o1' }], selectionMode: 'single' }],
  };
  const r = qn.normalizeSelections(detail, null);
  assert.ok(r.errors.some((e) => /缺少必答步骤/.test(e)), r.errors.join('|'));
});

  await check('steps 为空的问卷不会崩', async () => {
  const r = qn.normalizeSelections({ requestId: 'ask_x', steps: [] }, []);
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.answers, []);
});

// ---------- 通知必须立刻写出去 ----------

  await check('emit 立刻写 stdout，不等下一次客户端消息', async () => {
  const { emit } = require(path.join(ROOT, 'src/mcp/stdio-server'));
  const orig = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = (chunk) => { captured += chunk; return true; };
  try {
    emit('notifications/tasks/status', { taskId: 't1', status: 'completed' });
  } finally {
    process.stdout.write = orig;
  }
  assert.ok(captured.includes('notifications/tasks/status'), '通知没写出去');
  assert.ok(captured.trim().endsWith('}'), '必须是一整行 JSON');
});

// ---------- 参数校验层 ----------

  await check('未知参数被拒绝', async () => {
  const { callTool } = require(path.join(ROOT, 'src/mcp/handler'));
  const res = await callTool('minimax_status', { 乱传的: 1 });
  assert.strictEqual(res.isError, true);
  assert.ok(/不是这个工具支持的参数/.test(payload(res).error));
});

  await check('类型错误被拒绝且提示类型', async () => {
  const { callTool } = require(path.join(ROOT, 'src/mcp/handler'));
  const res = await callTool('minimax_click', { x: 'abc', y: 1 });
  assert.strictEqual(res.isError, true);
  assert.ok(/类型应为 number/.test(payload(res).error));
});

  await check('超出范围的数字被拒绝', async () => {
  const { callTool } = require(path.join(ROOT, 'src/mcp/handler'));
  const res = await callTool('minimax_search', { query: 'x', limit: 99999 });
  assert.strictEqual(res.isError, true);
  assert.ok(/不能大于/.test(payload(res).error));
});

  await checkAsync('watch 拒绝非法 policy.mode', async () => {
    const { callTool } = require(path.join(ROOT, 'src/mcp/handler'));
    const res = await callTool('minimax_watch', { policy: { mode: '乱来' } });
    assert.strictEqual(res.isError, true);
    assert.ok(/只能是/.test(payload(res).error));
  });

  await checkAsync('read_session 能往前翻页，且页码单调变小', async () => {
    const { callTool } = require(path.join(ROOT, 'src/mcp/handler'));
    const candidate = db.listSessions(10).find((s) => s.messages >= 5);
    const sid = candidate ? candidate.sessionId : db.listSessions(1)[0]?.sessionId;
    const first = payload(await callTool('minimax_read_session', { session: sid, limit: 3 }));
    if (!first.messages || first.messages.length < 2) return; // 会话太短就跳过
    const anchor = first.oldestId;
    const second = payload(await callTool('minimax_read_session', { session: sid, limit: 3, before: anchor }));
    assert.ok(second.messages.length > 0, '翻页不该空');
    for (const m of second.messages) {
      assert.ok(m.id < anchor, `翻页后不该出现 >= ${anchor} 的消息（拿到 ${m.id}）`);
    }
  });

  await checkAsync('events 的 since 非法时明确报错，不静默返回全部', async () => {
    const { callTool } = require(path.join(ROOT, 'src/mcp/handler'));
    const res = await callTool('minimax_events', { since: '不是时间' });
    assert.strictEqual(res.isError, true);
    assert.ok(/不是合法时间/.test(payload(res).error));
  });

  await checkAsync('watch 策略可持久化，且不会冲掉没改的字段', async () => {
    const watch = require(path.join(ROOT, 'src/gateway/watch'));
    const before = watch.loadPolicy();
    try {
      watch.savePolicy({ minIdleSeconds: 45 });
      const mid = watch.loadPolicy();
      assert.strictEqual(mid.minIdleSeconds, 45);
      assert.ok(mid.autoNudge === undefined || typeof mid.autoNudge === 'object');

      // 只改 autoNudge 的一个子字段，别的子字段要保留
      watch.savePolicy({ autoNudge: { cooldownMinutes: 30 } });
      const eff = watch.effectivePolicy();
      assert.strictEqual(eff.autoNudge.cooldownMinutes, 30);
      assert.ok(eff.autoNudge.message, '没改的子字段必须保留默认值');
      assert.strictEqual(eff.minIdleSeconds, 45, '上次写的值要保留');
    } finally {
      // 还原
      const fs = require('node:fs');
      if (Object.keys(before).length === 0) {
        try { fs.rmSync(watch.POLICY_FILE); } catch { /* 忽略 */ }
      } else {
        fs.writeFileSync(watch.POLICY_FILE, JSON.stringify(before, null, 2));
      }
    }
  });

  await checkAsync('搜索能按会话标题命中，且和正文命中区分开', async () => {
    const { callTool } = require(path.join(ROOT, 'src/mcp/handler'));
    const title = db.recentlyTouchedSessions(5).map((x) => x.title).find((t) => t && t.length >= 2);
    if (!title) return;
    const hits = payload(await callTool('minimax_search', { query: title.slice(0, 4), limit: 10 })).hits;
    assert.ok(hits.some((h) => h.kind === 'session'), '应该至少有一条 kind=session 的命中');
    assert.ok(hits.every((h) => h.kind === 'session' || h.kind === 'message'), 'kind 只能是 session/message');
  });

  await checkAsync('搜索空关键词报错，不返回最近若干条冒充结果', async () => {
    const { callTool } = require(path.join(ROOT, 'src/mcp/handler'));
    const res = await callTool('minimax_search', { query: '   ' });
    assert.strictEqual(res.isError, true);
    assert.ok(/不能为空/.test(payload(res).error));
  });

  await checkAsync('卡住的会话会走自动催促，且发的是 send+force', async () => {
    const watch = require(path.join(ROOT, 'src/gateway/watch'));
    const sid = db.listSessions(1)[0]?.sessionId;
    assert.ok(sid, '需要一个真实会话 id');

    const fakeBrief = () => ({
      headline: '', counts: {}, scannedSessions: 1, quietSessions: 0,
      taskFailures: [],
      items: [{ kind: 'stalled', sessionId: sid, title: '测试会话', age: '11 分钟前', why: '末条是用户消息', next: '' }],
    });

    const policy = {
      mode: 'act', minIdleSeconds: 0, maxActionsPerTick: 1,
      autoNudge: { enabled: true, cooldownMinutes: 0, message: '看起来停住了，需要我做什么吗？' },
      allowSessions: [sid],
    };

    // 先 dryRun：只出计划，不执行
    const planned = await watch.tick({ policy, dryRun: true, briefFn: fakeBrief });
    const plan = planned.actions.find((a) => a.tool === 'minimax_send_message');
    assert.ok(plan, '应该有自动催促的计划');
    assert.strictEqual(plan.planned, true, 'dryRun 下必须标 planned');

    // 再真跑：注入假执行器，验证调用形状
    const calls = [];
    const real = await watch.tick({
      policy,
      briefFn: fakeBrief,
      execute: (tool, args) => {
        calls.push({ tool, args });
        return { content: [{ type: 'text', text: JSON.stringify({ sent: true, verified: true, sessionId: sid }) }], isError: false };
      },
    });
    assert.strictEqual(calls.length, 1, '应该只执行一个动作');
    assert.strictEqual(calls[0].tool, 'minimax_send_message');
    assert.strictEqual(calls[0].args.send, true);
    assert.strictEqual(calls[0].args.force, true, '自动催促要绕过活跃守卫，但必须先过 idle 判定');
    assert.ok(real.actions.some((a) => a.ok === true));
  });

  await checkAsync('非 act 模式绝不自动催促', async () => {
    const watch = require(path.join(ROOT, 'src/gateway/watch'));
    const sid = db.listSessions(1)[0]?.sessionId;
    const calls = [];
    await watch.tick({
      policy: { mode: 'observe', allowSessions: [sid] },
      briefFn: () => ({
        headline: '', counts: {}, scannedSessions: 1, quietSessions: 0, taskFailures: [],
        items: [{ kind: 'stalled', sessionId: sid, title: 'x', age: '99 分钟前', why: '', next: '' }],
      }),
      execute: (tool, args) => { calls.push(tool); return { content: [{ type: 'text', text: '{}' }] }; },
    });
    assert.strictEqual(calls.length, 0, 'observe 模式不该执行任何动作');
  });

  const failed = results.filter((r) => !r.pass);
  for (const r of results) {
    console.log(`${r.pass ? '[OK]  ' : '[FAIL]'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* 忽略 */ }
  process.exit(failed.length ? 1 : 0);
})();
