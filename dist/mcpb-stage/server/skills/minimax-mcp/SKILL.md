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

**第一件事永远先调 `minimax_brief`**，不要一上来 `minimax_list_sessions` 把 137 个会话倒出来。

```
minimax_brief                                  # 只看"需要你处理的事"，按优先级排好
minimax_brief {stalledMinutes: 30}             # 放宽卡住判定，少一点噪音
```

它返回一句话总结 + 一个队列，每条带 `why`（为什么值得看）和 `next`（下一步调什么）。
队列顺序就是优先级：**等你决定 → 报错 → 卡住 → 在跑 → 刚完成**，安静的旧会话不输出。
`taskFailures` 单独列后台任务失败——这类失败不改变会话状态，光看会话列表会漏掉。

只有 brief 里没提到、但你确实要查的会话，才去 `list_sessions` / `read_session`。

## 先看，再动

巡检类诉求（谁在等回答、谁有结果、谁卡住）全程只读，随便用：

```
minimax_status                                     # 总量：会话数/消息数/最后活动/运行中任务
minimax_tail_sessions {count: 6, perSession: 2}   # 一眼看完全部会话最新进展
minimax_pending                                    # 谁在等你回答
minimax_tasks {status: "running"}                  # 还有什么在跑
minimax_list_sessions                              # 需要精确定位时再列全部
minimax_read_session {session: "3", limit: 20}     # 读某个会话（可传序号或 mvs_ ID）
minimax_read_session {session: "3", limit: 20, before: 17884}  # 往前翻页
minimax_read_session {session: "3", limit: 20, before: 17884}  # 往前翻页
minimax_search {query: "关键词"}                    # 同时搜会话标题和消息正文
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
`minimax_new_task` 有两种结果：`via:"new-window"`（真开了新窗口）或
`via:"view-switch"`（同一窗口换了视图，靠主区域文字量塌缩判断）。
两种都算成功。开完发消息要用 `layout:"newtask"` 或显式 `at`。
`via:"unknown"` 才是没成功——通常是焦点不在 MiniMax 的输入区。

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

真提交要 `preview:false + force:true`。它会：

1. 按 clickPlan 用 OCR 找每个选项的文字并点击（找不到就缩短锚点重试，跨行渲染也不会瞎点）；
2. **立刻回数据库看状态**——有的问卷是"选中即提交"，点完就算答了，这时候不该再找按钮；
3. 状态还没变才去找提交按钮（提交/确定/确认/发送/完成/Submit/Send），点了再核对一次。

`verified:true` 表示数据库里这条提问已经离开 pending。`verified:false` 就是没提交成功，
别信"我点了"。这条链路 2026-10-31 已在真机上跑通：点选项 → 状态变 answered →
MiniMax 收到并回复"你的回答是…"。这条链路 2026-10-31 已在真机上跑通：点选项 → 状态变 answered →
MiniMax 收到并回复"你的回答是…"。两种失败都只回报、不盲试：`missed[]` 是有选项没点到，`warning` 是点了但状态没变。

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

## 风险分级：三档，不是两档

每个工具都带 MCP 标准的 `annotations`，但内部分了三档——因为"点一下界面"和
"替你回一句话"完全不是一回事：

| 档位 | readOnlyHint | destructiveHint | 哪些工具 |
|---|---|---|---|
| `read` | true | false | brief / status / list / read / tail / search / pending / draft_answer / tasks / windows / find_text / get_result |
| `ui` | false | false | activate / screenshot / new_task / open_session / click / click_text / type / key / stop_generation |
| `commit` | false | true | send_message / answer_question |

**`stop_generation` 故意归 ui 而不是 commit**：它只按 Esc 截断当前这轮，不改对话历史，
用户随时能重发。标成 destructive 会让宿主每次弹确认——而"停下来"恰恰是出问题时最该
顺手能做的动作，给刹车加锁没意义。防误触靠的是"MiniMax 必须在前台"那道校验。

`commit` 档的工具必须至少有一道默认关闭的闸门（`send:false` / `force:false` / `preview:true`），
这条有契约测试盯着，改不掉。

## 审计

所有 `ui` / `commit` 动作都会往 `~/.minimax-mcp/audit.jsonl` 写一行：

```
{"at":"...","tool":"minimax_click_text","level":"ui","args":{...},"ok":true,"ms":981,"target":{"at":[602,499]}}
```

`args` 会脱敏：长文本截到 80 字并标注原长度，对象只留 `{…}`，数组只留项数。
超过 2MB 自动滚成 `audit.jsonl.1`。

为什么需要：GUI 操作没有 undo。事后想弄清"刚才点了哪里、当时是什么状态"，只能靠记录。
排障时直接 `tail ~/.minimax-mcp/audit.jsonl`。

## 主动巡检

`minimax_brief` 是"你问我答"，`minimax_watch` 是"我自己看"。差别在于它会**记住上次的样子**，
只报变化，并且能按策略把低风险的事直接处理掉。

```
minimax_watch                                  # 跑一轮：产出新事件 + 按策略自动处理
minimax_watch {dryRun: true}                   # 只算不做，先看它会干什么
minimax_watch {action: "status"}               # 只看巡检器状态，不跑
minimax_watch {action: "reset"}                # 清基线，下次重新建立（不产生事件）
minimax_events {since: "2026-10-31T00:00:00"}  # 拉取这段时间的事件
```

事件类型：`finished` / `error` / `recovered` / `question` / `stalled` / `task_failed` / `auto_action`。
首次调用只建基线，不产生事件——这是故意的，否则第一次跑就刷一屏"历史变化"。

### 自动动作的门槛

默认策略是**能自动，但只动最安全的那一档**：

| 参数 | 默认 | 含义 |
|---|---|---|
| `mode` | `act` | off / observe / act |
| `riskCeiling` | `low` | 只自动处理低风险 |
| `minIdleSeconds` | `180` | 人离开够久才动手，不抢焦点 |
| `maxActionsPerTick` | `2` | 每轮最多两个动作 |
| `autoNudge` | 开，冷却 360 分钟 | 卡住的会话自动催一次 |

风险怎么判（`src/gateway/policy.js`）：

- **high**：涉及钱、发布上线、删除、凭证权限、对外承诺 → 永不自动，只进 `needsHuman`
- **medium**：结构性改动、代码流转、引入外部依赖、**没有推荐答案**、多步问卷 → 要人看
- **low**：征询确认类（要不要继续/重试/哪个）+ 有推荐答案 → 才可能自动

**「没有推荐答案」会把等级抬到 medium**，这条是刻意的：出题方没给默认项，
说明它认为需要人判断，那就不该替人挑。

### 人不在才动手

自动动作只在你离开 ≥ `minIdleSeconds` 时执行。人在机器前时不会抢焦点代答，
但这件事仍然会进 `needsHuman`——**不执行不等于吞掉**。

### 策略持久化

定时任务没法带参数，所以策略要能落盘：

```
minimax_watch {action: "config"}                                   # 读当前生效策略
minimax_watch {action: "config", policy: {minIdleSeconds: 600}}    # 只改这一项，别的保留
```

写在 `~/.minimax-mcp/policy.json`，生效顺序是 **默认 ← 文件 ← 本次调用参数**。
`autoNudge` 是子对象，只传 `{cooldownMinutes: 120}` 不会冲掉里面的 `message`。

### 策略持久化

定时任务没法带参数，所以策略要能落盘：

```
minimax_watch {action: "config"}                                   # 读当前生效策略
minimax_watch {action: "config", policy: {minIdleSeconds: 600}}    # 只改这一项，别的保留
```

写在 `~/.minimax-mcp/policy.json`，生效顺序是 **默认 ← 文件 ← 本次调用参数**。
`autoNudge` 是子对象，只传 `{cooldownMinutes: 120}` 不会冲掉里面的 `message`。

### 装成定时任务

```bash
node scripts/install-watch-agent.js              # 每 5 分钟一轮
node scripts/install-watch-agent.js --dry-run    # 只看 plist
node scripts/install-watch-agent.js --uninstall
```

装完产物：`~/.minimax-mcp/{watch.log, events.jsonl, report.md, watch-state.json}`。
`report.md` 是给人看的中文报告，`events.jsonl` 是给程序读的。

> 注意：在沙箱环境里 `launchctl bootstrap` 会返回 `Input/output error`（用户域不可写）。
> 这时脚本会明确报错并**保持旧任务原样**，不会出现"新的没装上、旧的被停掉"。
> 请在「终端」App 里跑这条命令。

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
