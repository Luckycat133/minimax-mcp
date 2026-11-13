'use strict';
/**
 * annotations.js — 工具的风险分级，映射到 MCP 标准的 annotations 字段。
 *
 * 遵循三档风险划分：
 *   read   → readOnlyHint: true                    只读，随便调
 *   ui     → readOnlyHint: false, destructiveHint: false   只动界面，可逆
 *   commit → readOnlyHint: false, destructiveHint: true    会改变对话内容或提交状态，不可逆
 */

const LEVEL = {
  // 只读：不产生任何破坏性副作用，可以随时调、可以并行调
  minimax_status: 'read',
  minimax_brief: 'read',
  minimax_session: 'read',
  minimax_events: 'read',
  minimax_tasks: 'read',

  // 只动桌面界面：改变窗口焦点、截图、窗口布局几何查询
  minimax_desktop: 'ui',

  // 会改变对话内容或提交状态：发消息、答题、续传
  minimax_agent: 'commit',
  minimax_bot: 'commit',
  minimax_questionnaire: 'commit',
  minimax_auto_resume: 'commit',
  minimax_watch: 'commit',

  // 兼容别名（遗留接口无缝过渡）
  minimax_list_sessions: 'read',
  minimax_read_session: 'read',
  minimax_tail_sessions: 'read',
  minimax_search: 'read',
  minimax_pending: 'read',
  minimax_draft_answer: 'read',
  minimax_windows: 'read',
  minimax_get_result: 'read',
  minimax_bot_roster: 'read',
  minimax_activate: 'ui',
  minimax_screenshot: 'ui',
  minimax_new_task: 'ui',
  minimax_stop_generation: 'ui',
  minimax_send_message: 'commit',
  minimax_answer_question: 'commit',
  minimax_bot_message: 'commit',
  minimax_bot_turn: 'commit',
};

/**
 * commit 级工具的"闸门"说明。契约测试要求每个 commit 工具都有一条，
 * 逼着作者写清楚"凭什么默认不会误动作"。
 */
const GATES = {
  minimax_agent: 'send 默认 false；另有活跃守卫，最近 300s 内有会话活动就拒绝；action=result 时只读',
  minimax_bot: 'action=roster/read 时只读；action=send 时需显式提供 text 内容；action=answer 时需提交具体答案',
  minimax_questionnaire: 'action=list/draft 时只读；action=answer 时 preview 默认 true，真实提交需 preview:false + force:true',
  minimax_auto_resume: 'dryRun 默认 true；只有显式 dryRun:false 才会触发恢复操作',
  minimax_watch: 'mode 默认 act 但只动低风险：仅当风险=low 且有推荐答案、人离开 ≥minIdleSeconds、每轮最多 maxActionsPerTick 个动作',

  // 兼容别名闸门
  minimax_send_message: 'send 默认 false；另有活跃守卫，最近 300s 内有会话活动就拒绝',
  minimax_answer_question: 'preview 默认 true；真提交要 preview:false + force:true',
  minimax_bot_message: 'action=read 时只读；action=send 时需显式提供 text 内容',
  minimax_bot_turn: 'action=cancel/resume_pending/answer 需指定具体操作及参数',
};

/** 幂等：重复调用结果一样，宿主可以安全重试。 */
const IDEMPOTENT = new Set([
  'minimax_status',
  'minimax_brief',
  'minimax_session',
  'minimax_events',
  'minimax_tasks',
  'minimax_desktop',
  // 别名
  'minimax_list_sessions',
  'minimax_read_session',
  'minimax_tail_sessions',
  'minimax_search',
  'minimax_pending',
  'minimax_draft_answer',
  'minimax_windows',
  'minimax_screenshot',
  'minimax_activate',
  'minimax_bot_roster',
]);

function levelOf(name) {
  return LEVEL[name] || 'commit'; // 没登记的一律按最危险处理
}

function gateOf(name) {
  return GATES[name] || '';
}

function annotationsFor(name) {
  const level = levelOf(name);
  return {
    readOnlyHint: level === 'read',
    destructiveHint: level === 'commit',
    idempotentHint: IDEMPOTENT.has(name),
    openWorldHint: false,
  };
}

/** 给工具定义补上 annotations 和便于阅读的 title。 */
function annotate(tools) {
  return tools.map((t) => ({
    ...t,
    title: t.title || t.name.replace(/^minimax_/, '').replace(/_/g, ' '),
    annotations: annotationsFor(t.name),
  }));
}

function needsAudit(name) {
  return levelOf(name) !== 'read';
}

module.exports = {
  LEVEL,
  GATES,
  IDEMPOTENT,
  levelOf,
  gateOf,
  annotationsFor,
  annotate,
  needsAudit,
};
