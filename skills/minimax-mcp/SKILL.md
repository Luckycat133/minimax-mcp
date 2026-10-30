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
minimax_status                                     # 总量：会话数/消息数/最后活动/运行中任务
minimax_tail_sessions {count: 6, perSession: 2}   # 一眼看完全部会话最新进展
minimax_pending                                    # 谁在等你回答
minimax_tasks {status: "running"}                  # 还有什么在跑
minimax_list_sessions                              # 需要精确定位时再列全部
minimax_read_session {session: "3", limit: 20}     # 读某个会话（可传序号或 mvs_ ID）
minimax_search {query: "关键词"}                    # 跨会话全文搜索
```

判断"卡住"的可靠标准：末条消息 role 是 `user` 且时间早已过去 → 那条指令没被处理。
`minimax_pending` 有内容 → 有问卷在等回答。

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

## 新建 / 切换会话

```
minimax_new_task {}                              # 按 ⌘N 新建任务页，并对比前后窗口确认开出来了
minimax_open_session {session: "3"}               # 按会话标题在侧栏找并点击（推荐）
minimax_click_text {text: "处理 GitHub 通知"}     # 已经知道侧栏文字时直接点
minimax_open_session {session: "3", at: "600,500"} # 标题被截断/滚出视野时才手给坐标
```

`minimax_open_session` 默认拿会话标题去侧栏 OCR 定位，**只认最左那一列**——
同名标题在顶栏也会出现，不这么筛就会点到顶栏（这个坑实测踩过）。
找不到就不点，返回 `tried` 和提示。
`minimax_new_task` 开出来的可能是独立窗口，之后发消息要用 `layout:"newtask"` 或显式 `at`。

## 回答提问

```
minimax_draft_answer {requestId: "ask_xxx"}      # 只读：问题全文 + 全部选项 + 一份建议答案
minimax_answer_question {requestId: "ask_xxx"}   # 默认只 preview，不提交
minimax_answer_question {requestId: "ask_xxx", selections: [...], preview: false, force: true}
```

`minimax_draft_answer` 会按每步的 `recommended` 标记给一份建议答案和对应的 reply payload，
同时把问题和选项原文都给你——**最终判断是你的**。建议答案只是起点，实际答案经常和
recommended 不一样（我拿历史问卷验过，有一步用户选的就不是 recommended 那个）。

`minimax_answer_question` 默认 `preview:true`，返回 `wouldSubmit`（真实 reply payload）
和 `clickPlan`（要按哪些文字去点），不动手。

真提交要 `preview:false + force:true`。它会：按 clickPlan 用 OCR 找每个选项的文字并点击
（找不到就缩短锚点重试，跨行渲染也不会瞎点）→ 找提交按钮（提交/确定/确认/发送/完成/Submit/Send）
→ 点它 → **回数据库核对这条提问的状态是否真的从 pending 变成 answered**。
`verified:false` 就是没提交成功，别信"我点了"。

`selections` 里 `optionIds` 和 `selectedOptionIds` 两种写法都收，单选给多个会被砍成一个并报错，
未知 stepId / optionId 会点名可选值——不会静默忽略。

## 收结果

发出去之后用它收，不用自己轮询：

```
minimax_send_message {message: "…", send: true, force: true}   # 先发，记下 messageId
minimax_get_result {afterMessageId: 13278, timeoutSeconds: 300} # 等这轮跑完，拿最终回复
```

判定"跑完"的依据是**会话状态回到 idle 且最后一条助手消息有正文**，不是数消息条数——
流式输出过程中会不断追加空 content 的工具调用消息，数条数会误判。超时也会返回，
但 `done:false` 时 `result` 可能是半成品。

要中断当前这轮：`minimax_stop_generation`（按 Esc，只发按键，不点按钮）。

## 点按钮

MiniMax 没有可用的控件树，但**有 OCR**。所以点按钮的正规做法是按文字点，不要手算坐标：

```
minimax_find_text {text: "提交"}                  # 只读，先看命中几个、分别在哪
minimax_click_text {text: "提交", mode: "exact"}  # 找到就点它的中心
```

`minimax_find_text` 走 macOS Vision，中英文都能认，返回屏幕点坐标（不是像素）。
匹配会忽略空白和全角半角差异，`contains` 模式下完全相等的排第一。
点之前会做遮挡检查，被别的 App 盖住就拒绝。

只有 OCR 认不出来（纯图标按钮、文字被截断）时才退回截图 + 手算坐标：

```
minimax_screenshot {mode: "region", x: 296, y: 690, width: 800, height: 200}
minimax_click {x: 678, y: 597}
```

一次只点一下，点完截图核对。不要连发一串点击。

`minimax_key` 是通用按键（`{"key":"n","modifiers":["cmd"]}` = ⌘N），
`minimax_stop_generation` 是按 Esc 停当前这轮生成。

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
