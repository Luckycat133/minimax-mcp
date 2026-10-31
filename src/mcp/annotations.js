'use strict';
/**
 * annotations.js — 工具的风险分级，映射到 MCP 标准的 annotations 字段。
 *
 * 为什么分三档而不是二档：
 *   MCP 协议只有 readOnlyHint / destructiveHint 两个布尔，但"点一下界面"和
 *   "替你回一句话"完全不是一回事。前者可撤销，后者发出去就收不回。
 *   所以内部用三档，对外再压成协议字段：
 *
 *     read   → readOnlyHint: true                    只读，随便调
 *     ui     → readOnlyHint: false, destructiveHint: false   只动界面，可逆
 *     commit → readOnlyHint: false, destructiveHint: true    会改变对话内容，不可逆
 *
 * 这张表是唯一真相。别在别处再写一遍"哪些工具危险"。
 */

const LEVEL = {
  // 只读：不产生任何副作用，可以随时调、可以并行调
  minimax_status: 'read',
  minimax_brief: 'read',
  minimax_list_sessions: 'read',
  minimax_read_session: 'read',
  minimax_tail_sessions: 'read',
  minimax_search: 'read',
  minimax_pending: 'read',
  minimax_draft_answer: 'read',
  minimax_tasks: 'read',
  minimax_windows: 'read',
  minimax_find_text: 'read',
  minimax_get_result: 'read',   // 轮询等待，不改任何状态
  minimax_events: 'read',

  // 只动界面：改变窗口焦点、光标位置、临时输入，都能靠再点一下恢复
  minimax_activate: 'ui',
  minimax_screenshot: 'ui',
  minimax_new_task: 'ui',
  minimax_open_session: 'ui',
  minimax_click: 'ui',
  minimax_click_text: 'ui',
  minimax_type: 'ui',
  minimax_key: 'ui',

  // stop_generation 归 ui 而不是 commit，是个刻意的判断：
  // 它只按 Esc 截断当前这轮，不改对话历史，用户随时可以重发。
  // 标成 destructive 会让宿主每次都弹确认框——而"停下来"恰恰是出问题时最该顺手能做的动作，
  // 加确认等于在刹车上加一道锁。真要防误触，靠的是"MiniMax 必须在前台"那道校验。
  minimax_stop_generation: 'ui',

  // 会改变对话内容：发出去、提交上去，都不是点一下能恢复的
  minimax_send_message: 'commit',
  minimax_answer_question: 'commit',

  // watch 会代答/代催，所以按 commit 处理。它能不能动，由策略决定（见 GATES）
  minimax_watch: 'commit',
};

/**
 * commit 级工具的"闸门"说明。契约测试要求每个 commit 工具都有一条，
 * 逼着作者写清楚"凭什么默认不会误动作"。
 */
const GATES = {
  minimax_send_message: 'send 默认 false；另有活跃守卫，最近 300s 内有会话活动就拒绝',
  minimax_answer_question: 'preview 默认 true；真提交要 preview:false + force:true',
  minimax_watch: 'mode 默认 act 但只动低风险：仅当风险=low 且有推荐答案、人离开 ≥minIdleSeconds、每轮最多 maxActionsPerTick 个动作',
};

/** 幂等：重复调用结果一样，宿主可以安全重试。 */
const IDEMPOTENT = new Set([
  'minimax_status', 'minimax_brief', 'minimax_list_sessions', 'minimax_read_session',
  'minimax_tail_sessions', 'minimax_search', 'minimax_pending', 'minimax_draft_answer',
  'minimax_tasks', 'minimax_windows', 'minimax_find_text', 'minimax_screenshot',
  'minimax_activate',
]);

function levelOf(name) {
  return LEVEL[name] || 'commit'; // 没登记的一律按最危险处理
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

/** 取某个 commit 工具的闸门说明；不是 commit 级返回 null。 */
function gateOf(name) {
  return levelOf(name) === 'commit' ? (GATES[name] || null) : null;
}

/** 需要写审计日志的级别。 */
function needsAudit(name) {
  const level = levelOf(name);
  return level === 'ui' || level === 'commit';
}

module.exports = { LEVEL, GATES, levelOf, gateOf, annotationsFor, annotate, needsAudit };
