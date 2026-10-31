'use strict';
/**
 * policy.js — 风险分类与自动动作裁决。
 *
 * 这是整个"主动"能力的安全阀：什么能自动做、什么必须留给人，全在这里判。
 *
 * 设计原则：
 *  1. **判据必须可解释**。返回 reasons[]，说清楚为什么算高风险，不能只给一个标签。
 *  2. **拿不准就往高判**。分类器认不出来的一律 medium，medium 默认不自动执行。
 *  3. **结构信号优先于关键词**。"这一步是必答、有 recommended" 比 "选项里有没有'确认'两个字" 可靠。
 *  4. **不可逆动作永远不自动**。花钱、发布、删除、合并、对外发送——这些即使低风险字样也不自动。
 *
 * 纯函数，不碰 IO，方便测。
 */

/**
 * 高风险关键词：出现任一就判 high，永不自动。
 * 这些词对应的动作都有一个共同点——**做了就撤不回**。
 */
const HIGH_RISK_PATTERNS = [
  // 钱
  { re: /(购买|付费|付款|支付|充值|升级套餐|订阅|续费|扣费|发票|退款|报销|预算|报价|合同金额)/, tag: '涉及钱' },
  // 发布与不可逆变更
  { re: /(发布|上线|部署到生产|推送到|force ?push|强推|合并到 ?main|merge|打标签|发版|release|rollback|回滚|删库|删除仓库|清空|销毁|覆盖写|drop table)/i, tag: '发布或不可逆变更' },
  // 凭证与权限
  { re: /(密码|密钥|token|api ?key|授权码|私钥|证书|凭证|开启权限|授予|管理员|root|sudo)/i, tag: '涉及凭证或权限' },
  // 对外承诺
  { re: /(发给客户|对外发送|回复用户|提交表单|报名|签约|法务|合规|声明|公告)/, tag: '对外承诺' },
  // 删除
  { re: /(删|移除|卸载|清掉|干掉|撤销|作废)/, tag: '删除类操作' },
];

/** 中等风险：可以做，但要人看一眼。 */
const MEDIUM_RISK_PATTERNS = [
  { re: /(重构|迁移|升级依赖|改配置|改架构|换方案|切换技术栈|数据库结构|schema)/, tag: '结构性改动' },
  { re: /(合并|PR|pull request|分支策略|cherry-pick)/i, tag: '代码流转' },
  { re: /(第三方|外部服务|接入|注册账号|申请)/, tag: '引入外部依赖' },
];

/** 低风险：问的是"要不要继续 / 选哪个 / 这样行不行"，答案不影响不可逆结果。 */
const LOW_RISK_PATTERNS = [
  { re: /(要不要|是否|继续|接着|可以吗|行不行|确认一下|再试|重试|哪个|哪一种|先做|顺序|格式|命名|风格)/, tag: '征询或确认' },
];

/**
 * 判断一条提问的风险等级。
 * detail 来自 db.questionnaireDetail()。
 */
function classifyQuestion(detail) {
  const reasons = [];
  if (!detail) {
    return { level: 'medium', score: 0, reasons: ['拿不到提问内容'], autoAnswerable: false };
  }

  // 把所有可能承载意图的文字拼起来：标题 + 题干 + 选项文案 + 选项说明
  const steps = detail.steps || [];
  const parts = [detail.title || ''];
  for (const s of steps) {
    parts.push(s.question || '');
    for (const o of s.options || []) {
      parts.push(o.label || '');
      parts.push(o.description || '');
    }
  }
  const haystack = parts.join(' \n ');

  let high = 0;
  for (const p of HIGH_RISK_PATTERNS) {
    if (p.re.test(haystack)) {
      high += 1;
      reasons.push(`命中高风险：${p.tag}`);
    }
  }
  if (high > 0) {
    return { level: 'high', score: high, reasons, autoAnswerable: false };
  }

  let medium = 0;
  for (const p of MEDIUM_RISK_PATTERNS) {
    if (p.re.test(haystack)) {
      medium += 1;
      reasons.push(`命中中风险：${p.tag}`);
    }
  }

  let low = 0;
  for (const p of LOW_RISK_PATTERNS) {
    if (p.re.test(haystack)) {
      low += 1;
      reasons.push(`命中低风险：${p.tag}`);
    }
  }

  // 结构信号：没有 recommended 标记 = 没有"默认答案"，等于要人判断
  const hasRecommended = steps.some((s) => (s.options || []).some((o) => o.recommended));
  if (!hasRecommended) {
    medium += 1;
    reasons.push('没有任何选项被标记为推荐，说明出题方认为需要人判断');
  }

  // 结构信号：允许多步 = 决策链更长，错一步后面全错
  if (steps.length > 1) {
    medium += 1;
    reasons.push(`共 ${steps.length} 步，多步决策`);
  }

  // 结构信号：单选但有 3 个以上选项，且没有推荐 = 选择题而非确认题
  const wideChoice = steps.some((s) => (s.options || []).length >= 3 && !(s.options || []).some((o) => o.recommended));
  if (wideChoice) {
    medium += 1;
    reasons.push('多选一的开放题，没有明确默认项');
  }

  let level;
  if (medium > 0) level = 'medium';
  else if (low > 0) level = 'low';
  else {
    // 既没命中低风险词、也没有结构性风险 —— 保守起见算 medium
    level = 'medium';
    reasons.push('没有任何信号表明这是简单确认题，保守按中风险处理');
  }

  return {
    level,
    score: high * 10 + medium * 2 + low,
    reasons,
    autoAnswerable: level === 'low' && hasRecommended,
  };
}

