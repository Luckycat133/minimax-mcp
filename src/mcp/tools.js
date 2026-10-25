'use strict';

/**
 * tools.js — 工具面定义。每个工具单一意图，参数尽量少。
 *
 * 只读工具直接查 MiniMax 自己的 SQLite；控制工具走 GUI 驱动，且都带「前台校验」。
 */

const TOOLS = [
  {
    name: 'minimax_status',
    description: 'MiniMax Code 本地状态：数据库位置、会话数、消息数、最后活动时间、运行中的后台任务数。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'minimax_list_sessions',
    description: '列出 MiniMax Code 的会话，按最近活动排序。返回序号，可传给 minimax_read_session。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_read_session',
    description: '读取某个会话的消息。session 可传会话 ID（mvs_ 开头）或 minimax_list_sessions 返回的序号。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: '会话 ID 或序号' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 30 },
        includeThinking: { type: 'boolean', default: false },
      },
      required: ['session'],
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_tail_sessions',
    description: '取最近 N 个会话各自最新的几条消息，用于快速巡检谁在等回答、谁有结果。',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 20, default: 3 },
        perSession: { type: 'integer', minimum: 1, maximum: 20, default: 2 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_search',
    description: '跨会话全文搜索消息内容。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_pending',
    description: '列出 Agent 发出、还在等你回答的提问和确认项。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'minimax_tasks',
    description: '列出自协后台任务及状态（running/succeeded/failed/canceled）。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        status: { type: 'string', description: '可选，按状态过滤' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_windows',
    description: '列出 MiniMax Code 的窗口及几何信息（位置、尺寸），用于算点击坐标。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'minimax_activate',
    description: '把 MiniMax Code 切到前台，并返回前台窗口信息。控制类操作前通常先调它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'minimax_screenshot',
    description: '截图。mode=screen 截全屏；mode=region 需同时给 x,y,width,height。返回图片路径，直接用 Read 查看。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', default: 'minimax' },
        mode: { type: 'string', enum: ['screen', 'region'], default: 'screen' },
        x: { type: 'number' }, y: { type: 'number' },
        width: { type: 'number' }, height: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_send_message',
    description:
      '往 MiniMax 当前打开的会话输入框粘贴一条指令。默认只输入不发送；send=true 才回车。' +
      '发送后会轮询数据库确认消息真的入库，返回 ok 或 warn。' +
      '带活跃守卫：当前会话不久前还在活动就拒绝发送（防止打扰你正在进行的对话），确认要发加 force:true。' +
      'preview:true 只报告会发生什么，不点不粘不发。',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        send: { type: 'boolean', default: false },
        at: { type: 'string', description: '输入框坐标 "x,y"，不传则按窗口自动推算' },
        layout: { type: 'string', enum: ['chat', 'newtask'], default: 'chat', description: 'chat=会话页底部输入框；newtask=新建任务页中部输入框' },
        quietSeconds: { type: 'integer', minimum: 0, default: 300, description: '当前会话多久没活动才允许发送；0 表示不检查' },
        force: { type: 'boolean', default: false, description: '跳过活跃守卫，确认要打扰正在进行的对话时用' },
        preview: { type: 'boolean', default: false, description: '只预览不动作：报告目标坐标、遮挡情况、守卫状态' },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_click',
    description: '在给定屏幕坐标点击一次。坐标是全局「点」，原点左上角。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' }, y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right'], default: 'left' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_type',
    description: '在当前焦点处输入文本（支持中文）。仅用于已确认焦点的场景。同样受活跃守卫保护——有会话刚还在活动就拒绝输入，确认要输加 force:true。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        force: { type: 'boolean', default: false, description: '跳过活跃守卫' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_key',
    description: '按一个键，可带修饰键。如 key="t", modifiers=["cmd"] 表示 ⌘T。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        modifiers: { type: 'array', items: { type: 'string' }, default: [] },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_get_result',
    description:
      '等某个会话把当前这轮跑完，返回最终回复。发给 minimax_send_message 之后用它收结果，' +
      '不用自己轮询。判定"跑完"的依據是会话状态回到 idle 且最后一条助手消息有正文。' +
      '超时也会返回，但 result 可能是半成品（done:false）。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID；省略则用最近活跃的会话' },
        afterMessageId: { type: 'integer', minimum: 0, default: 0, description: '从这条消息之后开始找，通常传 minimax_send_message 返回的 messageId' },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: 3600, default: 300 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_stop_generation',
    description: '让 MiniMax 停止当前这轮生成（按 Esc）。只发按键，不点任何按钮，可逆。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const TOOL_NAMES = TOOLS.map((t) => t.name);

module.exports = { TOOLS, TOOL_NAMES };
