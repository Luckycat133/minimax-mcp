---
name: minimax-mcp
description: "Operate, monitor, diagnose, and auto-resume MiniMax Code on macOS via minimax-mcp. Use whenever inspecting MiniMax session progress, checking brief status, auto-resuming paused queues after quota refresh, healing Telegram channel deadlocks, drafting questionnaire answers, sending prompts, or interacting with MiniMax desktop agents with minimal token consumption."
license: MIT
metadata:
  author: minimax-mcp
  version: "0.2.0"
  openclaw:
    requires:
      bins:
        - node
        - python3
        - sqlite3
---

# MiniMax Code MCP 智能体操作最佳实践指南

本指南专为 AI Agent（Antigravity、Claude、Cursor 等）设计，指导 Agent 高效、低 Token 消耗、高可靠地调度 `minimax-mcp` 的 27 项工具，接管并自愈本地 MiniMax Code 桌面客户端。

---

## 核心架构原则：先诊后断，省 90% Token

MiniMax 本地可能有上百个历史会话，**严禁一上来就调用 `minimax_list_sessions` 全量拉取**（会浪费数千 Token 且让模型迷失在旧数据中）。

### 极速决策铁律

1. **第一步查态势**：永远优先调用 `minimax_status` 或 `minimax_brief`。
2. **CDP 离线自愈**：若 `minimax_status` 返回 `cdp.online === false`，直接调用 `minimax_activate({ relaunchWithDebug: true })` 自动挂载调试端口，无需人工干预。
3. **额度阻断与队列死锁**：若会话因 Token Plan 超限（`42212`/`2056`）或 Telegram 报“本次请求处理失败”导致队列锁死，直接调用 `minimax_auto_resume` 自动解开死锁并续传。
4. **拒绝手写轮询循环**：严禁在终端手写 `while true; sleep 5; ...`；获取任务结果使用 `minimax_get_result`，它原生支持非阻塞或带超时的事件等待。
5. **免坐标意图驱动**：点击优先使用 `minimax_click_text`（DOM/OCR 语义定位），无需手算物理屏幕像素坐标。

---

## 常用工作流决策树 (Recipes)

### 工作流 1：全局全景体检与自愈

```javascript
// 1. 获取四维全景状态（App 运行、CDP 连接、额度剩余与重置倒计时、数据库队列）
minimax_status {}

// 2. 判定 CDP 状态：
// 若返回 "cdp": { "online": false } 且 "app": { "running": true }
// 立即自动优雅重启并挂载 9223 端口：
minimax_activate { relaunchWithDebug: true }

// 3. 读取高优先级注意力队列（自动过滤 200+ 沉睡会话，只报等你决定、报错、卡住的任务）
minimax_brief {}
```

---

### 工作流 2：额度恢复与队列断点续传（涵盖 Telegram 机器人死锁自愈）

MiniMax 在遇到配额耗尽（`42212` / `2056`）或 Telegram 渠道 Turn 熔断时，会在 SQLite 中插入 `local_runtime_queue_pauses`，导致后续用户输入全部报“本次请求处理失败”。

```javascript
// 1. 先预览有哪些挂起或阻断的会话（dryRun: true，安全只读）
minimax_auto_resume { dryRun: true, limit: 5 }

// 返回示例：
// {
//   "quotaAvailable": true,
//   "resumedCount": 2,
//   "results": [
//     { "sessionId": "mvs_xxx", "type": "channel", "action": "unpause_channel_queue", "planned": true }
//   ]
// }

// 2. 确认额度可用，执行真实批量自愈续传：
minimax_auto_resume { dryRun: false, limit: 5 }
// 该操作会自动：
// a) 清理 SQLite 中的 queue pause 熔断锁；
// b) 重置会话状态为 idle；
// c) 通过 CDP 自动点击前端「继续队列消息」或「继续执行」DOM 按钮；
// d) 对 MiniMax Bot 团队下发 resumePending 推进指令。
```

> **提示**：后台守护服务 `com.minimax-mcp.watch` 已默认在系统层注册，当额度刷新时刻（`resetAtMs`）到达时会自动触发上述流程。Agent 手动介入时也可随时一键调用。

---

### 工作流 3：安全下达指令与问卷交互

向会话输入内容受**活跃守卫**保护，防止把自动化消息插进用户正在键盘前输入的会话。

#### 发送会话消息
```javascript
// 1. 安全预览（不点不粘不发，告知目标坐标与正在忙碌的会话）：
minimax_send_message { message: "请继续完成第 3 阶段重构", send: true, preview: true }

// 2. 真实下发（send: true，若刚有活动可加 force: true）：
minimax_send_message { message: "请继续完成第 3 阶段重构", send: true, force: true }
```

#### 问卷代答 (Questionnaires)
MiniMax 执行复杂任务遇到歧义会弹出问卷（`status: pending`）：
```javascript
// 1. 获取问卷详情与推荐选项（只读，含原题、选项与策略推荐）：
minimax_draft_answer { requestId: "ask_bc37658a86a5" }

// 2. 预览点击计划（不真实触发提交）：
minimax_answer_question { requestId: "ask_bc37658a86a5", preview: true }

// 3. 提交选定答案（验证数据库状态自动离开 pending）：
minimax_answer_question {
  requestId: "ask_bc37658a86a5",
  selections: [{ stepId: "step_1", optionIds: ["opt_agree"] }],
  preview: false,
  force: true
}
```

