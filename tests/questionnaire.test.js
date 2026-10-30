'use strict';
/**
 * questionnaire.test.js — 问卷答案规范化与校验的纯逻辑测试。
 * 不碰屏幕、不碰数据库，只测规则。这些规则错了会导致"点了半天什么都没选中"。
 */

const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
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

const detail = {
  requestId: 'ask_test',
  status: 'pending',
  steps: [
    {
      stepId: 'path',
      question: '选哪条路？',
      selectionMode: 'single',
      required: true,
      options: [
        { optionId: 'p1', label: '走 A 路（推荐）', recommended: true },
        { optionId: 'p2', label: '走 B 路', recommended: false },
      ],
    },
    {
      stepId: 'extras',
      question: '还要什么？',
      selectionMode: 'multiple',
      required: false,
      options: [
        { optionId: 'e1', label: '要日志' },
        { optionId: 'e2', label: '要截图' },
      ],
    },
  ],
};

check('接受 optionIds 写法', () => {
  const r = qn.normalizeSelections(detail, [{ stepId: 'path', optionIds: ['p1'] }]);
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.answers[0].optionIds, ['p1']);
});

check('接受 selectedOptionIds 写法（历史数据用的这个）', () => {
  const r = qn.normalizeSelections(detail, [{ stepId: 'path', selectedOptionIds: ['p2'] }]);
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.answers[0].optionIds, ['p2']);
});

check('接受单个字符串 optionIds', () => {
  const r = qn.normalizeSelections(detail, [{ stepId: 'path', optionIds: 'p1' }]);
  assert.deepStrictEqual(r.answers[0].optionIds, ['p1']);
});

check('未知步骤报错并点名可选步骤', () => {
  const r = qn.normalizeSelections(detail, [{ stepId: 'nope', optionIds: ['p1'] }]);
  assert.ok(r.errors.some((e) => /没有这一步/.test(e) && /path/.test(e)), r.errors.join('|'));
});

check('未知选项报错并点名可选选项', () => {
  const r = qn.normalizeSelections(detail, [{ stepId: 'path', optionIds: ['zzz'] }]);
  assert.ok(r.errors.some((e) => /没有这些选项/.test(e) && /p1/.test(e)), r.errors.join('|'));
});

check('单选题给两个选项会被砍成一个并报错', () => {
  const r = qn.normalizeSelections(detail, [{ stepId: 'path', optionIds: ['p1', 'p2'] }]);
  assert.ok(r.errors.some((e) => /单选/.test(e)), r.errors.join('|'));
  assert.strictEqual(r.answers[0].optionIds.length, 1);
});

check('多选题允许多个选项且不报错', () => {
  const r = qn.normalizeSelections(detail, [
    { stepId: 'path', optionIds: ['p1'] },
    { stepId: 'extras', optionIds: ['e1', 'e2'] },
  ]);
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.answers[1].optionIds, ['e1', 'e2']);
});

check('漏掉必答步骤会报错', () => {
  const r = qn.normalizeSelections(detail, [{ stepId: 'extras', optionIds: ['e1'] }]);
  assert.ok(r.errors.some((e) => /缺少必答步骤: path/.test(e)), r.errors.join('|'));
});

check('选"其他"但没写内容会报错', () => {
  const r = qn.normalizeSelections(detail, [
    { stepId: 'path', optionIds: ['p1'] },
    { stepId: 'extras', selectedOther: true, otherText: '   ' },
  ]);
  assert.ok(r.errors.some((e) => /otherText/.test(e)), r.errors.join('|'));
});

check('选"其他"并写了内容就通过，且带上 otherText', () => {
  const r = qn.normalizeSelections(detail, [
    { stepId: 'path', optionIds: ['p1'] },
    { stepId: 'extras', selectedOther: true, otherText: '要一份 CSV' },
  ]);
  assert.deepStrictEqual(r.errors, []);
  const payload = qn.buildReplyPayload(detail, r.answers);
  const extras = payload.answers.find((a) => a.stepId === 'extras');
  assert.strictEqual(extras.selectedOther, true);
  assert.strictEqual(extras.otherText, '要一份 CSV');
});

check('空选择（既没选项也没其他）报错', () => {
  const r = qn.normalizeSelections(detail, [{ stepId: 'path', optionIds: [] }]);
  assert.ok(r.errors.some((e) => /没有选中任何选项/.test(e)), r.errors.join('|'));
});

check('reply_payload 结构与真实历史数据一致', () => {
  const r = qn.normalizeSelections(detail, [{ stepId: 'path', optionIds: ['p1'] }]);
  const p = qn.buildReplyPayload(detail, r.answers);
  assert.strictEqual(p.schemaVersion, 2);
  assert.strictEqual(p.requestId, 'ask_test');
  assert.ok(Array.isArray(p.answers));
  const a = p.answers[0];
  assert.strictEqual(a.stepId, 'path');
  assert.deepStrictEqual(a.selectedOptionIds, ['p1']);
  assert.strictEqual(a.selectedOther, false);
  // 没选其他时不该出现 otherText 字段
  assert.ok(!('otherText' in a));
});

check('clickPlan 按选项顺序生成锚点', () => {
  const r = qn.normalizeSelections(detail, [
    { stepId: 'path', optionIds: ['p2'] },
    { stepId: 'extras', optionIds: ['e1'] },
  ]);
  const plan = qn.clickPlan(detail, r.answers);
  assert.strictEqual(plan.length, 2);
  assert.strictEqual(plan[0].anchor, '走 B 路');
  assert.strictEqual(plan[1].anchor, '要日志');
});

check('clickPlan 里"其他"带 thenType', () => {
  const r = qn.normalizeSelections(detail, [
    { stepId: 'path', optionIds: ['p1'] },
    { stepId: 'extras', selectedOther: true, otherText: '自定义' },
  ]);
  const plan = qn.clickPlan(detail, r.answers);
  const other = plan.find((p) => p.thenType);
  assert.ok(other, '选其他时必须生成输入动作');
  assert.strictEqual(other.thenType, '自定义');
});

check('fromSuggestion 能直接喂回 normalizeSelections', () => {
  const suggestion = {
    answers: [{ stepId: 'path', selectedOptionIds: ['p1'], selectedOther: false }],
  };
  const r = qn.normalizeSelections(detail, qn.fromSuggestion(suggestion));
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.answers[0].optionIds, ['p1']);
});

const failed = results.filter((r) => !r.pass);
for (const r of results) {
  console.log(`${r.pass ? '[OK]  ' : '[FAIL]'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
