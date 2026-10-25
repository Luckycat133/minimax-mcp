---
name: minimax-mcp
description: 读取并操作本机 MiniMax Code：列出/读取/搜索全部会话，查看待回答提问与后台任务，往当前会话粘贴并发送指令，截图与键鼠控制。用于"帮我看看 MiniMax 各会话进展""给某个会话推一句话""点一下那个按钮"这类诉求。
license: MIT
metadata:
  author: minimax-mcp
  version: "0.1.0"
  openclaw:
    requires:
      bins:
        - node
        - python3
        - sqlite3
---

# MiniMax Code MCP

14 个工具，两个通道：**读**走 MiniMax 自己的 SQLite，**写**走 macOS 原生事件注入。
MiniMax Code 是 Electron 应用，没有本地 HTTP API，跨进程 AX 树也读不到，所以不要去找
`computer_*` 工具、不要上 AppleScript（沙箱会把 Apple Events 全拦掉，报 -10004）。

## 先看，再动

巡检类诉求（谁在等回答、谁有结果、谁卡住）全程只读，随便用：

```
minimax_tail_sessions {count: 6, perSession: 2}   # 一眼看完全部会话最新进展
minimax_pending                                    # 谁在等你回答
minimax_tasks {status: "running"}                  # 还有什么在跑
minimax_list_sessions                              # 需要精确定位时再列全部
minimax_read_session {session: "3", limit: 20}     # 读某个会话（可传序号或 mvs_ ID）
```

判断"卡住"的可靠标准：末条消息 role 是 `user` 且时间早已过去 → 那条指令没被处理。
`minimax_pending` 有内容 → 有问卷在等回答。

## 下达指令

```
minimax_send_message {message: "…", send: false}   # 只粘贴，不发送
minimax_send_message {message: "…", send: true}    # 粘贴并回车
```

**默认带活跃守卫**：如果最近活跃的会话不久前还有活动（默认 300 秒内），直接拒绝发送，
返回里会告诉你那个会话多久前还在动。这是为了防止把自动化消息插进你正在进行的工作。
确认要发就加 `force: true`，或者用 `quietSeconds` 改阈值（`0` 表示不检查）。

动手前先预览——只读，不点不粘不发，会告诉你坐标、遮挡情况、以及**哪些会话正在忙**：

```
minimax_send_message {message: "…", send: true, preview: true}
```

CLI 有等价的 `--dry-run`，会强制 `send=false` + `preview=true`：

```bash
node scripts/call.js minimax_send_message '{"message":"…","send":true}' --dry-run
```

`minimax_type` 同样受守卫保护——它会往你正在编辑的输入框里塞字，确认要输得加 `force: true`。

三条硬规则：

1. **默认 `send: false`**。要真发必须显式 `send: true`，避免误发。
2. **发之前先确认 UI 上打开的是哪个会话**。`send_message` 是往当前会话里打字，
   停在别的会话就发错地方了。先用 `minimax_screenshot` 或 `minimax_read_session` 核对。
3. **以返回值为准，不要以"我回车了"为准**。`verified: true` 表示数据库里真的出现了这条消息；
   `verified: false` 表示大概率没发出去，这时截图看输入框是不是还留着文字，换 `at` 坐标重试。

输入框坐标：`at` 不传时按**焦点窗口**自动推算——`layout: "chat"` 是会话页底部输入框，
`layout: "newtask"` 是新建任务页中部那个大输入框。窗口位置每次都可能变，
推算不准就 `minimax_windows` 看几何，再显式给 `at`。

## 点按钮

MiniMax 没有可用的控件树，中文 OCR 也不可靠。所以点按钮的流程是：
截图 → 人（或你）看坐标 → `minimax_click`。

```
minimax_screenshot {mode: "region", x: 296, y: 690, width: 800, height: 200}
minimax_click {x: 678, y: 597}
```

一次只点一下，点完截图核对。不要连发一串点击。

## 硬规则

1. **不要替用户点系统级确认**：安装器的「同意」、触控 ID、权限弹窗、GitHub 授权页的
   Authorize。这些是用户本人的决定。
2. **不要在用户正在用 MiniMax 时强行操作**。控制工具自带前台校验，不在前台会直接报错，
   这时不要反复重试，等空窗再做。
3. **截图被完全遮挡的后台窗口会拿到旧帧**。要确认它的真实状态，先 `minimax_activate`。
4. **数据库只读**。不要写 `~/.minimax` 下任何文件来"修"状态。
5. 需要切会话就点左侧列表，坐标随布局变——动手前先截图。

## 排障

```
npm run doctor     # node/sqlite3/python3、数据库、辅助功能权限、App 是否安装
npm test           # initialize → tools/list → 只读调用
```

`辅助功能权限` 不过 → 系统设置 → 隐私与安全性 → 辅助功能，给运行 MCP 的那个 App 打勾。
`屏幕录制` 不过 → 同一页面的「屏幕录制」。给运行 MCP 的 App 打勾，勾完要重启该 App。
