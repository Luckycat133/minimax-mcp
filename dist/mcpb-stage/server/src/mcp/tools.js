'use strict';

/**
 * tools.js — 工具面定义。每个工具单一意图，参数尽量少。
 *
 * 只读工具直接查 MiniMax 自己的 SQLite；控制工具走 GUI 驱动，且都带「前台校验」。
 */

const TOOLS = [
  {
    name: 'minimax_brief',
    description:
      '态势快照：只告诉你「现在需要你看的事」，不把所有会话平铺出来。' +
      '按 等你决定 → 报错 → 卡住 → 在跑 → 刚完成 排序，每条带一句原因和下一步该调什么。' +
      '纯读数据库，随时可调。第一次接触 MiniMax 状态时先调这个，不要一上来就 list_sessions。',
    inputSchema: {
      type: 'object',
      properties: {
        stalledMinutes: { type: 'integer', minimum: 1, default: 10, description: '末条是用户消息、超过这么久没回就算卡住' },
        activeMinutes: { type: 'integer', minimum: 1, default: 10, description: '这么久内有新消息就算在跑' },
        finishedMinutes: { type: 'integer', minimum: 1, default: 60, description: '这么久内跑完算刚完成' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 200, description: '扫多少个最近会话' },
      },
      additionalProperties: false,
    },
  },
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
        includeThinking: { type: 'boolean', default: false, description: '是否包含思考过程（体积会大很多）' },
        before: { type: 'integer', minimum: 1, description: '从这个消息 id 之前开始读，用于往前翻页；返回里的 oldestId 就是下次的 before' },
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
      '不用自己轮询。判定"跑完"的依据是会话状态回到 idle 且最后一条助手消息有正文。' +
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
    name: 'minimax_draft_answer',
    description:
      '读一条待回答的提问/问卷，返回问题全文、全部选项（含 recommended 标记），' +
      '以及一份按 recommended 生成的建议答案和对应的 reply payload。纯只读，不提交任何东西。' +
      '答了等于替用户做决定，所以默认只出草稿。',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'minimax_pending 返回的 requestId' },
      },
      required: ['requestId'],
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_answer_question',
    description:
      '向 MiniMax 提交一条提问的回答。**默认只 preview**：报告会点什么、提交什么 payload，不做任何动作。' +
      'preview:false 才真的操作 GUI，且需要 force:true——这是在替用户做决定。' +
      '注意：GUI 提交路径尚未用真实问卷验证过（没有可测的 pending 提问），用前先 preview 并截图核对。',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string' },
        selections: {
          type: 'array',
          description: '每题选中的 optionId；省略则用 recommended 那份',
          items: {
            type: 'object',
            properties: { stepId: { type: 'string' }, optionIds: { type: 'array', items: { type: 'string' } } },
            required: ['stepId', 'optionIds'],
          },
        },
        preview: { type: 'boolean', default: true },
        force: { type: 'boolean', default: false },
        at: { type: 'string', description: '问卷第一个选项的坐标 "x,y"，不传则需先截图确定' },
      },
      required: ['requestId'],
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_new_task',
    description:
      '在 MiniMax 里新建一个任务页（按 ⌘N）。会对比按键前后的窗口列表来确认是否真的开出来了。' +
      '注意新建任务页可能是一个独立窗口，之后发消息要用 layout:"newtask" 或显式 at 坐标。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'minimax_open_session',
    description:
      '切换到某个会话。默认用会话标题在左侧栏里 OCR 定位并点击（只认最左那一列，避免点到顶栏的同名标题）；' +
      '标题在侧栏被截断或滚出视野时，可以用 at 显式给坐标。找不到就不点，返回 tried 和提示。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: '会话 ID 或 minimax_list_sessions 的序号' },
        at: { type: 'string', description: '可选：侧栏里该条目的坐标 "x,y"，给了就不做 OCR 定位' },
      },
      required: ['session'],
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_stop_generation',
    description: '让 MiniMax 停止当前这轮生成（按 Esc）。只发按键，不点任何按钮，可逆。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'minimax_watch',
    description:
      '跑一轮主动巡检：比对上次快照，产出「新事件」，并按策略自动处理低风险的事。' +
      '动作类型：跑完/报错/恢复/新提问/卡住/后台任务失败。' +
      '自动执行的门槛是「风险低 + 有推荐答案 + 人已离开 ≥minIdleSeconds + 每轮限额」，' +
      '任何涉及钱、发布、删除、凭证、对外承诺的问题一律不自动，只进 needsHuman。' +
      'dryRun=true 只算不做。首次调用只建基线，不产生事件。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['tick', 'status', 'reset', 'config'], default: 'tick', description: 'config=读写持久化策略（给定时任务用）' },
        dryRun: { type: 'boolean', default: false, description: 'true=只报告会做什么，不执行任何动作' },
        policy: {
          type: 'object',
          description: '策略覆盖，只写要改的字段',
          properties: {
            mode: { type: 'string', enum: ['off', 'observe', 'act'], default: 'act' },
            riskCeiling: { type: 'string', enum: ['low', 'medium'], default: 'low' },
            minIdleSeconds: { type: 'integer', minimum: 0, default: 180, description: '人离开多久才允许自动动界面' },
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
            allowSessions: { type: 'array', items: { type: 'string' }, description: '只对这些会话生效；不给=全部' },
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
    description:
      '读巡检事件队列（minimax_watch 每轮写入的）。用于拉取「我不在的时候发生了什么」。' +
      '纯读文件，无副作用。事件类型：finished / error / recovered / question / stalled / task_failed / auto_action。',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'ISO 时间或毫秒时间戳；不给则返回最近的' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_find_text',
    description:
      '在屏幕上按文字定位元素，返回它的屏幕点坐标（macOS Vision OCR，支持中英文）。' +
      '这是给 minimax_click 找坐标的正规做法——比让模型看截图估坐标可靠得多。' +
      '默认只扫 MiniMax 窗口；要扫别处用 region。只读，不点任何东西。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要找的文字，可只给片段' },
        mode: { type: 'string', enum: ['contains', 'exact', 'prefix'], default: 'contains' },
        index: { type: 'integer', minimum: 0, default: 0, description: '命中多个时取第几个（按匹配度排序）' },
        region: {
          type: 'object',
          description: '扫描区域（屏幕点）；省略则扫 MiniMax 主窗口',
          properties: {
            x: { type: 'number' }, y: { type: 'number' },
            width: { type: 'number' }, height: { type: 'number' },
          },
          required: ['x', 'y', 'width', 'height'],
          additionalProperties: false,
        },
        refresh: { type: 'boolean', default: true, description: 'true=重新截屏；false=复用 3 秒内的识别结果' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'minimax_click_text',
    description:
      '找到屏幕上的某段文字并点击它的中心。比手算坐标可靠，适合点按钮、选项、菜单项。' +
      '会做遮挡检查；默认只点 MiniMax 窗口内的文字。不确定时先用 minimax_find_text 看命中情况。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        mode: { type: 'string', enum: ['contains', 'exact', 'prefix'], default: 'contains' },
        index: { type: 'integer', minimum: 0, default: 0 },
        region: {
          type: 'object',
          properties: {
            x: { type: 'number' }, y: { type: 'number' },
            width: { type: 'number' }, height: { type: 'number' },
          },
          required: ['x', 'y', 'width', 'height'],
          additionalProperties: false,
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
];

const { annotate } = require('./annotations');

// 统一打上 title + MCP annotations（只读/可逆/提交三档见 annotations.js）
const ANNOTATED = annotate(TOOLS);
const TOOL_NAMES = ANNOTATED.map((t) => t.name);

module.exports = { TOOLS: ANNOTATED, TOOL_NAMES };
