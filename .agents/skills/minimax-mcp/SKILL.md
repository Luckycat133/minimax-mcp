---
name: minimax-mcp
description: "Operate, monitor, diagnose, and auto-resume MiniMax Code on macOS via minimax-mcp. Use whenever inspecting MiniMax session progress, checking brief status, auto-resuming paused queues after quota refresh, healing Telegram channel deadlocks, drafting questionnaire answers, sending prompts, or interacting with MiniMax desktop agents with minimal token consumption."
license: MIT
metadata:
  author: minimax-mcp
  version: "0.3.0"
  openclaw:
    requires:
      bins:
        - node
        - python3
        - sqlite3
---

# MiniMax Code MCP 智能体操作最佳实践指南

本指南专为 AI Agent（Antigravity、Claude、Cursor 等）设计，指导 Agent 高效、低 Token 消耗、高可靠地调度 `minimax-mcp` 的 23 项高阶工具，接管并自愈本地 MiniMax Code 桌面客户端与其内置的 Agent 执行容器（Agent Harness）。

---

## 核心架构原则：目标优先 (Target-First) 与代码全自动执行

MiniMax Code 不是供外部智能体手工计算坐标模拟点击的网页，而是一个**本地 Agent 执行容器**。`minimax-mcp` 彻底剔除了低级 UI 模拟工具（坐标点击、物理按键、OCR 盲扫），将所有切换会话、注入提示词、点击发送、解锁队列等操作收敛于**底层代码全自动执行**。

### 极速决策双轨模型：先选对话类型

MiniMax 内部拥有两个截然不同的对话世界，调度前首先明确目标：

1. **主工作区通用智能体 (Native Agent Harness)**：
   - 标识：`mvs_*` 会话 ID（如写代码、项目重构、系统诊断等）。
   - 调度：通过 `minimax_list_sessions` 或 `minimax_brief` 探查；通过 `minimax_send_message` 自动下发任务（支持直接传 `sessionId` 自动切换或 `newSession: true` 自动开新任务）；通过 `minimax_get_result` 收取产出。外部 Agent 无需接触任何坐标。
2. **专业 Bot 团队 (Bot Studio)**：
   - 标识：群聊（如「幸喵剪辑室」流水线）与专家成员（「导演」、「剪辑师」[操作达芬奇]、「字幕」、「混音」、「包装」、「质检」、「Chief」）。
   - 调度：通过 `minimax_bot_roster` 查看完整流水线与专家名册；通过 `minimax_bot_message` 以**人类可读中文名**直接派发任务或读历史（如 `target: "剪辑师"`）；通过 `minimax_bot_turn` 管控轮次或卡片答复。

### 自动化与省 Token 铁律

1. **第一步查态势**：永远优先调用 `minimax_status` 或 `minimax_brief`，禁止盲目全量拉取 `minimax_list_sessions`。
2. **CDP 离线自愈**：若 `minimax_status` 报告 `cdp.online === false`，调用 `minimax_activate({ relaunchWithDebug: true })` 自动挂载调试端口，无需人工干预。
3. **额度阻断与队列死锁**：若会话因 Token Plan 超限（`42212`/`2056`）或 Telegram 报“本次请求处理失败”导致队列锁死，调用 `minimax_auto_resume` 自动解开死锁并断点续传。
4. **拒绝手写轮询循环**：严禁在终端手写 `while true; sleep 5; ...`；获取任务结果使用 `minimax_get_result`，原生支持带超时的非阻塞/阻塞事件等待。

---

## 常用工作流决策树 (Recipes)

### 工作流 1：全局全景体检与自愈

```javascript
// 1. 获取四维全景状态（App 运行、CDP 连接、额度重置精确时间、数据库及 Bot 团队状态）
minimax_status {}

// 2. 判定 CDP 状态：
// 若返回 "cdp": { "online": false } 且 "app": { "running": true }
// 立即自动优雅重启并挂载 9223 端口：
minimax_activate { relaunchWithDebug: true }

// 3. 读取高优先级注意力队列（自动过滤 200+ 沉睡会话，只报等你决定、报错、卡住的任务）
minimax_brief {}
```

