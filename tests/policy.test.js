'use strict';
/**
 * policy.test.js — 风险分类与自动裁决的纯逻辑测试。
 *
 * 这层判错的后果比工具层严重得多：判低了会替用户做掉不该做的决定，
 * 判高了会把所有事都推回给人（等于没自动化）。所以每个判据都要有反例。
 */

const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pol = require(path.join(ROOT, 'src/gateway/policy'));

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (err) {
    results.push({ name, pass: false, detail: err.message });
  }
}

/** 造一条问卷。 */
function q({ title = '', question = '', options = [], steps = null }) {
  return {
    requestId: 'ask_x',
    sessionId: 'mvs_x',
    title,
    status: 'pending',
    steps: steps || [{
      stepId: 's1',
      question,
      selectionMode: 'single',
      required: true,
      options,
    }],
  };
}

const OPT_YES = { optionId: 'o1', label: '继续', recommended: true };
const OPT_NO = { optionId: 'o2', label: '先停一下', recommended: false };

// ---------- 高风险：一律不自动 ----------

check('涉及钱 → high', () => {
  const r = pol.classifyQuestion(q({ title: '套餐选择', options: [{ optionId: 'a', label: '升级套餐到 Pro', recommended: true }] }));
  assert.strictEqual(r.level, 'high');
  assert.ok(r.reasons.some((x) => /钱/.test(x)), r.reasons.join('|'));
  assert.strictEqual(r.autoAnswerable, false);
});

check('发布上线 → high', () => {
  const r = pol.classifyQuestion(q({ question: '现在发布到生产吗？', options: [OPT_YES, OPT_NO] }));
  assert.strictEqual(r.level, 'high');
  assert.strictEqual(r.autoAnswerable, false);
});

check('删除 → high', () => {
  const r = pol.classifyQuestion(q({ title: '清理分支', options: [{ optionId: 'a', label: '删除旧分支', recommended: true }] }));
  assert.strictEqual(r.level, 'high');
});

check('凭证/授权 → high', () => {
  const r = pol.classifyQuestion(q({ question: '用哪个 token？', options: [{ optionId: 'a', label: '用现有 API key', recommended: true }] }));
  assert.strictEqual(r.level, 'high');
});

check('对外承诺 → high', () => {
  const r = pol.classifyQuestion(q({ question: '要发给客户吗？', options: [{ optionId: 'a', label: '对外发送', recommended: true }] }));
  assert.strictEqual(r.level, 'high');
});

check('高风险即使有 recommended 也不自动', () => {
  const r = pol.classifyQuestion(q({
    title: '要不要合并到 main',
    options: [{ optionId: 'a', label: '合并', recommended: true }, OPT_NO],
  }));
  assert.strictEqual(r.level, 'high');
  assert.strictEqual(r.autoAnswerable, false);
});

// ---------- 中风险：要人看 ----------

check('没有 recommended → 至少 medium', () => {
  const r = pol.classifyQuestion(q({
    question: '用哪个方案？',
    options: [{ optionId: 'a', label: '方案 A' }, { optionId: 'b', label: '方案 B' }],
  }));
  assert.strictEqual(r.level, 'medium');
  assert.ok(r.reasons.some((x) => /推荐/.test(x)), r.reasons.join('|'));
});

check('多步问卷 → medium', () => {
  const r = pol.classifyQuestion(q({
    steps: [
      { stepId: 's1', question: '继续吗', options: [OPT_YES], selectionMode: 'single' },
      { stepId: 's2', question: '还要吗', options: [OPT_YES], selectionMode: 'single' },
    ],
  }));
  assert.strictEqual(r.level, 'medium');
  assert.ok(r.reasons.some((x) => /多步/.test(x)), r.reasons.join('|'));
});

check('开放式多选一且无推荐 → medium', () => {
  const r = pol.classifyQuestion(q({
    question: '先做哪个',
    options: [{ optionId: 'a', label: '甲' }, { optionId: 'b', label: '乙' }, { optionId: 'c', label: '丙' }],
  }));
  assert.strictEqual(r.level, 'medium');
});

check('什么都没命中 → 保守按 medium', () => {
  const r = pol.classifyQuestion(q({ title: '某个问题', options: [{ optionId: 'a', label: '甲', recommended: true }] }));
  assert.strictEqual(r.level, 'medium');
  assert.ok(r.reasons.some((x) => /保守/.test(x)), r.reasons.join('|'));
});

// ---------- 低风险：可自动 ----------

check('「要不要继续」+ 推荐 → low 且可自动', () => {
  const r = pol.classifyQuestion(q({ question: '要不要继续跑剩下的？', options: [OPT_YES, OPT_NO] }));
  assert.strictEqual(r.level, 'low', r.reasons.join('|'));
  assert.strictEqual(r.autoAnswerable, true);
});

check('「重试一下」+ 推荐 → low', () => {
  const r = pol.classifyQuestion(q({ question: '刚才失败了，重试一次吗？', options: [{ optionId: 'a', label: '重试', recommended: true }, OPT_NO] }));
  assert.strictEqual(r.level, 'low', r.reasons.join('|'));
});

check('措辞低风险但没推荐答案 → 升到 medium，不可自动', () => {
  const r = pol.classifyQuestion(q({
    question: '要不要继续？',
    options: [{ optionId: 'a', label: '继续' }, { optionId: 'b', label: '停' }],
  }));
  // 关键设计：没有推荐答案意味着"出题方认为要人判断"，所以不能只看措辞
  assert.strictEqual(r.level, 'medium', r.reasons.join('|'));
  assert.strictEqual(r.autoAnswerable, false, '没有推荐答案时不该替人挑');
});

