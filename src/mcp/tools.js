'use strict';

/**
 * tools.js — MiniMax MCP 工具定义（Lean Token, Target-First & Agent Harness 规范版）。
 * 遵循 MCP 2024-11-05 规范：
 * 1. 彻底剔除底层低级 UI 模拟工具 (click/type/key/find_text/click_text/open_session)；
 * 2. 界面点击与会话切换全部收敛于底层代码全自动执行，外部 Agent 零坐标接触；
 * 3. 一级支持 MiniMax 双会话体系：工作区通用 Agent (Native Harness) 与 专业 Bot 团队 (Bot Studio)。
 */

const TOOLS = [
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
    name: 'minimax_status',
    description: '获取 MiniMax Code 本地状态：包含客户端连通性、CDP端口、额度重置精确时间、数据库及 Bot 团队状态。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'minimax_list_sessions',
    description: '列出 MiniMax 原生工作区会话列表，按最后活跃时间倒序，返回会话 ID 及序号。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: '返回条数' } },
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_read_session',
    description: '读取指定原生会话的历史消息。session 支持会话 ID (mvs_*) 或列表序号。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: '会话 ID 或序号' },
        sessionId: { type: 'string', description: '会话 ID 别名 (同 session)' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 30, description: '读取消息条数' },
        includeThinking: { type: 'boolean', default: false, description: '是否包含思维链(Token消耗较大)' },
        before: { type: 'integer', minimum: 1, description: '消息 ID 翻页锚点' },
      },
      required: ['session'],
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_tail_sessions',
    description: '快速采样最近 N 个会话的末尾消息，用于并发任务巡检。',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 20, default: 3, description: '会话数' },
        perSession: { type: 'integer', minimum: 1, maximum: 20, default: 2, description: '每会话消息数' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_search',
    description: '跨会话全文检索标题与消息内容，返回高亮聚焦上下文。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词' },
        q: { type: 'string', description: '检索关键词别名 (同 query)' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 10, description: '返回结果数量(默认10以节省Token)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_pending',
    description: '查询等待人工确认或答复的问卷与审批卡片。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
  {
    name: 'minimax_windows',
    description: '获取 MiniMax 窗口坐标与布局信息，用于置顶与运行环境检查。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'minimax_activate',
    description: '将 MiniMax 窗口唤醒至系统前台并返回焦点窗口信息。可指定 relaunchWithDebug 自动挂载调试端口。',
    inputSchema: {
      type: 'object',
      properties: {
        relaunchWithDebug: {
          type: 'boolean',
          description: '若 MiniMax 未开启 CDP 调试端口 (9223)，是否优雅重启并挂载调试端口。',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_screenshot',
    description: '获取 MiniMax 窗口截图。支持全屏(screen)或区域(region)，返回图片路径。',
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
    description: '向指定或当前 Agent 会话发送指令。全代码内建自动化：指定 sessionId 自动切换；newSession=true 自动开新任务；自动注入并点击发送。外部 Agent 无需接触任何 UI 坐标。',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '待发送指令或提示词' },
        text: { type: 'string', description: '待发送指令别名 (同 message)' },
        content: { type: 'string', description: '待发送指令别名 (同 message)' },
        sessionId: { type: 'string', description: '目标会话 ID (指定则后台代码自动切换至该会话)' },
        session: { type: 'string', description: '目标会话 ID 别名 (同 sessionId)' },
        newSession: { type: 'boolean', default: false, description: 'true=自动创建并切换至新任务会话' },
        send: { type: 'boolean', default: false, description: 'true=触发发送执行, false=仅填入待确认' },
        at: { type: 'string', description: '可选坐标"x,y"(备用或调试)' },
        quietSeconds: { type: 'integer', minimum: 0, default: 300, description: '静默保护阈值(秒)' },
        force: { type: 'boolean', default: false, description: 'true=跳过活跃守卫强制发送' },
        preview: { type: 'boolean', default: false, description: 'true=仅预览目标状态不修改' },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_get_result',
    description: '获取指定会话最近一轮任务执行结果，判断是否完成及提取最后产出。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID(默认最近活跃会话)' },
        session: { type: 'string', description: '会话 ID 别名 (同 sessionId)' },
        sinceMessageId: { type: 'integer', minimum: 1, description: '消息基线 ID' },
        timeoutSeconds: { type: 'integer', minimum: 0, maximum: 300, default: 0, description: '轮询等待超时(秒)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_draft_answer',
    description: '为待回答问卷生成草稿回答建议，只读无副作用。',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: '问卷请求 ID' },
        id: { type: 'string', description: '问卷请求 ID 别名 (同 requestId)' },
      },
      required: ['requestId'],
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_answer_question',
    description: '提交问卷回答。代码内部全自动派发 DOM 点击；默认 preview=true 仅预览方案；preview=false 且 force=true 实际提交。',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string' },
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
        },
        preview: { type: 'boolean', default: true },
        force: { type: 'boolean', default: false },
      },
      required: ['requestId'],
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_new_task',
    description: '新建任务。通过 CDP 高速切换至新建任务视图。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'minimax_stop_generation',
    description: '终止当前正在生成或运行中的会话任务。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 ID' },
        session: { type: 'string', description: '会话 ID 别名 (同 sessionId)' },
        force: { type: 'boolean', default: false },
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
    name: 'minimax_bot_roster',
    description: '获取 MiniMax Bot 团队架构与名册（群聊流水线、成员角色、工具与对应底层会话）。零开销只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'minimax_bot_message',
    description: '与 MiniMax Bot 团队沟通：向指定群聊或成员 Bot 发送指令，或读取团队最新对话。支持中文名智能解析（如「剪辑师」、「导演」、「幸喵剪辑室」）。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '目标名称或 ID（如「剪辑师」、「导演」、「幸喵剪辑室」、「bot:bot_...」、「group:grp_...」）' },
        chatId: { type: 'string', description: '目标会话 ID 别名 (同 target)' },
        text: { type: 'string', description: '发送的文本指令' },
        mode: { type: 'string', enum: ['direct', 'group'], default: 'direct', description: '目标为成员 Bot 时：direct=1对1私聊，group=群聊并自动添加 @Bot名' },
        action: { type: 'string', enum: ['send', 'read'], description: '操作类型 (默认有 text 则 send，无 text 则 read)' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: '读取历史消息数量' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_bot_turn',
    description: 'MiniMax Bot 团队轮次与卡片管控：取消正在执行的轮次、恢复待处理消息或提交问卷卡片答复。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '目标 Bot 或群聊名称/ID' },
        chatId: { type: 'string', description: '目标会话 ID 别名 (同 target)' },
        action: { type: 'string', enum: ['cancel', 'resume_pending', 'answer'], description: 'cancel=取消正在思考的轮次, resume_pending=恢复未处理消息, answer=提交卡片答案' },
        messageId: { type: 'string', description: '问卷卡片消息 ID（action=answer 时必填）' },
        answers: { type: 'object', description: '问卷卡片答案键值对（action=answer 时必填）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_auto_resume',
    description: '智能断点续传：自动识别因额度耗尽(2056)而挂起的会话，在额度恢复后自动继续（原生对话点播放键，Bot 对话推进轮次）。',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: { type: 'boolean', default: true, description: '是否只扫描计划而不实际触发' },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 5, description: '单次最多恢复会话数' },
        sessionId: { type: 'string', description: '指定恢复某个会话 ID' },
      },
      additionalProperties: false,
    },
  },
];

const { annotate } = require('./annotations');

// 统一打上 title + MCP annotations
const ANNOTATED = annotate(TOOLS);
const TOOL_NAMES = ANNOTATED.map((t) => t.name);

module.exports = { TOOLS: ANNOTATED, TOOL_NAMES };
