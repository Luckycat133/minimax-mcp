'use strict';

const TOOLS = [
  {
    name: 'minimax_status',
    description: '查看 MiniMax 连接、Token Plan 额度和待处理会话。',
    inputSchema: {
      type: 'object',
      properties: {
        includeBrief: { type: 'boolean', default: true, description: '包含待办摘要' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_session',
    description: '列出最近会话、读取历史或搜索标题与正文。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'read', 'search'],
          description: '省略时按 sessionId、query、list 的顺序推断',
        },
        sessionId: { type: 'string', description: 'read 的会话 ID 或列表序号' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: '条数。read 默认 30，采样默认 3，其余默认 20' },
        includeThinking: { type: 'boolean', default: false, description: 'read 时包含已存储的 thinking 字段' },
        maxChars: { type: 'integer', minimum: 0, default: 4000, description: 'read/采样每条文本字段的字符上限；0 取全文，截断返回原长度与标记' },
        before: { type: 'integer', minimum: 1, description: 'read 翻页用上一页的 oldestId' },
        query: { type: 'string', description: 'search 的关键词' },
        perSession: { type: 'integer', minimum: 1, maximum: 20, description: 'list 时附带每个会话的末尾消息，最多采样 20 个会话' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_agent',
    description: '激活 MiniMax 窗口、打开新任务、向原生会话写草稿或发送、查结果或停止轮次。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['send', 'result', 'stop', 'new', 'activate'],
          description: '省略时，有 message 走 send，否则走 result',
        },
        message: { type: 'string', description: 'send 所需的消息正文' },
        sessionId: { type: 'string', description: 'send、result 的目标会话，stop 必填' },
        newSession: { type: 'boolean', default: false, description: '给新任务写消息，与 sessionId 互斥' },
        send: { type: 'boolean', default: false, description: 'true 提交消息，默认只填草稿' },
        force: { type: 'boolean', default: false, description: 'send 时跳过近期活动保护' },
        preview: { type: 'boolean', default: false, description: '预览 send 的目标与守卫，保留当前会话和草稿' },
        timeoutSeconds: { type: 'integer', minimum: 0, maximum: 300, default: 0, description: 'result 等待时间，默认即时' },
        afterMessageId: { type: 'integer', minimum: 0, description: 'send 回执的 messageId；用于 result 查询回复，或 stop 锁定该轮' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_bot',
    description: '打开 Bot Studio，查看名册、读取群聊或私聊，向明确目标发送、取消、恢复或答卡片。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['roster', 'send', 'read', 'cancel', 'resume', 'answer', 'open'],
          description: '省略时，text 触发 send，target 触发 read，其余为 roster',
        },
        target: { type: 'string', description: 'Bot 或群聊名称，或名册返回的 chatId。写入必填' },
        text: { type: 'string', maxLength: 50000, description: 'send 的消息正文' },
        mode: { type: 'string', enum: ['direct', 'group'], default: 'direct', description: '按成员名称发送时，group 在群内 @该成员' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'read 的消息数' },
        sessionId: { type: 'string', description: 'open 挂载标签页的原生会话，默认使用当前会话' },
        clientMessageId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', description: 'send 的去重 ID；同一次发送重试时使用相同 ID 和正文' },
        messageId: { type: 'string', description: 'answer 的卡片消息 ID' },
        answers: {
          type: 'array', minItems: 1, maxItems: 64,
          description: 'answer 的逐题答案',
          items: {
            type: 'object',
            properties: {
              stepId: { type: 'string', minLength: 1 },
              selectedOptionIds: { type: 'array', maxItems: 64, items: { type: 'string', minLength: 1 } },
              selectedOther: { type: 'boolean' },
              otherText: { type: 'string', maxLength: 4096 },
              skipped: { type: 'boolean' },
            },
            required: ['stepId', 'selectedOptionIds'],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_questionnaire',
    description: '列出待处理的原生问卷，查看题目和拟答，或提交确认的答案。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'answer'],
          description: '省略时，有 requestId 走 answer 预览，其余列出待办',
        },
        requestId: { type: 'string', description: 'answer 的问卷请求 ID' },
        selections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              stepId: { type: 'string' },
              optionIds: { type: 'array', items: { type: 'string' } },
              selectedOther: { type: 'boolean' },
              otherText: { type: 'string' },
            },
            required: ['stepId', 'optionIds'],
            additionalProperties: false,
          },
          description: '选定答案，省略则使用拟答',
        },
        preview: { type: 'boolean', default: true, description: '预览选项与拟答' },
        force: { type: 'boolean', default: false, description: '与 preview:false 一起确认提交' },
      },
      additionalProperties: false,
    },
  },
];

