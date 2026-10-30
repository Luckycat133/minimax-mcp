'use strict';
/**
 * ocr-match.test.js — 文字匹配的纯逻辑测试（不截屏）。
 * 匹配规则错了会导致"点了错误的按钮"，比找不到更危险，所以单独立测试。
 */

const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { match, norm, pickLeftmostColumn } = require(path.join(ROOT, 'src/gateway/ocr'));

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (err) {
    results.push({ name, pass: false, detail: err.message });
  }
}

const items = [
  { text: '提交', x: 100, y: 200, w: 40, h: 16, cx: 120, cy: 208, conf: 0.9 },
  { text: '提交作品表单', x: 100, y: 300, w: 120, h: 16, cx: 160, cy: 308, conf: 0.9 },
  { text: '取消', x: 200, y: 200, w: 40, h: 16, cx: 220, cy: 208, conf: 0.9 },
  { text: 'Submit', x: 300, y: 200, w: 50, h: 16, cx: 325, cy: 208, conf: 0.9 },
  { text: '登 录', x: 400, y: 200, w: 40, h: 16, cx: 420, cy: 208, conf: 0.9 },
];

check('norm 去掉空白', () => {
  assert.strictEqual(norm('登 录'), '登录');
  assert.strictEqual(norm('  a b\tc '), 'abc');
});

check('norm 全角转半角', () => {
  assert.strictEqual(norm('ＡＢＣ１２３'), 'abc123');
});

check('exact 只匹配完全相同的', () => {
  const hits = match(items, '提交', { mode: 'exact' });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].text, '提交');
});

check('contains 能匹配片段，且精确的更靠前', () => {
  const hits = match(items, '提交', { mode: 'contains' });
  assert.strictEqual(hits.length, 2);
  assert.strictEqual(hits[0].text, '提交', '完全相等的必须排第一');
});

check('空白差异不影响匹配（OCR 常把中文拆开）', () => {
  const hits = match(items, '登录');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].cx, 420);
});

check('prefix 只匹配开头', () => {
  const hits = match(items, '提交', { mode: 'prefix' });
  assert.strictEqual(hits.length, 2);
  const only = match(items, '作品', { mode: 'prefix' });
  assert.strictEqual(only.length, 0, '"作品"不是任何条目的开头');
});

check('大小写不敏感', () => {
  assert.strictEqual(match(items, 'submit').length, 1);
  assert.strictEqual(match(items, 'SUBMIT').length, 1);
});

check('找不到就是空数组，不会瞎给一个', () => {
  assert.deepStrictEqual(match(items, '确定'), []);
  assert.deepStrictEqual(match(items, ''), []);
});

check('命中结果按分数降序', () => {
  const hits = match(items, '提交');
  for (let i = 1; i < hits.length; i += 1) {
    assert.ok(hits[i - 1].score >= hits[i].score, '分数必须单调不增');
  }
});

check('反查：查询里包含整条文本时也算弱命中', () => {
  const hits = match(items, '提交作品表单并确认');
  assert.ok(hits.some((h) => h.text === '提交作品表单'));
});

check('pickLeftmostColumn 在标题重复时选侧栏而不是顶栏', () => {
  // 真实场景：同一个标题在顶栏 (x=772) 和侧栏 (x=556) 各出现一次
  const dup = [
    { text: 'vibe语音输入', x: 772.3, cy: 178.5, cx: 816 },
    { text: 'vibe语音输入', x: 556.6, cy: 499.4, cx: 602 },
  ];
  const picked = pickLeftmostColumn(dup);
  assert.strictEqual(picked.cx, 602, '必须选最左那一列');
});

check('pickLeftmostColumn 同列取最上面一个', () => {
  const col = [
    { text: 'a', x: 556, cy: 620, cx: 600 },
    { text: 'b', x: 558, cy: 560, cx: 602 },
  ];
  assert.strictEqual(pickLeftmostColumn(col).cy, 560);
});

check('pickLeftmostColumn 空输入返回 null', () => {
  assert.strictEqual(pickLeftmostColumn([]), null);
  assert.strictEqual(pickLeftmostColumn(null), null);
});

const failed = results.filter((r) => !r.pass);
for (const r of results) {
  console.log(`${r.pass ? '[OK]  ' : '[FAIL]'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
