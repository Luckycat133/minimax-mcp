---
name: minimax-mcp
description: "Operate, monitor, diagnose, and auto-resume MiniMax Code on macOS via minimax-mcp. Use whenever inspecting MiniMax session progress, checking brief status, auto-resuming paused queues after quota refresh, healing Telegram channel deadlocks, drafting questionnaire answers, sending prompts, or interacting with MiniMax desktop agents with minimal token consumption."
license: MIT
metadata:
  author: minimax-mcp
  version: "0.4.0"
  openclaw:
    requires:
      bins:
        - node
        - python3
        - sqlite3
---

# MiniMax Code MCP 智能体操作最佳实践指南 (Tiered Architecture)

本指南专为 AI Agent（Antigravity、Claude、Cursor 等）设计，指导 Agent 高效、低 Token 消耗、高可靠地调度 `minimax-mcp` 的 **11 项多层触发高阶工具**，接管并自愈本地 MiniMax Code 桌面客户端与其内置的 Agent 执行容器（Agent Harness）。

---

## 核心架构原则：渐进式披露与多层触发 (Tiered Progressive Disclosure)

MiniMax Code 不是供外部智能体手工计算坐标模拟点击的网页，而是一个**本地 Agent 执行容器**。`minimax-mcp` 彻底剔除了散落碎片化的底层 UI 工具，采用**二级动作（action）分层触发机制**：
- **Token 节约 60%+**：工具清单从 27+ 项大幅精简至 11 项，顶层上下文极为清爽；
- **自适应动作推理**：忘记传 `action` 时，工具会自动根据所传参数智能推断目标动作；
- **全自动代码闭环**：会话切换、聚焦输入、点击发送、解锁队列全由底层代码在 CDP / DOM / SQLite 层面自动闭环执行，外部 Agent 零物理坐标接触。

---

## 双轨对话模型决策树：先选对话类型

MiniMax 内部拥有两个截然不同的对话世界，调度前首先明确目标：

1. **主工作区通用智能体 (Native Agent Harness)**：
   - 标识：`mvs_*` 会话 ID（写代码、工程重构、终端执行等）。
   - 探索：调用 `minimax_session({ action: "list" })` 或 `minimax_session({ action: "read", sessionId: "mvs_..." })`。
   - 调度：调用 `minimax_agent({ action: "send", sessionId: "mvs_...", message: "...", send: true })` 自动切会话并发送。
   - 收取：调用 `minimax_agent({ action: "result", sessionId: "mvs_...", timeoutSeconds: 300 })`。
2. **专业 Bot 团队 (Bot Studio)**：
   - 标识：群聊流水线与专家 Bot（「导演」、「剪辑师」[操作达芬奇]、「字幕」、「混音」、「包装」、「质检」、「Chief」）。
   - 名册：调用 `minimax_bot({ action: "roster" })` 查看流水线与专家职责。
   - 对话：调用 `minimax_bot({ action: "send", target: "剪辑师", text: "..." })` 直接用**中文别名**派发任务。
   - 管控：调用 `minimax_bot({ action: "cancel", target: "剪辑师" })` 截断卡死轮次。

---

## 常用工作流决策树 (Recipes)

### 工作流 1：全局全景体检与自愈

```javascript
// 1. 获取四维全景状态（App 运行、CDP 连接、额度重置精确秒数、数据库、Bot 团队）
minimax_status {}

// 2. CDP 离线时自动挂载端口并激活前台：
// 若 cdp.online === false，一键自愈：
minimax_desktop { action: "activate", relaunchWithDebug: true }

// 3. 读取高优先级注意力队列（过滤 200+ 沉睡会话，只报等你决定、报错、卡住的任务）
minimax_brief {}
```

---

### 工作流 2：MiniMax Bot 团队协同 (minimax_bot 多层触发)

```javascript
// 1. 获取团队名册与流水线架构（只读，免开销）：
minimax_bot { action: "roster" }
// 返回「幸喵剪辑室」流水线：导演 → 剪辑师 → 字幕 → 混音 → 包装 → 质检

// 2. 读历史消息（容灾走磁盘/实时直连）：
minimax_bot { action: "read", target: "剪辑师", limit: 5 }

// 3. 1对1 私聊派发指令：
minimax_bot { action: "send", target: "剪辑师", text: "请复核达芬奇时间线上的真峰值", mode: "direct" }

// 4. 群聊点名接力（自动补充 @剪辑师 前缀）：
minimax_bot { action: "send", target: "剪辑师", text: "请接力剪辑", mode: "group" }

// 5. 轮次管控（取消卡死或恢复挂起）：
minimax_bot { action: "cancel", target: "剪辑师" }
minimax_bot { action: "resume", target: "剪辑师" }
```

---

### 工作流 3：原生工作区 Agent 调度 (minimax_agent & minimax_session)