// ---------- 裁决 ----------

check('mode=off 什么都不做', () => {
  const d = pol.decideQuestion(q({ question: '要不要继续？', options: [OPT_YES] }), { policy: { mode: 'off' } });
  assert.strictEqual(d.action, 'skip');
});

check('mode=observe 只报不做', () => {
  const d = pol.decideQuestion(q({ question: '要不要继续？', options: [OPT_YES] }), { policy: { mode: 'observe' } });
  assert.strictEqual(d.action, 'ask_human');
});

check('高风险 → ask_human，即使策略允许', () => {
  const d = pol.decideQuestion(
    q({ title: '购买额度', options: [{ optionId: 'a', label: '购买', recommended: true }] }),
    { policy: { mode: 'act', riskCeiling: 'medium' }, idleSeconds: 9999 }
  );
  assert.strictEqual(d.action, 'ask_human');
  assert.ok(/高风险/.test(d.why), d.why);
});

check('低风险 + 人离开够久 → 自动答', () => {
  const d = pol.decideQuestion(
    q({ question: '要不要继续？', options: [OPT_YES, OPT_NO] }),
    { policy: { mode: 'act', minIdleSeconds: 180 }, idleSeconds: 600 }
  );
  assert.strictEqual(d.action, 'auto_answer', d.why);
});

check('低风险但人就在机器前 → 留给人，且要报出来', () => {
  const d = pol.decideQuestion(
    q({ question: '要不要继续？', options: [OPT_YES, OPT_NO] }),
    { policy: { mode: 'act', minIdleSeconds: 180 }, idleSeconds: 5 }
  );
  assert.strictEqual(d.action, 'ask_human', '人在场时不该抢焦点，但也不能吞掉这件事');
  assert.ok(/机器前/.test(d.why), d.why);
});

check('不在允许会话里 → skip', () => {
  const d = pol.decideQuestion(
    q({ question: '要不要继续？', options: [OPT_YES] }),
    { policy: { mode: 'act', allowSessions: ['mvs_other'] }, idleSeconds: 9999 }
  );
  assert.strictEqual(d.action, 'skip');
});

check('风险超过上限 → ask_human', () => {
  const d = pol.decideQuestion(
    q({ question: '要重构吗？', options: [{ optionId: 'a', label: '重构', recommended: true }] }),
    { policy: { mode: 'act', riskCeiling: 'low' }, idleSeconds: 9999 }
  );
  assert.strictEqual(d.action, 'ask_human');
  assert.ok(/超过上限/.test(d.why), d.why);
});

// ---------- 自动催促 ----------

const SESSION = { sessionId: 'mvs_x', status: 'idle' };

check('自动催：人离开够久且没催过 → auto_nudge', () => {
  const d = pol.decideNudge(SESSION, { policy: { mode: 'act', minIdleSeconds: 180 }, idleSeconds: 600 });
  assert.strictEqual(d.action, 'auto_nudge', d.why);
});

check('自动催：冷却期内不催', () => {
  const d = pol.decideNudge(SESSION, {
    policy: { mode: 'act', minIdleSeconds: 180 },
    idleSeconds: 600,
    lastNudgeMinutes: 30,
  });
  assert.strictEqual(d.action, 'skip');
  assert.ok(/冷却/.test(d.why), d.why);
});

check('自动催：人在场不催', () => {
  const d = pol.decideNudge(SESSION, { policy: { mode: 'act', minIdleSeconds: 180 }, idleSeconds: 10 });
  assert.strictEqual(d.action, 'skip');
});

check('自动催：关掉开关就不催', () => {
  const d = pol.decideNudge(SESSION, {
    policy: { mode: 'act', autoNudge: { enabled: false } },
    idleSeconds: 9999,
  });
  assert.strictEqual(d.action, 'skip');
});

check('自动催：催促文案本身含风险词就不发', () => {
  const d = pol.decideNudge(SESSION, {
    policy: { mode: 'act', autoNudge: { enabled: true, message: '需要我帮你发布上线吗' } },
    idleSeconds: 9999,
  });
  assert.strictEqual(d.action, 'skip');
  assert.ok(/风险词/.test(d.why), d.why);
});

check('classifyOutgoing：普通催促是 low', () => {
  const r = pol.classifyOutgoing('看起来停住了，需要我做什么吗');
  assert.strictEqual(r.level, 'low');
  assert.strictEqual(r.autoSendable, true);
});

check('classifyOutgoing：含删除字样是 high', () => {
  const r = pol.classifyOutgoing('要不要我删掉那个分支');
  assert.strictEqual(r.level, 'high');
  assert.strictEqual(r.autoSendable, false);
});

check('withinCeiling 边界', () => {
  assert.strictEqual(pol.withinCeiling('low', 'low'), true);
  assert.strictEqual(pol.withinCeiling('medium', 'low'), false);
  assert.strictEqual(pol.withinCeiling('medium', 'medium'), true);
  assert.strictEqual(pol.withinCeiling('high', 'medium'), false);
});

const failed = results.filter((r) => !r.pass);
for (const r of results) {
  console.log(`${r.pass ? '[OK]  ' : '[FAIL]'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
