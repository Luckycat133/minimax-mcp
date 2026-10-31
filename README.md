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

契约版本 1，25 个工具，每个单一意图。

只读（不改任何东西）：

| 工具 | 作用 |
|---|---|
| `minimax_brief` | **态势快照**：只输出需要处理的事，按优先级排序，每条带原因和下一步 |
| `minimax_events` | 读巡检事件队列（我不在的时候发生了什么） |
| `minimax_events` | 读巡检事件队列（我不在的时候发生了什么） |
| `minimax_status` | 数据库位置、会话数、消息数、最后活动、运行中任务数 |
| `minimax_list_sessions` | 按最近活动列出会话 |
| `minimax_read_session` | 读某个会话的消息（可带思考过程） |
| `minimax_tail_sessions` | 最近 N 个会话各自最新的几条 |
| `minimax_search` | 跨会话全文搜索 |
| `minimax_pending` | Agent 发出、等你回答的提问 |
| `minimax_draft_answer` | 读一条提问 + 生成建议答案（只读） |
| `minimax_tasks` | 后台任务状态 |
| `minimax_windows` | MiniMax 窗口几何信息 |
| `minimax_find_text` | 按文字定位屏幕元素，返回屏幕点坐标（Vision OCR） |

控制（会真的动鼠标键盘）：

| 工具 | 作用 |
|---|---|
| `minimax_activate` | 切到前台并回报前台窗口 |
| `minimax_screenshot` | 全屏或区域截图 |
| `minimax_send_message` | 往输入框粘贴指令，可选回车，**发完自动核对数据库** |
| `minimax_get_result` | 等这轮跑完并收回最终回复 |
| `minimax_stop_generation` | 按 Esc 停当前这轮生成 |
| `minimax_answer_question` | 提交问卷答案（默认只 preview，提交后核对数据库状态） |
| `minimax_new_task` / `minimax_open_session` | 新建任务页 / 按标题切换会话 |
| `minimax_click_text` | 找到某段文字并点它（比手算坐标可靠） |
| `minimax_watch` | **主动巡检**：比对快照产出事件，按风险策略自动处理低风险的事 |
| `minimax_watch` | **主动巡检**：比对快照产出事件，按风险策略自动处理低风险的事 |
| `minimax_click` / `minimax_type` / `minimax_key` | 基础键鼠原语 |

## 主动巡检（这是和"工具箱"最大的区别）

`minimax_brief` 是"你问我答"，`minimax_watch` 是"我自己看"：它记住上次快照，
只报变化，并且能把**低风险**的事直接处理掉。

```
minimax_watch                 # 跑一轮
minimax_watch {dryRun: true}  # 只算不做
minimax_events                # 拉事件
```

自动动作有四道闸：**风险等级 ≤ low**、**有推荐答案**、**人离开 ≥180 秒**、**每轮 ≤2 个动作**。
涉及钱 / 发布 / 删除 / 凭证 / 对外承诺的，一律只进 `needsHuman`，永不自动。

风险判据在 `src/gateway/policy.js`，纯函数，28 条单测盯着。有个关键取舍：
**「没有推荐答案」会把等级从 low 抬到 medium**——出题方没给默认项，
说明它认为需要人判断，那就不该替人挑。

装成定时任务：

```bash
node scripts/install-watch-agent.js     # 每 5 分钟一轮（launchd）
node scripts/watch-tick.js              # 手动跑一轮
```

产物：`~/.minimax-mcp/{events.jsonl, report.md, watch-state.json, watch.log}`。

## 主动巡检（这是和"工具箱"最大的区别）

`minimax_brief` 是"你问我答"，`minimax_watch` 是"我自己看"：它记住上次快照，
只报变化，并且能把**低风险**的事直接处理掉。

```
minimax_watch                 # 跑一轮
minimax_watch {dryRun: true}  # 只算不做
minimax_events                # 拉事件
```

自动动作有四道闸：**风险等级 ≤ low**、**有推荐答案**、**人离开 ≥180 秒**、**每轮 ≤2 个动作**。
涉及钱 / 发布 / 删除 / 凭证 / 对外承诺的，一律只进 `needsHuman`，永不自动。

风险判据在 `src/gateway/policy.js`，纯函数，28 条单测盯着。有个关键取舍：
**「没有推荐答案」会把等级从 low 抬到 medium**——出题方没给默认项，
说明它认为需要人判断，那就不该替人挑。

装成定时任务：

```bash
node scripts/install-watch-agent.js     # 每 5 分钟一轮（launchd）
node scripts/watch-tick.js              # 手动跑一轮
```

产物：`~/.minimax-mcp/{events.jsonl, report.md, watch-state.json, watch.log}`。

## 三档风险分级

工具带 MCP 标准 `annotations`，内部按三档设计：`read`（只读）→ `ui`（只动界面，可逆）→
`commit`（改变对话内容，不可逆）。`commit` 档必须至少有一道默认关闭的闸门，契约测试盯着。

所有 `ui` / `commit` 动作写审计到 `~/.minimax-mcp/audit.jsonl`，参数自动脱敏。

## 为什么需要 OCR

MiniMax 是 Electron：读不到控件树，AppleScript 被沙箱拦。想按"按钮文字"点东西，
只能靠屏幕文字识别。`scripts/ocr.swift` 用 macOS Vision（中英文都认），编译成
`.cache/ocr`，首次使用时自动构建。这也是 `minimax_answer_question` 能自动点选项的基础。

## 运行要求

- macOS（需要「辅助功能」和「屏幕录制」两项权限，给运行 MCP 的那个 App）
- Node.js 22+
- `python3`、`sqlite3`（系统自带）
- Swift 工具链（`xcode-select --install`）——只用于编译 OCR 助手，编译一次即可
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