/**
 * 判断一条会话消息（要发出去的指令）的风险。
 * 用于"自动催一下卡住的会话"这种动作——催话本身也可能说错。
 */
function classifyOutgoing(message) {
  const text = String(message || '');
  const reasons = [];
  let high = 0;
  for (const p of HIGH_RISK_PATTERNS) {
    if (p.re.test(text)) { high += 1; reasons.push(`命中高风险：${p.tag}`); }
  }
  if (high) return { level: 'high', score: high, reasons, autoSendable: false };
  const medium = MEDIUM_RISK_PATTERNS.filter((p) => p.re.test(text)).length;
  if (medium) {
    return { level: 'medium', score: medium, reasons: ['要发的内容涉及结构性改动'], autoSendable: false };
  }
  return { level: 'low', score: 0, reasons: ['只是催促/询问，不改变任何决定'], autoSendable: true };
}

/**
 * 自动动作总裁决。
 *
 * policy 结构：
 *   {
 *     mode: 'off' | 'observe' | 'act',
 *     riskCeiling: 'low' | 'medium',       // 最高允许自动执行的等级
 *     minIdleSeconds: 180,                 // 人离开多久才允许自动动界面
 *     maxActionsPerTick: 2,
 *     autoNudge: { enabled: true, message: '...', cooldownMinutes: 360 },
 *     allowSessions: null | string[],      // null = 全部
 *   }
 */
const DEFAULT_POLICY = {
  mode: 'act',
  riskCeiling: 'low',
  minIdleSeconds: 180,
  maxActionsPerTick: 2,
  autoNudge: {
    enabled: true,
    message: '看起来这轮停住了。如果只是卡在等待，请继续；如果需要我做什么，直接说。',
    cooldownMinutes: 360,
  },
  allowSessions: null,
};

const RISK_ORDER = { low: 0, medium: 1, high: 2 };

function withinCeiling(level, ceiling) {
  return RISK_ORDER[level] <= RISK_ORDER[ceiling];
}

/**
 * 决定一条"等你回答的提问"要不要自动答。
 * 返回 {action:'auto_answer'|'ask_human'|'skip', why}
 */
function decideQuestion(detail, ctx = {}) {
  const policy = { ...DEFAULT_POLICY, ...(ctx.policy || {}) };
  const risk = classifyQuestion(detail);

  if (policy.mode === 'off') {
    return { action: 'skip', risk, why: '策略是 off，不做任何自动动作' };
  }
  if (policy.mode === 'observe') {
    return { action: 'ask_human', risk, why: '策略是 observe，只观察不执行' };
  }
  if (policy.allowSessions && !policy.allowSessions.includes(detail.sessionId)) {
    return { action: 'skip', risk, why: '这个会话不在允许范围内' };
  }
  if (risk.level === 'high') {
    return { action: 'ask_human', risk, why: '高风险，必须人来定' };
  }
  if (!withinCeiling(risk.level, policy.riskCeiling)) {
    return { action: 'ask_human', risk, why: `风险等级 ${risk.level} 超过上限 ${policy.riskCeiling}` };
  }
  if (!risk.autoAnswerable) {
    return { action: 'ask_human', risk, why: '虽然等级不高，但没有推荐答案，不该替人挑' };
  }
  // 读不到闲置时间就按 0 处理 —— 宁可不动，也不能在不确定的情况下抢焦点
  const idle = ctx.idleSeconds ?? 0;
  if (idle < policy.minIdleSeconds) {
    // 人在机器前：不该抢焦点代答，但这件事仍然需要人处理，所以要报出来而不是吞掉
    return { action: 'ask_human', risk, why: `人就在机器前（闲置 ${idle}s），留给你自己点，不抢焦点` };
  }
  return { action: 'auto_answer', risk, why: '低风险 + 有推荐答案 + 人不在，可以代答' };
}

/** 决定卡住的会话要不要自动催。 */
function decideNudge(session, ctx = {}) {
  const policy = { ...DEFAULT_POLICY, ...(ctx.policy || {}) };
  const nudge = { ...DEFAULT_POLICY.autoNudge, ...(policy.autoNudge || {}) };

  if (policy.mode !== 'act') {
    return { action: 'skip', why: `策略是 ${policy.mode}，不自动发消息` };
  }
  if (!nudge.enabled) {
    return { action: 'skip', why: '自动催促被关掉了' };
  }
  if (policy.allowSessions && !policy.allowSessions.includes(session.sessionId)) {
    return { action: 'skip', why: '这个会话不在允许范围内' };
  }
  const risk = classifyOutgoing(nudge.message);
  if (!risk.autoSendable) {
    return { action: 'skip', risk, why: '催促文案本身含风险词，不自动发' };
  }
  // 同上：读不到闲置时间按 0 处理，不自动发消息
  if ((ctx.idleSeconds ?? 0) < policy.minIdleSeconds) {
    return { action: 'skip', risk, why: `人还在用机器（闲置 ${ctx.idleSeconds ?? 0}s），不抢焦点` };
  }
  if (ctx.lastNudgeMinutes !== undefined && ctx.lastNudgeMinutes < nudge.cooldownMinutes) {
    return { action: 'skip', risk, why: `${ctx.lastNudgeMinutes} 分钟前催过，冷却中` };
  }
  return { action: 'auto_nudge', risk, why: '会话卡住 + 人不在 + 没催过，可以自动催一次' };
}

module.exports = {
  classifyQuestion,
  classifyOutgoing,
  decideQuestion,
  decideNudge,
  withinCeiling,
  DEFAULT_POLICY,
  HIGH_RISK_PATTERNS,
  MEDIUM_RISK_PATTERNS,
  LOW_RISK_PATTERNS,
};
