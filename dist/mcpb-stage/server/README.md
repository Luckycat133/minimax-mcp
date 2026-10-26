# minimax-mcp

让 AI agent 读你本机 MiniMax Code 的全部对话，并操作它的界面。

MiniMax Code 是 Electron 应用：没有本地 HTTP API，跨进程无障碍树也读不到。
这个项目用两条通道解决——**读**走它自己的 SQLite，**写**走 macOS 原生事件注入。

```
Agent host ──stdio MCP──▶ minimax-mcp ──┬─ 只读 SQLite  ~/.minimax/v2/sqlite/runtime-state.sqlite
                                        └─ GUI 驱动     scripts/mac_gui.py (CoreGraphics)
```

## 它解决什么问题

- 你有好几个 MiniMax Code 会话在跑，想让 AI 替你盯着：谁在等回答、谁出了结果、谁卡住了。
- 你想让 AI 往某个会话里推一句话，而不是自己切来切去点。
- 你想让 AI 截图看当前界面，按文字/坐标点按钮。

## 工具面

契约版本 1，14 个工具，每个单一意图。

只读（不改任何东西）：

| 工具 | 作用 |
|---|---|
| `minimax_status` | 数据库位置、会话数、消息数、最后活动、运行中任务数 |
| `minimax_list_sessions` | 按最近活动列出会话 |
| `minimax_read_session` | 读某个会话的消息（可带思考过程） |
| `minimax_tail_sessions` | 最近 N 个会话各自最新的几条 |
| `minimax_search` | 跨会话全文搜索 |
| `minimax_pending` | Agent 发出、等你回答的提问 |
| `minimax_tasks` | 后台任务状态 |
| `minimax_windows` | MiniMax 窗口几何信息 |

控制（会真的动鼠标键盘）：

| 工具 | 作用 |
|---|---|
| `minimax_activate` | 切到前台并回报前台窗口 |
| `minimax_screenshot` | 全屏或区域截图 |
| `minimax_send_message` | 往输入框粘贴指令，可选回车，**发完自动核对数据库** |
| `minimax_click` / `minimax_type` / `minimax_key` | 基础键鼠原语 |

## 运行要求

- macOS（需要「辅助功能」和「屏幕录制」两项权限，给运行 MCP 的那个 App）
- Node.js 22+
- `python3`、`sqlite3`（系统自带）
- MiniMax Code 已安装并登录

零第三方依赖：SQLite 走系统 `sqlite3` CLI，GUI 走 `scripts/mac_gui.py`。

## 启动

```sh
node mcp-server.js        # stdio MCP 服务器
npm run doctor            # 自检：node/sqlite3/python3、数据库、权限
npm test                  # 冒烟测试：initialize → tools/list → 只读调用
```

客户端配置见 [`skills/minimax-mcp/assets/mcp-client-config.json`](skills/minimax-mcp/assets/mcp-client-config.json)。

## 安全边界

- 数据库**只读**打开。App 运行时有内存缓存，写库会造成状态不一致。
- 所有控制工具先校验 MiniMax 是不是真在前台，不是就直接报错放弃，不硬点。
- `minimax_send_message` 默认只粘贴不发送，必须显式 `send: true`。
- 发送后靠数据库确认，不靠「我按了回车」这种自述。

## 已知限制

- 不能可靠地按按钮文字点击：MiniMax 是 Electron，中文 OCR 不可用。要么坐标，要么截图后人来看。
- 切换会话要点左侧列表，坐标随布局变，动手前先截图。
- 窗口被完全遮挡时，后台截到的是旧帧。
