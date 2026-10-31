'use strict';
/**
 * edge.test.js — 边界与回归测试。
 *
 * 这里的每一条都对应一个真实踩到的坑。写在这里的目的是：
 * 下次有人"顺手简化"掉这些防御时，测试会立刻红。
 */

const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'src/gateway/db'));
const qn = require(path.join(ROOT, 'src/mcp/questionnaire'));

const results = [];
function check(name, fn) {
  try {
    fn();
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

// ---------- SQL 占位符扫描 ----------

check('SQL 字面量里的 ? 不会被当成占位符', () => {
  // 老实现是 sql.replace(/\?/g)，会把 '?' 这个字面量也替换掉，参数直接错位
  const rows = db.query("select '?' as a, ? as b, 'x?y' as c", ['hello']);
  assert.strictEqual(rows[0].a, '?');
  assert.strictEqual(rows[0].b, 'hello');
  assert.strictEqual(rows[0].c, 'x?y');
});

check('占位符数量与参数不一致会报错', () => {
  assert.throws(() => db.query('select ? as a, ? as b', ['only-one']), /占位符/);
  assert.throws(() => db.query('select 1', ['extra']), /占位符/);
});

check('字符串参数里的单引号被正确转义', () => {
  const rows = db.query('select ? as v', ["O'Brien"]);
  assert.strictEqual(rows[0].v, "O'Brien");
});

check('注入式参数不会改变语义', () => {
  const rows = db.query('select ? as v', ["' OR 1=1 --"]);
  assert.strictEqual(rows[0].v, "' OR 1=1 --");
});

// ---------- 结果判定 ----------

check('checkResult 对不存在的会话不崩', () => {
  const r = db.checkResult('mvs_does_not_exist', 0);
  assert.strictEqual(r.done, false);
  assert.strictEqual(r.status, null);
});

check('checkResult 结构完整', () => {
  const sid = db.listSessions(1)[0]?.sessionId;
  assert.ok(sid, '至少应该有一个会话');
  const r = db.checkResult(sid, 0);
  for (const k of ['status', 'lastSeen', 'best', 'done']) {
    assert.ok(k in r, `缺字段 ${k}`);
  }
  assert.strictEqual(typeof r.done, 'boolean');
});

// ---------- 显式会话解析 ----------

check('get_result 对不存在的 sessionId 报错，不静默换成别的会话', async () => {
  const { callTool } = require(path.join(ROOT, 'src/mcp/handler'));
  const res = callTool('minimax_get_result', { sessionId: 'mvs_nope', timeoutSeconds: 1 });
  assert.strictEqual(res.isError, true, '必须报错');
  assert.ok(/找不到会话/.test(payload(res).error), payload(res).error);
});

// ---------- 坐标校验 ----------

check('at 格式不对要报错，不能变成 NaN 点出去', () => {
  const { callTool } = require(path.join(ROOT, 'src/mcp/handler'));
  for (const bad of ['abc', '12,abc', '1,2,3', '', ' -1,5']) {
    const res = callTool('minimax_send_message', { message: 'x', at: bad, preview: true });
    assert.strictEqual(res.isError, true, `"${bad}" 应该被拒绝`);
  }
});

check('合法 at 能通过校验', () => {
  const { callTool } = require(path.join(ROOT, 'src/mcp/handler'));
  const res = callTool('minimax_send_message', { message: 'x', at: ' 640 , 880 ', preview: true });
  // preview 是只读的，不该因为坐标合法就真发
  assert.strictEqual(res.isError, false, payload(res).error);
  const p = payload(res);
  if (p.preview) assert.strictEqual(p.inputAt.x, 640);
});

// ---------- 问卷规范化 ----------

check('selections 传成字符串不崩，报可读错误', () => {
  const detail = {
    requestId: 'ask_x', steps: [{ stepId: 's1', options: [{ optionId: 'o1' }], selectionMode: 'single' }],
  };
  const r = qn.normalizeSelections(detail, 'o1');
  assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
});

check('selections 传 null 走必答校验', () => {
  const detail = {
    requestId: 'ask_x', steps: [{ stepId: 's1', options: [{ optionId: 'o1' }], selectionMode: 'single' }],
  };
  const r = qn.normalizeSelections(detail, null);
  assert.ok(r.errors.some((e) => /缺少必答步骤/.test(e)), r.errors.join('|'));
});

check('steps 为空的问卷不会崩', () => {
  const r = qn.normalizeSelections({ requestId: 'ask_x', steps: [] }, []);
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.answers, []);
});

// ---------- 通知必须立刻写出去 ----------

check('emit 立刻写 stdout，不等下一次客户端消息', () => {
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

check('未知参数被拒绝', () => {
  const { callTool } = require(path.join(ROOT, 'src/mcp/handler'));
  const res = callTool('minimax_status', { 乱传的: 1 });
  assert.strictEqual(res.isError, true);
  assert.ok(/不是这个工具支持的参数/.test(payload(res).error));
});

check('类型错误被拒绝且提示类型', () => {
  const { callTool } = require(path.join(ROOT, 'src/mcp/handler'));
  const res = callTool('minimax_click', { x: 'abc', y: 1 });
  assert.strictEqual(res.isError, true);
  assert.ok(/类型应为 number/.test(payload(res).error));
});

check('超出范围的数字被拒绝', () => {
  const { callTool } = require(path.join(ROOT, 'src/mcp/handler'));
  const res = callTool('minimax_search', { query: 'x', limit: 99999 });
  assert.strictEqual(res.isError, true);
  assert.ok(/不能大于/.test(payload(res).error));
});

(async () => {
  await checkAsync('watch 拒绝非法 policy.mode', async () => {
    const { callTool } = require(path.join(ROOT, 'src/mcp/handler'));
    const res = callTool('minimax_watch', { policy: { mode: '乱来' } });
    assert.strictEqual(res.isError, true);
    assert.ok(/只能是/.test(payload(res).error));
  });

  await checkAsync('read_session 能往前翻页，且页码单调变小', async () => {
    const { callTool } = require(path.join(ROOT, 'src/mcp/handler'));
    const sid = db.listSessions(1)[0]?.sessionId;
    const first = payload(callTool('minimax_read_session', { session: sid, limit: 3 }));
    if (!first.messages || first.messages.length < 2) return; // 会话太短就跳过
    const anchor = first.oldestId;
    const second = payload(callTool('minimax_read_session', { session: sid, limit: 3, before: anchor }));
    assert.ok(second.messages.length > 0, '翻页不该空');
    for (const m of second.messages) {
      assert.ok(m.id < anchor, `翻页后不该出现 >= ${anchor} 的消息（拿到 ${m.id}）`);
    }
  });

  await checkAsync('events 的 since 非法时明确报错，不静默返回全部', async () => {
    const { callTool } = require(path.join(ROOT, 'src/mcp/handler'));
    const res = callTool('minimax_events', { since: '不是时间' });
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
    const hits = payload(callTool('minimax_search', { query: title.slice(0, 4), limit: 10 })).hits;
    assert.ok(hits.some((h) => h.kind === 'session'), '应该至少有一条 kind=session 的命中');
    assert.ok(hits.every((h) => h.kind === 'session' || h.kind === 'message'), 'kind 只能是 session/message');
  });

  await checkAsync('搜索空关键词报错，不返回最近若干条冒充结果', async () => {
    const { callTool } = require(path.join(ROOT, 'src/mcp/handler'));
    const res = callTool('minimax_search', { query: '   ' });
    assert.strictEqual(res.isError, true);
    assert.ok(/不能为空/.test(payload(res).error));
  });

  const failed = results.filter((r) => !r.pass);
  for (const r of results) {
    console.log(`${r.pass ? '[OK]  ' : '[FAIL]'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
})();