```javascript
// 1. 会话探索与检索：
minimax_session { action: "list", limit: 10 }
minimax_session { action: "search", query: "Blender" }
minimax_session { action: "read", sessionId: "mvs_f9e205532746498192570cef5f9de1d4" }

// 2. 自动切换会话并派发指令（代码内部自动切会话、注入 TipTap 并点击发送）：
minimax_agent {
  action: "send",
  sessionId: "mvs_f9e205532746498192570cef5f9de1d4",
  message: "请继续运行第三阶段集成测试",
  send: true,
  force: true
}

// 3. 全自动新建任务：
minimax_agent {
  action: "send",
  newSession: true,
  message: "分析当前目录并重构冗余模块",
  send: true
}

// 4. 阻塞等待收取产出（无需手写 bash 轮询）：
minimax_agent {
  action: "result",
  sessionId: "mvs_f9e205532746498192570cef5f9de1d4",
  timeoutSeconds: 300
}
```

---

### 工作流 4：额度恢复与断点续传 (minimax_auto_resume)

MiniMax 在遇到配额耗尽（`42212` / `2056`）或 Telegram 渠道 Turn 熔断时，会在 SQLite 中插入 `local_runtime_queue_pauses`，导致后续用户输入全部报“本次请求处理失败”。

```javascript
// 1. 先预览有哪些挂起或阻断的会话（dryRun: true，安全只读）：
minimax_auto_resume { dryRun: true, limit: 5 }

// 2. 确认额度可用，执行真实批量自愈续传：
minimax_auto_resume { dryRun: false, limit: 5 }
// 自动清除 SQLite pause 锁、重置会话、通过 CDP 点击继续按钮。
```

---

### 工作流 5：人工问卷与审批卡片自动化处理 (minimax_questionnaire)

```javascript
// 1. 查看当前待处理的审批卡片与提问：
minimax_questionnaire { action: "list" }

// 2. 读取题目详情与策略推荐草稿：
minimax_questionnaire { action: "draft", requestId: "ask_bc37658a86a5" }

// 3. 提交选定答案：
minimax_questionnaire {
  action: "answer",
  requestId: "ask_bc37658a86a5",
  selections: [{ stepId: "step_1", optionIds: ["opt_agree"] }],
  preview: false,
  force: true
}
```

---

## 11 项精简工具完整矩阵速查

| 工具名称 | 权限级别 | 默认行为 | 多层动作 (Action) 与用途 |
| :--- | :---: | :---: | :--- |
| `minimax_brief` | `read` | 只读 | 态势简报，智能体决策首选入口 |
| `minimax_status` | `read` | 只读 | 探查 App/CDP/配额/数据库/Bot全景 |
| `minimax_session` | `read` | `list` | 原生会话统一探索：`list`(列出) / `read`(精读) / `tail`(采样) / `search`(全文搜) |
| `minimax_agent` | `commit` | `send` | 原生智能体调度：`send`(派发) / `result`(结果) / `stop`(终止) / `new`(新建) |
| `minimax_bot` | `commit` | `roster` | Bot团队协同：`roster`(名册) / `send`(发信) / `read`(读信) / `cancel` / `resume` / `answer` |
| `minimax_questionnaire` | `commit` | `list` | 问卷与审批卡片：`list`(待办) / `draft`(草稿) / `answer`(提交) |
| `minimax_desktop` | `ui` | `activate` | 桌面环境控制：`activate`(唤醒/CDP) / `screenshot`(截图) / `windows`(布局) |
| `minimax_auto_resume` | `commit` | `dryRun: true` | 断点续传与死锁自愈（需传 `dryRun: false`） |
| `minimax_watch` | `commit` | 依策略执行 | 本地状态比对与低风险代答（后台守卫） |
| `minimax_events` | `read` | 只读 | 拉取巡检事件日志（支持 `since` 过滤） |
| `minimax_tasks` | `read` | 只读 | 查看正在运行的后台代码/Shell 任务 |

---

## 动作自适应推断表（不传 action 时的智能兜底）

| 工具 | 传入关键参数 | 自动推断的 action |
| :--- | :--- | :--- |
| `minimax_session` | 传 `session` 或 `sessionId` | `read` |
| `minimax_session` | 传 `query` 或 `q` | `search` |
| `minimax_session` | 传 `count` 或 `perSession` | `tail` |
| `minimax_session` | 什么都不传 | `list` |
| `minimax_agent` | 传 `message` 或 `text` | `send` |
| `minimax_agent` | 传 `timeoutSeconds` 或 `afterMessageId` | `result` |
| `minimax_bot` | 传 `text` | `send` |
| `minimax_bot` | 传 `target` 且没传 `text` | `read` |
| `minimax_bot` | 传 `messageId` 与 `answers` | `answer` |
| `minimax_bot` | 什么都不传 | `roster` |
| `minimax_questionnaire` | 传 `selections` 或 `force` | `answer` |
| `minimax_questionnaire` | 传 `requestId` 或 `id` | `draft` |
| `minimax_questionnaire` | 什么都不传 | `list` |
| `minimax_desktop` | 传 `mode` 或 `width` | `screenshot` |
| `minimax_desktop` | 什么都不传 | `activate` |
