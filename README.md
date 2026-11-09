# minimax-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![MCP Specification](https://img.shields.io/badge/MCP-2024--11--05-blue.svg)](https://modelcontextprotocol.io/)
[![Smithery](https://smithery.ai/badge/@Luckycat133/minimax-mcp)](https://smithery.ai/server/@Luckycat133/minimax-mcp)
[![Glama](https://glama.ai/mcp/servers/Luckycat133/minimax-mcp/badge)](https://glama.ai/mcp/servers/Luckycat133/minimax-mcp)

**minimax-mcp** 是专为 **MiniMax Code** 桌面客户端（macOS）打造的本地优先 stdio MCP (Model Context Protocol) 服务器与 Agent 技能包。

它让任何接入 MCP 的 AI Agent（如 Claude Desktop、Cursor、Codex、Antigravity 等）能够无缝感知、监控和操控本机 MiniMax Code 的全部会话、后台任务、问卷决策与 Bot 团队。

```
┌────────────────────────────────────────────────────────┐
│                   Agent Host / Client                  │
│       (Claude Desktop, Cursor, Antigravity, etc.)      │
└───────────────────────────┬────────────────────────────┘
                            │ stdio (JSON-RPC 2.0)
┌───────────────────────────▼────────────────────────────┐
│                       minimax-mcp                      │
│     (27 Tools · 3 Risk Levels · Proactive Watcher)     │
└───────────┬────────────────────────────────┬───────────┘
            │                                │
      [Control Plane]                  [Data Plane]
            │                                │
 ┌──────────┴──────────┐            ┌────────┴──────────┐
 │ Chrome DevTools     │            │ Local SQLite DB   │
 │ Protocol (CDP)      │            │ Runtime State     │
 │ • DOM 级极速驱动    │            │ • 会话/消息历史   │
 │ • 0 系统权限要求    │            │ • 实时任务状态    │
 │ • 无视窗口遮挡/最小化│           │ • 待答问卷/审批   │
 └──────────┬──────────┘            └───────────────────┘
            │ Fallback
 ┌──────────┴──────────┐
 │ CoreGraphics / OCR  │
 │ • Vision 屏幕识别   │
 │ • 系统事件模拟      │
 └─────────────────────┘
```

---

## 🌟 核心特性

1. **双通道高性能控制**：
   - **控制面（Write）**：优先直连 **CDP (Chrome DevTools Protocol)** 端口，**0 系统辅助权限、0 录屏权限依赖、无视窗口遮挡与最小化**，微秒级操作 DOM 与 TipTap 富文本编辑器；非 CDP 环境下自动平滑降级至 CoreGraphics + macOS Vision OCR。
   - **观察面（Read）**：直读本机 SQLite 运行时状态，毫秒级感知任务完成、异常报错与会话流式变更，绝不污染客户端状态。
2. **态势快照与注意力队列 (`minimax_brief`)**：
   - 按 `等你决定 > 报错 > 卡住 > 运行中 > 刚完成` 动态聚合注意力队列，沉睡的百余个历史会话自动折叠，节省 90% 提示词 Token。
   - 每条条目自带结构化动作建议（`suggestedCall`），让纯文本或轻量级 Agent 零思考直接反射调用。
3. **主动巡检与低风险自愈 (`minimax_watch`)**：
   - 自动跟踪状态变化并进入事件队列（`minimax_events`）。
   - 内置纯函数风险策略引擎（四道安全闸门），支持自动催促卡住会话、低风险选项自动作答，高风险操作绝对保留给人。
4. **MiniMax Bot 团队集成与智能断点续传**：
   - 支持通过 `minimax_bot_message` 直连 MiniMax 专家/Bot 团队（群聊分发、单聊调度与轮次管理）。
   - 内置 `minimax_auto_resume`：自动识别因额度耗尽（2056）停下的长任务，在额度恢复后自动恢复（原生会话点击 ▶ 播放键原生继续，Bot 对话推进轮次）。

---

## 🛠️ 工具总览（27 个精细意图工具）

### 1. 观察与态势感知（只读，零副作用）

| 工具名 | 说明 |
|---|---|
| `minimax_brief` | **态势快照**：按优先级聚合待办会话与建议动作，节省 Token 首选 |
| `minimax_status` | 查看本地数据库路径、会话数、消息总数及活动状态 |
| `minimax_list_sessions` | 列出最近会话列表，返回会话 ID 及序号 |
| `minimax_read_session` | 读取指定会话的历史消息（支持会话 ID `mvs_*` 或列表序号） |
| `minimax_tail_sessions` | 快速采样最近 N 个会话末尾消息，适合多会话并发巡检 |
| `minimax_search` | 跨会话全文检索标题与消息内容，返回高亮聚焦上下文 |
| `minimax_pending` | 查询当前等待人工确认或答复的问卷与审批卡片 |
| `minimax_tasks` | 查询后台任务执行状态（running / succeeded / failed / canceled） |
| `minimax_draft_answer` | 为待答问卷生成草稿回答建议（只读无副作用） |
| `minimax_windows` | 获取 MiniMax 窗口在屏位置、尺寸及遮挡状态 |
| `minimax_events` | 读取巡检事件队列（finished / error / question / stalled） |
| `minimax_find_text` | 定位界面中的文本元素（优先 CDP DOM，自动回退 Vision OCR） |

### 2. 界面控制与输入（带安全守卫）

| 工具名 | 说明 |
|---|---|
| `minimax_send_message` | 往输入框注入文本并可选回车发送（带活跃防误触守卫） |
| `minimax_get_result` | 等待指定会话当前轮次结束并收回复 |
| `minimax_stop_generation` | 终止当前正在生成或运行中的会话任务 |
| `minimax_answer_question` | 提交问卷回答（默认 `preview: true` 仅预览，需显式确认才提交） |
| `minimax_new_task` | 新建任务页（优先 CDP 触发，次选快捷键） |
| `minimax_open_session` | 导航切换至指定会话 |
| `minimax_click_text` | 查找并点击指定文本控件（无视窗口缩放与位移） |
| `minimax_activate` | 将 MiniMax 窗口唤醒至系统前台并返回焦点窗口信息 |
| `minimax_screenshot` | 窗口截图（支持全屏 screen 或区域 region，返回文件路径） |
| `minimax_click` / `minimax_type` / `minimax_key` | 基础键鼠操作原语 |

### 3. 高级协同与自动化

| 工具名 | 说明 |
|---|---|
| `minimax_watch` | **主动巡检**：对比历史快照，按安全策略自动处理低风险事件 |
| `minimax_bot_message` | 与 MiniMax Bot 团队沟通（发送群聊消息、指定成员或读取对话） |
| `minimax_auto_resume` | **智能断点续传**：额度耗尽（2056）自动检测与恢复重试 |

---

## 🔒 三档安全分级与审计

所有工具均带有 MCP 标准 `annotations`，并划分为三档安全等级：
- **`read`（只读）**：完全无副作用，任意调用。
- **`ui`（轻量控制）**：仅改变界面焦点、截图或导航，完全可逆。
- **`commit`（不可逆动作）**：发送消息、提交问卷回答、终止生成。所有 `commit` 级工具均有**默认关闭的闸门**（如 `send: false`, `preview: true`），必须显式参数才会生效。

所有 `ui` 与 `commit` 动作均自动脱敏写入本地审计日志：`~/.minimax-mcp/audit.jsonl`。

---

## 🚀 快速开始

### 1. 环境依赖

- **操作系统**：macOS
- **运行环境**：Node.js >= 22、Python 3、SQLite 3（系统自带）
- **客户端**：已安装并登录的 [MiniMax Code](https://agent.minimax.cn/)

### 2. 安装与配置

克隆仓库并安装依赖：

```bash
git clone https://github.com/Luckycat133/minimax-mcp.git
cd minimax-mcp
npm test                  # 运行全套契约与逻辑测试（129+ 断言全绿）
npm run doctor            # 环境依赖与权限自检
```

### 3. 客户端 MCP 配置

#### 方式 A：通过 Smithery 一键自动安装（推荐）

```bash
# 为 Claude Desktop 安装
npx -y @smithery/cli install @Luckycat133/minimax-mcp --client claude

# 为 Cursor 安装
npx -y @smithery/cli install @Luckycat133/minimax-mcp --client cursor
```

#### 方式 B：手动 JSON 配置

在 Claude Desktop / Cursor / Antigravity 的 MCP 配置文件中添加：

```json
{
  "mcpServers": {
    "minimax-mcp": {
      "command": "node",
      "args": [
        "/Users/jack/Documents/projects/minimax-mcp/mcp-server.js"
      ],
      "env": {
        "MINIMAX_PYTHON": "python3",
        "MINIMAX_SQLITE_BIN": "sqlite3"
      }
    }
  }
}
```
> *注：将上述路径替换为你的实际项目路径；若通过 `npm link` 全局链接，也可直接使用 `minimax-mcp` 命令。*

### 4. 启用 CDP 极速控制（推荐）

通过开启 Remote Debugging 端口，可让 MiniMax MCP 获得极速 DOM 操作能力且无需任何 macOS 系统辅助权限：

```bash
node scripts/launch-with-debug.js
```

---

## 🤖 定时巡检后台服务

可将主动巡检配置为 macOS launchd 守护进程：

```bash
node scripts/install-watch-agent.js               # 安装守护进程（每 5 分钟自动巡检一轮）
node scripts/install-watch-agent.js --uninstall   # 卸载守护进程
```

巡检产物将持久化保存在 `~/.minimax-mcp/` 目录下：
- `report.md`：最新态势 Markdown 报告
- `events.jsonl`：待处理与已处理事件队列
- `watch-state.json`：增量对比状态与策略配置
- `audit.jsonl`：操作审计记录

---

## ❓ 常见问题 (FAQ / Generative Engine Q&A)

### Q1: minimax-mcp 与普通的 API 包装型 MCP 有何不同？
普通的 MCP 服务器通常只是调用云端 API。**minimax-mcp** 专为 MiniMax Code macOS 客户端打造，结合了**CDP（Chrome DevTools Protocol）**和**本地 SQLite 状态直读**。它不依赖云端 API 额度，而是直接调度本地客户端的会话、后台任务、审批确认与多 Bot 协作。

### Q2: 是否需要开启 macOS 辅助功能（Accessibility）或录屏权限？
**在 CDP 模式下完全不需要任何系统辅助或录屏权限**！通过 Chrome DevTools Protocol 即可直接在 DOM 层面完成输入、点击和事件捕获，且不受窗口最小化或遮挡的影响。只有在 CDP 端口未开启的纯降级模式下，才会使用 macOS Vision OCR + CoreGraphics。

### Q3: 如何在 Claude Desktop / Cursor 中让 AI 自动处理 MiniMax 的卡住任务？
只需将 minimax-mcp 注册到宿主环境中，对 AI 说：
> "检查 MiniMax Code 当前是否有等待决策或报错的任务，并帮我处理。"
宿主 Agent 会首先调用 `minimax_brief` 获取态势摘要，并根据自带的 `suggestedCall` 执行 `minimax_answer_question` 或重试，无需人工干预。

---

## 📄 开源许可证

本项目采用 [MIT 许可证](LICENSE)。
