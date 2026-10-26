# MiniMax Code MCP 工具面

契约版本 1 · 14 个工具 · stdio 传输 · MCP `2024-11-05`

## 为什么是这两条通道

MiniMax Code 是 Electron 应用：

- 没有本地 HTTP API，`~/.minimax/run/` 下只有一个 auth lease socket，不是业务接口。
- 跨进程 Accessibility 树读不到（Electron 默认不开），所以拿不到按钮名和输入框语义。
- AppleScript 在这台机器的沙箱里被完全拦掉，报 `-10004`。

因此：

| 方向 | 通道 | 可靠性 |
|---|---|---|
| 读全部对话/任务/提问 | `~/.minimax/v2/sqlite/runtime-state.sqlite`（只读） | 高，结构化 |
| 截图 | CoreGraphics `screencapture` | 高 |
| 键鼠注入 | CoreGraphics 事件（`scripts/mac_gui.py`） | 高 |
| 按按钮文字点击 | OCR | 中文不可用，英文/数字凑合 |

## 判断"会话卡住"的标准

1. 末条消息 `role === "user"`，且时间戳已经过去很久 → 那条指令没被处理。
2. `minimax_pending` 有内容 → 有问卷在等回答。
3. 两条同时成立通常是会话状态坏了，重试无效，正确做法是开新会话把任务搬过去。

## 输入框坐标

`minimax_send_message` 不传 `at` 时按窗口自动推算：

- `layout: "chat"`：窗口水平中心，窗口底部往上 68 点。
- `layout: "newtask"`：新建任务页，窗口宽的 41.6%、高的 41.8%。

窗口位置每次都可能变（换显示器、拖动都会变），推算不准时用 `minimax_windows`
拿几何，再显式传 `at: "x,y"`。

## 发送验证

`send: true` 之后，服务器会记下当前最大消息 id，回车，然后最多轮询 8 秒数据库，
看是否出现以这条消息开头的新 `role='user'` 记录：

- `verified: true` → 真的发出去了，带 `sessionId` 和 `messageId`。
- `verified: false` → 大概率没发出去。此时输入框可能还留着文字，截图确认后重试。

不要用"我按了回车"当作发送成功的依据。