---

### 工作流 2：MiniMax Bot 团队名册与人类可读交互

MiniMax 内置了专业的长效 Bot 团队（如「幸喵剪辑室」达芬奇剪辑生产线）。

```javascript
// 1. 查看团队名册与流水线架构（零开销只读，支持离线）
minimax_bot_roster {}
// 返回流水线结构：导演 → 剪辑师 → 字幕 → 混音 → 包装 → 质检
// 以及各 Bot 的角色、指令摘要、达芬奇 MCP 工具绑定与底层 sessionId

// 2. 直接以人类可读中文名读取历史消息：
minimax_bot_message { target: "剪辑师", action: "read", limit: 5 }

// 3. 以 1 对 1 私聊形式向剪辑师派活：
minimax_bot_message { target: "剪辑师", text: "请检查达芬奇工程时间线上的音频真峰值", mode: "direct" }

// 4. 在群聊中呼叫特定成员接力：
minimax_bot_message { target: "剪辑师", text: "请接力剪辑", mode: "group" }
// 代码会自动在群聊「幸喵剪辑室」中自动补充「@剪辑师 请接力剪辑」

// 5. 管控 Bot 团队轮次（取消卡死轮次或答复问卷卡片）：
minimax_bot_turn { target: "剪辑师", action: "cancel" }
```

---

### 工作流 3：原生工作区 Agent 会话调度与全自动执行

外部 Agent 无需接触任何 UI 坐标，代码内部自动完成会话切换与事件触发：

```javascript
// 1. 向指定已有会话追加指令（代码内部自动切换至该会话并发送）：
minimax_send_message {
  sessionId: "mvs_f9e205532746498192570cef5f9de1d4",
  message: "请继续运行第三阶段集成测试",
  send: true,
  force: true
}

// 2. 全自动创建并启动新任务：
minimax_send_message {
  newSession: true,
  message: "分析当前目录并重构冗余模块",
  send: true
}

// 3. 阻塞或非阻塞收取任务产出（无需手写 bash 轮询）：
minimax_get_result {
  sessionId: "mvs_f9e205532746498192570cef5f9de1d4",
  timeoutSeconds: 300
}
```

---

### 工作流 4：额度恢复与队列断点续传（涵盖 Telegram 机器人死锁自愈）

MiniMax 在遇到配额耗尽（`42212` / `2056`）或 Telegram 渠道 Turn 熔断时，会在 SQLite 中插入 `local_runtime_queue_pauses`，导致后续用户输入全部报“本次请求处理失败”。

```javascript
// 1. 先预览有哪些挂起或阻断的会话（dryRun: true，安全只读）
minimax_auto_resume { dryRun: true, limit: 5 }

// 2. 确认额度可用，执行真实批量自愈续传：
minimax_auto_resume { dryRun: false, limit: 5 }
// 该操作会自动：
// a) 清理 SQLite 中的 queue pause 熔断锁；
// b) 重置会话状态为 idle；
// c) 通过 CDP 自动点击前端「继续队列消息」或「继续执行」DOM 按钮；
// d) 对 MiniMax Bot 团队下发 resumePending 推进指令。
```

---

### 工作流 5：人工问卷与审批卡片自动化处理

MiniMax 执行复杂任务遇到歧义会弹出问卷（`status: pending`）：

```javascript
// 1. 查看当前是否有待回答的审批或问卷：
minimax_pending {}

// 2. 获取问卷详情与推荐选项（只读，含原题、选项与策略推荐）：
minimax_draft_answer { requestId: "ask_bc37658a86a5" }

// 3. 提交选定答案（验证数据库状态自动离开 pending）：
minimax_answer_question {
  requestId: "ask_bc37658a86a5",
  selections: [{ stepId: "step_1", optionIds: ["opt_agree"] }],
  preview: false,
  force: true
}
```

