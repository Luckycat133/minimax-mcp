'use strict';

/**
 * contract.test.js — 契约一致性测试。不启动 MiniMax、不点任何东西，纯静态检查。
 * 防的是"加了工具但忘了同步文档/清单/测试"这类腐化。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { TOOLS, TOOL_NAMES, CONTRACT_VERSION, SERVER_INFO } = require(path.join(ROOT, 'src/mcp'));

const results = [];
const check = (label, fn) => {
  try {
    fn();
    results.push({ label, pass: true });
    console.log(`[OK]   ${label}`);
  } catch (err) {
    results.push({ label, pass: false, err: err.message });
    console.log(`[FAIL] ${label} — ${err.message}`);
  }
};

// 不写死数字：工具数只保证"在合理区间"，具体一致性由 glama.json 那条断言盯
check('工具数在合理区间', () => {
  assert.ok(TOOLS.length >= 14, `工具数太少: ${TOOLS.length}`);
  assert.ok(TOOLS.length <= 40, `工具数异常膨胀: ${TOOLS.length}`);
});

check('工具名无重复', () => {
  assert.strictEqual(new Set(TOOL_NAMES).size, TOOL_NAMES.length);
});

check('工具名都以 minimax_ 开头', () => {
  for (const n of TOOL_NAMES) assert.ok(n.startsWith('minimax_'), n);
});

check('每个工具都有非空 description', () => {
  for (const t of TOOLS) {
    assert.ok(typeof t.description === 'string' && t.description.trim().length > 10, t.name);
  }
});

check('每个工具的 inputSchema 都是合法 object schema', () => {
  for (const t of TOOLS) {
    assert.ok(t.inputSchema, `${t.name} 缺 inputSchema`);
    assert.strictEqual(t.inputSchema.type, 'object', t.name);
    assert.ok(t.inputSchema.properties, `${t.name} 缺 properties`);
    assert.strictEqual(t.inputSchema.additionalProperties, false, `${t.name} 应禁止额外字段`);
    // required 里列出的必须真的在 properties 里
    for (const r of t.inputSchema.required || []) {
      assert.ok(t.inputSchema.properties[r], `${t.name} required 里的 ${r} 不在 properties`);
    }
  }
});

check('危险工具默认不动作', () => {
  // send_message：send 默认 false（要发必须显式），preview 是可选开关
  const send = TOOLS.find((t) => t.name === 'minimax_send_message');
  assert.strictEqual(send.inputSchema.properties.send.default, false, 'send 默认必须 false');
  // answer_question：会替用户做决定，所以 preview 默认 true、force 默认 false
  const ans = TOOLS.find((t) => t.name === 'minimax_answer_question');
  assert.strictEqual(ans.inputSchema.properties.preview.default, true, 'answer 的 preview 默认必须 true');
  assert.strictEqual(ans.inputSchema.properties.force.default, false, 'force 默认必须 false');
});

check('只读工具没有 send/force 这类动作参数', () => {
  const readOnly = ['minimax_status', 'minimax_list_sessions', 'minimax_read_session',
    'minimax_tail_sessions', 'minimax_search', 'minimax_pending', 'minimax_tasks',
    'minimax_windows', 'minimax_get_result', 'minimax_draft_answer'];
  for (const n of readOnly) {
    const t = TOOLS.find((x) => x.name === n);
    assert.ok(t, `缺工具 ${n}`);
    assert.ok(!t.inputSchema.properties.send, `${n} 不该有 send`);
    assert.ok(!t.inputSchema.properties.force, `${n} 不该有 force`);
  }
});

check('glama.json 的工具数与实际一致', () => {
  const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'glama.json'), 'utf8'));
  assert.strictEqual(g.tools, TOOLS.length, `glama.json 写的 ${g.tools}，实际 ${TOOLS.length}`);
});

check('契约文档覆盖每个工具', () => {
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'skills/minimax-mcp/references/mcp-tool-contracts.json'), 'utf8'));
  const documented = new Set(c.tools.map((t) => t.name));
  for (const n of TOOL_NAMES) assert.ok(documented.has(n), `契约文档缺 ${n}`);
});

check('契约版本与 SERVER_INFO 一致', () => {
  assert.strictEqual(SERVER_INFO.contractVersion, CONTRACT_VERSION);
  assert.ok(CONTRACT_VERSION >= 1);
});

check('协议版本列表包含 2024-11-05', () => {
  const { PROTOCOL_VERSIONS } = require(path.join(ROOT, 'src/mcp'));
  assert.ok(PROTOCOL_VERSIONS.includes('2024-11-05'));
});

check('SKILL.md 提到每个工具名', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills/minimax-mcp/SKILL.md'), 'utf8');
  const missing = TOOL_NAMES.filter((n) => !skill.includes(n));
  assert.deepStrictEqual(missing, [], `SKILL.md 没提到: ${missing.join(', ')}`);
});

check('Tasks 扩展：协商后能力被回告', () => {
  const { handle } = require(path.join(ROOT, 'src/mcp'));
  const withTasks = handle({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: { tasks: {} }, clientInfo: { name: 't', version: '1' } },
  });
  assert.ok(withTasks.result.capabilities.tasks, '声明了 tasks 就必须回告 tasks 能力');
  const without = handle({
    jsonrpc: '2.0', id: 2, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  });
  assert.ok(!without.result.capabilities.tasks, '没声明就不该回告 tasks 能力');
});

check('Tasks 扩展：五个方法都在', () => {
  const { handle } = require(path.join(ROOT, 'src/mcp'));
  const base = { jsonrpc: '2.0' };
  for (const [method, params] of [
    ['tasks/list', {}],
    ['tasks/get', { taskId: 'nope' }],
    ['tasks/result', { taskId: 'nope' }],
    ['tasks/cancel', { taskId: 'nope' }],
  ]) {
    const r = handle({ ...base, id: 1, method, params });
    assert.ok(r.result || r.error, `${method} 必须有响应`);
    assert.ok(!/方法不存在/.test(r.error?.message || ''), `${method} 未实现`);
  }
});

check('Tasks 存储：创建/读取/取消/清理', () => {
  const t = require(path.join(ROOT, 'src/mcp/tasks'));
  const created = t.create({ sessionId: 'mvs_test', afterMessageId: 1, messagePreview: 'x' });
  assert.strictEqual(created.status, 'working');
  assert.ok(t.get(created.taskId), '建完必须能读回来');
  const c = t.cancel(created.taskId);
  assert.strictEqual(c.status, 'canceled');
  assert.ok(t.prune(0) >= 1, 'retainHours=0 必须清掉终态任务');
});

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
