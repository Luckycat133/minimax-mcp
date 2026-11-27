# MiniMax Code MCP 工具面

工具契约版本 1，使用 stdio 传输 JSON-RPC。调用方从 `tools/list` 获取五个工具的 schema，再用 `tools/call` 发起调用。完整请求见 [JSON-RPC 示例](mcp-call-examples.json)，字段表见 [工具契约](mcp-tool-contracts.json)。

## 运行状态

`minimax_status({})` 返回 `app`、`cdp`、数据库状态和 `attention` 摘要。传 `includeBrief:false` 可跳过摘要。CDP 能读到额度时，`quota` 会提供限制状态及可用的重置时间（`resetAtMs`）和剩余秒数（`waitSeconds`）。检测到额度受限时，返回体还会附带 `wakeup`（`shouldSchedule`、`wakeAfterSeconds`、`wakeAt`、`instruction`），调用方应据此给自己设一次性定时唤醒（不要让用户手动提醒）；醒来确认 `quota.isLimited === false` 后，Bot 对话通过 `minimax_bot` 的 `action:"resume"` 续传暂挂消息，原生会话通过 `minimax_agent` 向原 `sessionId` 续发指令继续任务。

## 会话检索

| 动作 | 参数与行为 |
| --- | --- |
| `list` | 按近期活动列出会话。默认 20 个。设置 `perSession` 后附带每个会话的消息采样，默认 3 个会话，最多 20 个。 |
| `read` | 用 `sessionId` 读取历史，默认 30 条。用返回的 `oldestId` 作为下一页的 `before`，用 `includeThinking:true` 包含本地记录中的思考字段。 |
| `search` | 用 `query` 搜索会话标题和消息，默认 20 条。 |

省略 `action` 时，有 `sessionId` 则读历史，有 `query` 则搜索，其余为列表。优先使用返回的完整 `sessionId` 定位同一会话。

`read` 与带 `perSession` 的采样默认每条文本字段最多 4000 个 Unicode 字符，可用 `maxChars` 调整，`0` 显式取全文。仅截断时增加 `<字段>Chars`（原长度）和 `<字段>Truncated:true`；短文本保持原结构。`hasMore`/`oldestId` 仍表示消息分页，不表示文本是否完整。

取回某条消息全文：传同一 `sessionId`、`limit:1`、`before:该消息id+1`、`maxChars:0`，并核对返回的 ID；若该消息已被删除，不要把前一条当成目标。需要思考字段时还要传 `includeThinking:true`。此预算不改变 `minimax_agent` 的最终结果或内部数据库调用。

## 原生 Agent

| 动作 | 参数与行为 |
| --- | --- |
| `activate` | 将 MiniMax Code 切到前台，核对窗口焦点。 |
| `send` | 提供 `message`。向已有会话写入时传 `sessionId`，给新任务发送首条消息时传 `newSession:true`。两个目标参数互斥。 |
| `result` | 用 `sessionId` 查询指定会话，用发送返回的 `messageId` 作为 `afterMessageId`。默认即时返回，可设置 `timeoutSeconds` 等待。 |
| `stop` | 传 `sessionId` 停止该会话的当前轮次。传发送回执的 `messageId` 作为 `afterMessageId` 可锁定该轮。运行库确认该 `turnId` 为 `aborted` 后返回 `stopped:true`。 |
| `new` | 打开一个新任务视图。 |

省略 `action` 时，有 `message` 则进入发送流程，其余查询结果。发送流程中，`preview:true` 仅检查计划和活跃守卫。`send:false` 是默认值，填写草稿。`send:true` 触发实际发送。遇到活跃守卫时，`force:true` 可显式跳过。

原生会话控制需要 MiniMax Code 位于前台且 CDP 已连接。发送返回 `sent:true` 和 `verified:true` 时，SQLite 已记录这条用户消息，可用返回的 `sessionId` 与 `messageId` 跟踪本轮。返回 `sent:null` 表示提交后未确认入库。先用 `minimax_session` 检查会话记录。已停止的轮次在 `result` 里返回 `status:"aborted"`。

## Bot Studio

`minimax_bot({})` 列出群聊和 Bot。带 `target` 默认读取对话，带 `text` 默认发送。写入需显式指定 `target`，可传群名、Bot 名或名册里的 `chatId` 值。向成员发送默认是私聊。用 `mode:"group"` 在群聊中 @ 该成员。

`action:"open"` 显式连接 Bot Studio。需要打开新标签页时，MiniMax 须在前台，`sessionId` 默认为当前原生会话。以 `source:"live"` 确认连接。历史读取连接失败时查本地归档，返回 `source:"disk"` 和原因。

发送返回 Bot Studio 入库的 `messageId`。需要去重时用相同的 `clientMessageId`、正文和目标。回执未确认时，先从历史核对该 ID。`action:"cancel"` 返回收到停止请求的轮次数 `cancelled`，可从历史核对终态。`action:"resume"` 继续指定对话中尚未派发的暂挂消息。

宿主在收取用户消息前确认取消时，Bot 记录在 MCP 历史中显示 `status:"aborted"`，`cancellation.phase` 为 `before-admission`。`cancellation.pluginStatus` 保留官方插件返回的原状态，`cancellation.code` 为 `REQUEST_CANCELLED`。如果官方插件将对应的用户消息标为 `dispatchState:"uncertain"`，MCP 历史会保留该派发状态。

`action:"answer"` 使用 `target`、卡片的 `messageId` 和逐题 `answers`。每项传 `stepId`、`selectedOptionIds`，按需传 `selectedOther`、`otherText` 或 `skipped`。收到 `accepted:true` 后，通过历史检查卡片的 `answered` 和 `answerSummary`。

## 原生问卷

空参数列出待答问卷。提供 `requestId` 默认进入 `answer`，以 `preview:true` 返回题目和 `suggestion`。可在 `selections` 中提供候选选项，每项包含 `stepId` 和 `optionIds`。若填写其他选项，传 `selectedOther:true` 和 `otherText`。提交前在 MiniMax 打开目标卡片，再传 `preview:false`、`force:true`，核对返回中的 `verified` 和 `status`。

## 兼容调用

新调用使用工具列表中的字段，服务端仍接受已兼容的旧工具名和参数别名。同一参数用两个名称传入时，值必须一致。旧 `minimax_session` 的 `action:"tail"` 和 `count` 对应 `action:"list"` 和 `limit`，传 `perSession` 指定每个会话的采样数。旧 `minimax_questionnaire` 的 `action:"draft"` 对应带 `requestId` 的默认预览。

客户端通过 `minimax_agent` 的 `result` 获取本轮回复。使用旧 Tasks 草案的自定义客户端可在握手时设置 `capabilities.experimental["io.modelcontextprotocol/tasks"] = {}`，收到同名能力后调用原有的 `tasks/*` 方法。

## 提交与审计

原生实际发送、提交问卷、Bot 写操作和已兼容的提交类工具在驱动前写入准入记录。日志无法写入时，`tools/call` 返回 `isError:true`，正文包括 `code:"AUDIT_UNAVAILABLE"` 和 `executed:false`。读取、发送预览和原生 `action:"stop"` 可继续使用。

准入记录与结果记录用服务端生成的 `operationId` 关联，准入行的 `ok` 为 `null`。日志只保留允许的元数据。驱动已返回而结果记录无法写入时，MCP 保留该回执并附加 `audit:{"state":"outcome-unavailable","operationId":"…"}`。用回执中的 `verified`、`sent` 或 `accepted` 字段和会话历史核对原操作。