---

## 23 项工具完整风险矩阵速查

| 工具名称 | 权限级别 | 默认行为 | 关键参数与用途 |
| :--- | :---: | :---: | :--- |
| `minimax_brief` | `read` | 只读 | 态势简报，智能体决策首选入口 |
| `minimax_status` | `read` | 只读 | 探查 App/CDP/配额/数据库/Bot全景 |
| `minimax_bot_roster` | `read` | 只读 | 获取 Bot 团队架构、流水线与专家名册 |
| `minimax_bot_message` | `commit` | 发送/读取 | 与 Bot/群聊双向沟通，支持中文别名解析 |
| `minimax_bot_turn` | `commit` | 轮次管控 | 取消正在思考的轮次、恢复待处理消息或答题 |
| `minimax_send_message` | `commit` | `send: false` | 会话指令全自动派发（指定 sessionId 自动切换） |
| `minimax_get_result` | `read` | 智能等待 | 非轮询收取产出，支持 `timeoutSeconds` |
| `minimax_auto_resume` | `commit` | `dryRun: true` | 断点续传与死锁自愈（需传 `dryRun: false`） |
| `minimax_activate` | `ui` | 激活前台 | `relaunchWithDebug: true` 可自愈挂载 9223 端口 |
| `minimax_draft_answer`| `read` | 只读 | 读取人工问卷结构与策略推荐值 |
| `minimax_answer_question`| `commit` | `preview: true` | 提交问卷选项（需 `preview: false, force: true`） |
| `minimax_watch` | `commit` | 依策略执行 | 本地状态比对与低风险代答（后台守卫） |
| `minimax_events` | `read` | 只读 | 拉取巡检事件日志（支持 `since` 过滤） |
| `minimax_read_session`| `read` | 只读 | 分页精读指定原生会话的消息历史 |
| `minimax_tail_sessions`| `read` | 只读 | 一次性俯瞰最近 N 个会话最新进展 |
| `minimax_list_sessions`| `read` | 只读 | 列出原生会话列表（慎用，优先用 brief） |
| `minimax_search` | `read` | 只读 | 全文搜索会话标题与消息正文 |
| `minimax_pending` | `read` | 只读 | 查看当前待回答的人工问卷提问 |
| `minimax_tasks` | `read` | 只读 | 查看正在运行的后台代码/Shell 任务 |
| `minimax_windows` | `read` | 只读 | 探查屏幕与窗口几何布局 |
| `minimax_screenshot` | `ui` | 只读截屏 | 捕获 MiniMax 窗口截图（screen 或 region） |
| `minimax_new_task` | `ui` | 快速切换 | 高速切换至新建任务视图 |
| `minimax_stop_generation` | `ui` | 中断生成 | 快速截断当前轮次生成 |

---

## Agent 常见误区与避坑建议

❌ **误区 1**：试图使用模拟鼠标点击去切换会话或点发送按钮。  
✅ **正确做法**：直接调用 `minimax_send_message({ sessionId, message, send: true })`，底层代码通过 CDP 与 Mavis Store 秒级自动完成会话切换、焦点注入与发送触发，零视觉偏差。

❌ **误区 2**：在 Telegram 机器人遇到“本次请求处理失败”时盲目反复重新发消息。  
✅ **正确做法**：Turn 失败导致队列锁死在 SQLite 里，重发只会继续堆积。调用 `minimax_auto_resume({ dryRun: false })` 清除 `local_runtime_queue_pauses` 并激活前端队列继续即可。

❌ **误区 3**：不知道团队专家 Bot 的名字和 ID，无法与之协作。  
✅ **正确做法**：调用 `minimax_bot_roster` 查看完整名册，然后用 `minimax_bot_message({ target: "剪辑师", text: "..." })` 直接分发。