---

### 工作流 4：收取长任务最终结果（非阻塞 / 阻塞）

```javascript
// 发送消息后，使用 minimax_get_result 等待跑完，无需手写轮询：
minimax_get_result {
  sessionId: "mvs_f9e205532746498192570cef5f9de1d4",
  afterMessageId: 16350,
  timeoutSeconds: 300
}
// 判定标准：会话回到 idle 且最后一条 assistant 消息有实际正文。
// 若 timeoutSeconds: 0，则执行非阻塞即时探查，瞬间返回当前状态。
```

---

### 工作流 5：MiniMax Bot 团队对话协作

通过 CDP 自动嗅探内部动态端口与鉴权令牌，完全无需外部 18888 代理常驻：

```javascript
// 发送团队协作消息：
minimax_bot_message {
  action: "send",
  chatId: "group:grp_d631733f2e13",
  text: "@剪辑师 请合并音频轨并输出预览"
}

// 恢复挂起状态：
minimax_bot_message {
  action: "resume",
  chatId: "group:grp_d631733f2e13"
}
```

---

## 27 项工具风险矩阵速查

| 工具名称 | 权限级别 | 默认行为 | 关键参数与用途 |
| :--- | :---: | :---: | :--- |
| `minimax_brief` | `read` | 只读 | 态势简报，智能体决策首选入口 |
| `minimax_status` | `read` | 只读 | 探查 App/CDP/配额/数据库全景 |
| `minimax_auto_resume` | `commit` | `dryRun: true` | 断点续传与死锁自愈（需传 `dryRun: false`） |
| `minimax_activate` | `ui` | 激活前台 | `relaunchWithDebug: true` 可自愈挂载 9223 端口 |
| `minimax_get_result` | `read` | 智能等待 | 非轮询收取产出，支持 `timeoutSeconds` |
| `minimax_draft_answer`| `read` | 只读 | 读取人工问卷结构与策略推荐值 |
| `minimax_answer_question`| `commit` | `preview: true` | 提交问卷选项（需 `preview: false, force: true`） |
| `minimax_send_message` | `commit` | `send: false` | 会话输入指令（需 `send: true`） |
| `minimax_click_text` | `ui` | 点击文本 | 按 DOM 文本或 OCR 中心点击 |
| `minimax_find_text` | `read` | 只读搜索 | 返回目标文本在窗口中的相对坐标 |
| `minimax_bot_message` | `commit` | 发送/操作 | Bot 团队收发与状态管理 |
| `minimax_watch` | `read/ui` | 依策略执行 | 本地状态比对与低风险代答 |
| `minimax_events` | `read` | 只读 | 拉取巡检事件日志（支持 `since` 过滤） |
| `minimax_read_session`| `read` | 只读 | 分页精读指定会话的消息历史 |
| `minimax_tail_sessions`| `read` | 只读 | 一次性俯瞰最近 N 个会话最新进展 |
| `minimax_list_sessions`| `read` | 只读 | 列出会话列表（慎用，优先用 brief） |
| `minimax_search` | `read` | 只读 | 全文搜索会话标题与消息正文 |
| `minimax_pending` | `read` | 只读 | 查看当前待回答的人工问卷提问 |
| `minimax_tasks` | `read` | 只读 | 查看正在运行的后台代码/Shell 任务 |
| `minimax_windows` | `read` | 只读 | 探查屏幕与窗口几何布局 |
| `minimax_screenshot` | `read` | 只读 | 捕获 MiniMax 窗口截图（screen 或 region） |
| `minimax_new_task` | `ui` | 切换视图 | 打开新建任务页面（快捷键 ⌘N） |
| `minimax_open_session` | `ui` | 点击切换 | 根据标题或 ID 切换到目标会话 |
| `minimax_click` | `ui` | 模拟点击 | 按物理坐标点击屏幕 |
| `minimax_type` | `ui` | 模拟键入 | 往当前输入框键入文本（受活跃守卫保护） |
| `minimax_key` | `ui` | 模拟按键 | 发送特定按键组合（支持 modifiers） |
| `minimax_stop_generation` | `ui` | 中断生成 | 按 Esc 终止当前轮次生成 |

---

## Agent 常见误区与避坑建议

❌ **误区 1**：发现无法操作界面就直接向用户求助报错。  
✅ **正确做法**：先调 `minimax_status`。如果 `cdp.online === false`，调用 `minimax_activate({ relaunchWithDebug: true })` 让其自动自愈挂载调试端口，再重试操作。

❌ **误区 2**：在 Telegram 机器人遇到“本次请求处理失败”时盲目反复重新发消息。  
✅ **正确做法**：Turn 失败导致队列锁死在 SQLite 里，重发只会继续堆积。调用 `minimax_auto_resume({ dryRun: false })` 清除 `local_runtime_queue_pauses` 并激活前端队列继续即可。

❌ **误区 3**：等待任务完成手写 bash while sleep 轮询。  
✅ **正确做法**：调用 `minimax_get_result({ sessionId, afterMessageId, timeoutSeconds: 300 })`，底层会自动监听状态并在 idle 时瞬间回调。
