---
name: minimax-mcp
description: "Operate and monitor MiniMax Code on macOS via minimax-mcp. Use whenever inspecting MiniMax session progress, checking status and quota, sending prompts to native agent harness, collaborating with MiniMax Bot Studio teams, or answering interactive question cards with minimal token consumption."
license: MIT
metadata:
  author: minimax-mcp
  version: "0.5.0"
  openclaw:
    requires:
      bins:
        - node
        - python3
        - sqlite3
---

# MiniMax Code MCP 智能体操作最佳实践指南 (Domain-Driven Core Architecture)

本指南专为 AI Agent（Antigravity、Claude、Cursor 等）设计，指导 Agent 高效、低 Token 消耗、高可靠地调度 `minimax-mcp` 的 **5 项核心领域工具**，无缝对接本地 MiniMax Code 桌面客户端与其内置的 Agent 执行容器（Agent Harness）。

---

## 核心理念：AI 专注对话与任务调度，底层自动接管 UI 与会话

对外部 AI 而言，操作 MiniMax 的核心需求非常纯粹：
1. **查看状态与额度**：确认 MiniMax 运行状态、CDP 9223 端口是否在线、查看 Token 额度与刷新倒计时；
2. **查找与精读对话**：先在本地 SQLite 找会话、翻历史、搜索上下文；
3. **分对象调度对话**：
   - 与**原生工作区智能体**对话（让 MiniMax 在自己的工作区 harness 里跑任务，下发指令并等待结果）；
   - 与 **MiniMax Bot 团队**对话（向「剪辑师」「导演」等专家或群聊发指令、读回复）；
4. **人工卡片与问卷应答**：处理 MiniMax 提出的人工决策卡片。

> [!NOTE]
> **全自动 UI 与会话接管**：
> MiniMax 是一个在自身 Harness 里运行的 Agent 容器。本 MCP 负责让外部 Agent 能够自动化调度它：会话切换、窗口激活、文本注入与发送均由底层代码通过 CDP / GUI 全自动完成，外部 Agent 零物理坐标感知。当额度耗尽时，直接通过 `minimax_status` 了解刷新倒计时，并在额度恢复后继续推进任务。

---

## 5 大核心工具与智能动作推断

| 工具名称 | 核心职责 | 多层触发动作 (`action`) | 智能动作推断 (可省略 action) |
|---|---|---|---|
| `minimax_status` | 查看运行状态、CDP 连接、额度刷新倒计时与注意力概况 | *(只读一体化探针)* | 包含 `app`、`cdp`、`quota` 与 `attention` 摘要 |
| `minimax_session` | 查找对话、翻阅历史、多会话采样与全文检索 | `list` \| `read` \| `tail` \| `search` | 传 `session`/`sessionId` 自动推断为 `read`；传 `query`/`q` 自动推断为 `search`；传 `count` 自动推断为 `tail`；默认 `list` |
| `minimax_agent` | 与原生工作区智能体对话（下发任务/获取结果/新建任务/停止） | `send` \| `result` \| `stop` \| `new` | 传 `message`/`text` 自动推断为 `send`；传 `timeoutSeconds` 自动推断为 `result`；自动切会话与激活窗口 |
| `minimax_bot` | 与 MiniMax Bot 团队协同（流水线名册/发指令/读回复/取消轮次） | `roster` \| `send` \| `read` \| `cancel` \| `resume` \| `answer` | 传 `text` 自动推断为 `send`；传 `target` 自动推断为 `read`；默认 `roster`；支持「剪辑师」「导演」等中文名 |
| `minimax_questionnaire` | 人工决策卡片与审批管理（待办列表/草稿方案/提交答案） | `list` \| `draft` \| `answer` | 传 `requestId` 自动推断为 `draft`；传 `selections` 自动推断为 `answer`；默认 `list`（待审批队列） |

---

## 最佳工作流实践 (Recipes)

### 场景 1：探查状态与额度 (Check Health & Quota)
外部 Agent 在调度前，先看一次状态：
```json
// 调用
minimax_status({})

// 返回示例
{
  "app": { "running": true, "pid": 12345 },
  "cdp": { "online": true, "port": 9223 },
  "quota": {
    "isLimited": false,
    "waitSeconds": 0,
    "countdownText": "正常可用"
  },
  "attention": {
    "headline": "都很安静（24 个会话没有新动静）",
    "pendingQuestions": 0
  }
}
```

### 场景 2：先找对话，再向原生智能体下发任务
外部 Agent 需要让 MiniMax 协助完成工程重构或代码生成：
```json
// 步骤 1：找会话
minimax_session({ action: "search", query: "Blender 立冬" })

// 步骤 2：下发任务（代码会自动切换至该 sessionId，无需人工点选）
minimax_agent({
  sessionId: "mvs_xxx",
  message: "请帮我把这个 Blender 场景中的冰雪材质折射率从 1.31 改为 1.333",
  send: true
})

// 步骤 3：等待并收取结果
minimax_agent({
  action: "result",
  sessionId: "mvs_xxx",
  timeoutSeconds: 120
})
```

### 场景 3：与 MiniMax Bot 团队专家协同
向 Bot Studio 中的特定专家（如达芬奇剪辑师）派发视频剪辑任务：
```json
// 步骤 1：查看专家名册与群聊流水线
minimax_bot({ action: "roster" })

// 步骤 2：直接用中文名派发指令（代码自动解析具体 Bot ID 并处理群聊/私聊前缀）
minimax_bot({
  target: "剪辑师",
  text: "请把第 3 个镜头的时间线向右微调 12 帧，并加上交叉溶解转场"
})

// 步骤 3：读取剪辑师回复
minimax_bot({
  target: "剪辑师",
  limit: 5
})
```

### 场景 4：处理决策卡片与人工审批
当 `minimax_status` 报告 `pendingQuestions > 0` 时：
```json
// 步骤 1：查看待处理卡片
minimax_questionnaire({ action: "list" })

// 步骤 2：获取问卷推荐草稿方案
minimax_questionnaire({ action: "draft", requestId: "ask_xxx" })

// 步骤 3：确认真实提交（默认 preview:true，确认提交需 preview:false + force:true）
minimax_questionnaire({
  action: "answer",
  requestId: "ask_xxx",
  preview: false,
  force: true
})
```

---

## 守卫与安全设计

1. **活跃用户守卫（Quiet Guard）**：
   `minimax_agent` 发送消息前会检测目标会话是否在最近 300 秒内有活动。若人类用户正在打字操作，工具会主动拒绝发送并报错，避免干扰用户正常工作；如需强行推进可显式设置 `force: true`。
2. **预览优先策略**：
   所有高风险写入操作（`send`、`answer`）默认均为预览模式（`send: false` 或 `preview: true`），只有明确声明动作参数才会真实提交修改。
3. **零坐标暴露与 CDP 极速通信**：
   所有会话切换与输入均优先走 CDP 9223 端口直接与渲染进程通信，亚毫秒级响应，外部无需安装或维护任何辅助功能点击坐标。
