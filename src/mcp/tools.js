'use strict';

/**
 * tools.js — MiniMax MCP 核心工具定义（领域驱动极简 5 工具版）。
 *
 * 遵循 MCP 2024-11-05 规范：
 * 外部 AI 仅需感知 5 项核心能力：
 * 1. minimax_status: 查看 MiniMax 运行状态、CDP 连接、额度刷新倒计时与注意力概况。
 * 2. minimax_session: 查找与探索对话历史（先找会话/查历史）。
 * 3. minimax_agent: 与原生工作区智能体对话（下发任务/自动切会话/获取产出/终止/新建）。
 * 4. minimax_bot: 与 MiniMax Bot 团队对话（名册流水线架构/向指定专家或群聊发指令/读回复）。
 * 5. minimax_questionnaire: 人工决策卡片与审批管理（查看待办/草稿方案/提交答案）。
 *
 * 注：断点自动续传(auto_resume)、周期巡检守护(watch)、桌面管理等完全由网关后台代码全自动静默执行，
 * 不暴露给外部 AI，彻底降低调用上下文 Token 开销并杜绝误调用。
 */

const TOOLS = [
  {
    name: 'minimax_status',
    description: '查看 MiniMax 运行状态、CDP 9223 端口、Token Plan 额度与刷新倒计时、待审批问卷卡片与注意力队列。',
    inputSchema: {
      type: 'object',
      properties: {
        includeBrief: { type: 'boolean', default: true, description: '是否包含注意力队列摘要' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_session',
    description: '原生会话统一管理与探索：支持会话列表查询(list)、指定会话详情与历史翻页精读(read)、多会话末尾采样(tail)、跨会话全文检索(search)。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'read', 'tail', 'search'],
          default: 'list',
          description: '操作类型：list=列出会话, read=精读指定会话历史, tail=多会话末尾采样, search=跨会话全文检索',
        },
        session: { type: 'string', description: '会话 ID 或列表序号 (action=read 时使用)' },
        sessionId: { type: 'string', description: '会话 ID 别名 (同 session)' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 20, description: '返回条数 (action=list/read/search 时使用)' },
        includeThinking: { type: 'boolean', default: false, description: '是否包含思维链 (action=read 时使用)' },
        before: { type: 'integer', minimum: 1, description: '消息 ID 翻页锚点 (action=read 时使用)' },
        query: { type: 'string', description: '全文检索关键词 (action=search 时使用)' },
        q: { type: 'string', description: '检索关键词别名 (同 query)' },
        count: { type: 'integer', minimum: 1, maximum: 20, default: 3, description: '采样会话数 (action=tail 时使用)' },
        perSession: { type: 'integer', minimum: 1, maximum: 20, default: 2, description: '每会话消息数 (action=tail 时使用)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_agent',
    description: '主工作区通用智能体调度与执行：支持全自动下发提示词与自动切会话(send)、等待并收取任务产出(result)、终止当前轮次生成(stop)、新建任务视图(new)。外部 Agent 无需接触任何 UI 坐标。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['send', 'result', 'stop', 'new'],
          default: 'send',
          description: '操作类型：send=发送指令并执行, result=等待并获取结果, stop=终止当前轮次, new=新建任务',
        },
        message: { type: 'string', description: '待发送指令或提示词 (action=send 时必需)' },
        text: { type: 'string', description: '指令内容别名 (同 message)' },
        content: { type: 'string', description: '指令内容别名 (同 message)' },
        sessionId: { type: 'string', description: '目标会话 ID (send 时指定代码自动切会话；result/stop 时指定目标会话)' },
        session: { type: 'string', description: '目标会话 ID 别名 (同 sessionId)' },
        newSession: { type: 'boolean', default: false, description: 'true=自动创建并切换至新任务会话 (action=send 时生效)' },
        send: { type: 'boolean', default: false, description: 'true=触发发送执行, false=仅填入待确认 (action=send 时生效)' },
        quietSeconds: { type: 'integer', minimum: 0, default: 300, description: '静默保护阈值秒数 (action=send 时生效)' },
        force: { type: 'boolean', default: false, description: 'true=跳过活跃守卫强制执行 (action=send/stop 时生效)' },
        preview: { type: 'boolean', default: false, description: 'true=仅预览目标状态不修改 (action=send 时生效)' },
        at: { type: 'string', description: '可选坐标"x,y"(备用或调试)' },
        timeoutSeconds: { type: 'integer', minimum: 0, maximum: 300, default: 0, description: '等待超时秒数，0为非阻塞即时返回 (action=result 时使用)' },
        afterMessageId: { type: 'integer', minimum: 0, description: '消息基线 ID (action=result 时使用)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_bot',
    description: 'MiniMax Bot 团队全功能协同：查看团队名册与流水线架构(roster)、向指定群聊或专家发送指令(send)、读取对话历史(read)、取消轮次(cancel)、恢复待处理消息(resume)、答复卡片问卷(answer)。支持「剪辑师」「导演」「幸喵剪辑室」等中文别名。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['roster', 'send', 'read', 'cancel', 'resume', 'answer'],
          default: 'roster',
          description: '操作类型：roster=名册与流水线架构, send=发送指令, read=读取历史消息, cancel=取消轮次, resume=恢复待处理, answer=提交卡片答案',
        },
        target: { type: 'string', description: '目标名称或 ID（如「剪辑师」、「导演」、「幸喵剪辑室」、「bot:bot_...」、「group:grp_...」）' },
        chatId: { type: 'string', description: '目标会话 ID 别名 (同 target)' },
        text: { type: 'string', description: '发送的文本指令 (action=send 时必需)' },
        mode: { type: 'string', enum: ['direct', 'group'], default: 'direct', description: '目标为成员 Bot 时：direct=1对1私聊，group=群聊并自动添加 @Bot名' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: '读取历史消息数量 (action=read 时使用)' },
        messageId: { type: 'string', description: '问卷卡片消息 ID (action=answer 时必需)' },
        answers: { type: 'object', description: '问卷卡片答案键值对 (action=answer 时必需)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_questionnaire',
    description: '人工问卷与审批卡片生命周期管控：列出当前待回答问卷(list)、获取问卷题目与策略推荐草稿(draft)、自动提交选定答案(answer)。代码全自动派发 DOM，外部 Agent 零坐标操作。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'draft', 'answer'],
          default: 'list',
          description: '操作类型：list=列出待回答问卷, draft=生成草稿推荐, answer=提交选项回答',
        },
        requestId: { type: 'string', description: '问卷请求 ID (action=draft 或 answer 时必需)' },
        id: { type: 'string', description: '问卷请求 ID 别名 (同 requestId)' },
        selections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              stepId: { type: 'string' },
              optionIds: { type: 'array', items: { type: 'string' } },
            },
            required: ['stepId', 'optionIds'],
          },
          description: '选项配置列表 (action=answer 时使用，不传则使用推荐答案)',
        },
        preview: { type: 'boolean', default: true, description: 'true=仅预览点击方案不修改状态 (action=answer 时生效)' },
        force: { type: 'boolean', default: false, description: 'true=确认真实提交 (action=answer 时生效)' },
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