const INTERNAL_TOOLS = [
  {
    name: 'minimax_brief',
    description: '态势快照：按 等你决定>报错>卡住>运行中 优先级输出需关注的会话。纯读数据库，巡检首选。',
    inputSchema: {
      type: 'object',
      properties: {
        stalledMinutes: { type: 'integer', minimum: 1, default: 10, description: '未回复卡住判定阈值(分钟)' },
        activeMinutes: { type: 'integer', minimum: 1, default: 10, description: '活跃会话判定阈值(分钟)' },
        finishedMinutes: { type: 'integer', minimum: 1, default: 60, description: '刚完成判定阈值(分钟)' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 200, description: '扫描会话数量' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_desktop',
    description: '桌面客户端前台与显示控制：将窗口唤醒前台并可选挂载 CDP 调试端口(activate)、捕获窗口截图(screenshot)、查询窗口几何坐标与置顶状态(windows)。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['activate', 'screenshot', 'windows'],
          default: 'activate',
          description: '操作类型：activate=唤醒前台并挂载CDP, screenshot=捕获窗口截图, windows=查询窗口布局',
        },
        relaunchWithDebug: { type: 'boolean', description: '若未开启 CDP 调试端口 (9223)，是否优雅重启并挂载调试端口 (action=activate 时生效)' },
        name: { type: 'string', default: 'minimax', description: '截图保存标识 (action=screenshot 时生效)' },
        mode: { type: 'string', enum: ['screen', 'region'], default: 'screen', description: '截图范围 (action=screenshot 时生效)' },
        x: { type: 'number', description: '区域截图 X 坐标 (mode=region 时使用)' },
        y: { type: 'number', description: '区域截图 Y 坐标 (mode=region 时使用)' },
        width: { type: 'number', description: '区域截图宽度 (mode=region 时使用)' },
        height: { type: 'number', description: '区域截图高度 (mode=region 时使用)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_watch',
    description: '周期巡检：比对快照产出事件，可按安全策略自动处理低风险问卷。dryRun=true 仅预览。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['tick', 'status', 'reset', 'config'], default: 'tick' },
        dryRun: { type: 'boolean', default: false },
        policy: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['off', 'observe', 'act'], default: 'act' },
            riskCeiling: { type: 'string', enum: ['low', 'medium'], default: 'low' },
            minIdleSeconds: { type: 'integer', minimum: 0, default: 180 },
            maxActionsPerTick: { type: 'integer', minimum: 0, maximum: 10, default: 2 },
            autoNudge: {
              type: 'object',
              properties: {
                enabled: { type: 'boolean', default: true },
                message: { type: 'string' },
                cooldownMinutes: { type: 'integer', minimum: 0, default: 360 },
              },
              additionalProperties: false,
            },
            allowSessions: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        stalledMinutes: { type: 'integer', minimum: 1, default: 10 },
        finishedMinutes: { type: 'integer', minimum: 1, default: 60 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_events',
    description: '读取巡检事件队列(finished/error/question/stalled/task_failed)。纯读无副作用。',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: '起始时间戳' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_tasks',
    description: '查询 MiniMax 后台任务状态(running/succeeded/failed/canceled)。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        status: { type: 'string', description: '按状态过滤' },
      },
      additionalProperties: false,
    },
  },
];

const { annotate } = require('./annotations');
const ANNOTATED = annotate(TOOLS);
const ALL_ANNOTATED = annotate([...TOOLS, ...INTERNAL_TOOLS]);
const TOOL_NAMES = ANNOTATED.map((t) => t.name);

module.exports = {
  TOOLS: ANNOTATED,
  TOOL_NAMES,
  ALL_TOOLS: ALL_ANNOTATED,
};
