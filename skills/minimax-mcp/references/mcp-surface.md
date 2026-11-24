# MCP 工具面、上下文预算与额度边界

审查日期：2026-11-14；源码基线：`ed3283266b32d395ed17282cc8b848a2d9ed9088`。

当前是 **27 个工具**、stdio、服务版本 0.1.0、工具契约版本 1。`contract.js` 声明的协议修订号为 `2024-11-05`、`2025-03-26`、`2025-06-18`。这是源码声明，不是所有修订号都已经通过外部合规验证。`tasks/*` 是额外协议方法，不计入工具数量；当前实现不能仅凭方法同名就宣称兼容标准 task-augmented execution。

## 数据通道与信任边界

- SQLite：读取会话、消息、后台任务和问卷。当前 SQL 主要为查询，但 CLI 未传 `-readonly`；需要把“只读约定”变成连接限制。
- CDP：优先用于多种桌面控制和 DOM 观察。应固定真实目标，不能只凭 URL 包含 `archon` 或复用旧 WebSocket 判断会话身份。不应对外开放调试端口。
- GUI/OCR：CoreGraphics 输入，Vision 支持中英文。前台与覆盖检查是必要条件，不是会话身份的充分证明。
- Bot：本地 HTTP 客户端具有消息、轮次与问卷方法；当前 MCP 暴露的是 bot_message 和 auto_resume，不是客户端每个方法。
- 远程代理：当前没有入站认证的所有网卡代理不属于可安全公开的接口。必须先封闭网络边界再讨论远程协同。

## 实际工具目录与默认值

这里列出主参数；完整参数类型以 `tools/list` 为准。下表数值是**当前运行 schema**，不是建议使用最大值。

| 工具 | 主要参数/默认值 | 实际边界或注意事项 |
|---|---|---|
| minimax_brief | limit=200，最大500；stalledMinutes=10；activeMinutes=10；finishedMinutes=60 | limit 是扫描数量，不是总返回 token 上限 |
| minimax_status | 无参数 | 可附 CDP quota；读不到不代表额度可用 |
| minimax_list_sessions | limit=20，最大100 | 序号随活跃度改变，写操作只能依赖完整 ID |
| minimax_read_session | session 必填；sessionId 别名；limit=30，最大200；includeThinking=false；before 可选 | 正文无统一字节上限；支持向前翻页 |
| minimax_tail_sessions | count=3，最大20；perSession=2，最大20 | 条数上限不等于正文大小上限 |
| minimax_search | query 必填；q 别名；limit=10，最大100 | 不传 handler 内部存在但 schema 未暴露的 includeTitles |
| minimax_pending | 无参数 | 数据层最多50条；完整题目需 draft_answer |
| minimax_tasks | limit=20，最大100；status 可选 | MiniMax 后台任务，不是 MCP tasks/* |
| minimax_windows | 无参数 | 窗口几何不能证明选中了目标会话 |
| minimax_activate | 无参数 | 改变焦点，必要时尝试拉起应用 |
| minimax_screenshot | mode=screen 或 region；name=minimax | 会落截图文件；不同驱动实现有差异 |
| minimax_send_message | message 必填；send=false；preview=false；force=false；quietSeconds=300；layout=chat；at 可选 | 不接受 sessionId；send=false 仍改输入框；preview 才不输入 |
| minimax_click | x、y 必填；button=left | CDP 吃 viewport CSS 坐标，GUI 吃屏幕点；当前入口未统一坐标空间 |
| minimax_type | text 必填；force=false | 修改编辑器；CDP 返回的 currentText 也可能包含隐私 |
| minimax_key | key 必填；modifiers=[] | Return 等按键可以提交，不能统一视作可逆动作 |
| minimax_get_result | sessionId/session 可选；sinceMessageId 可选；timeoutSeconds=0，最大300 | handler 读取 afterMessageId，锚点失配；省略 session 会退到最近活跃 |
| minimax_draft_answer | requestId 必填；id 别名 | 推荐优先，无推荐时目前取第一项；并非基于用户偏好的智能拟答 |
| minimax_answer_question | requestId 必填；selections 可选；preview=true；force=false；at 可选 | selections 使用 stepId+optionIds；region 不在 schema；at 当前未实际用于点选 |
| minimax_new_task | 无参数 | CDP 找不到新建按钮时可能仅聚焦已有编辑器仍报告成功 |
| minimax_open_session | sessionId 必填；session 别名 | at 不在 schema；标题模糊点击后未校验真实会话 ID |
| minimax_stop_generation | sessionId/session 可选；force=false | 当前执行忽略目标 ID，仅停当前视图 |
| minimax_watch | action=tick；dryRun=false；policy 可选 | 默认 act；off/observe 未覆盖末尾 autoResume 分支；诊断显式 dryRun:true |
| minimax_events | since 为 string；limit=50，最大500 | 读巡检事件，不是实时订阅 |
| minimax_find_text | text 必填；mode=contains；index=0；region 可选；refresh=true | CDP 未落实 mode/region，越界 index 会回落第一项 |
| minimax_click_text | text 必填；mode=contains；index=0；region 可选 | CDP 路径未落实 mode/index/region；不要假定 exact 已保障唯一命中 |
| minimax_bot_message | action=send；chatId 有内置默认；limit=20，最大100；text 可选 | 调用方必须显式指定 action/chatId；cancel/resume_pending 同样是写动作 |
| minimax_auto_resume | dryRun=true；limit=5，最大20；sessionId 可选 | 额度读取失败目前默认可用；只用于预览，直到 unknown 与目标核验修复 |

`annotations.js` 当前分级是 read 13、ui 9、commit 5。它有助于展示，但不是权限判定；click/key 可能提交，Bot 消息可能触发外部行为。不得根据 `destructiveHint:false` 或 `openWorldHint:false` 绕过风险检查。

## 不兼容参数必须显式报出

| 问题 | 调用方当前处理 | 开发验收目标 |
|---|---|---|
| get_result：sinceMessageId / afterMessageId 不一致 | 不宣称精确轮次绑定；按完整会话 ID 核对历史 | 一个规范字段；如保留别名，冲突时报错，且测试经过 schema 和 handler |
| selectedOptionIds 仅内部支持 | selections 使用 optionIds，不只传旧别名 | 统一公开 schema 与标准化逻辑，验证每个选项和自由文本 |
| open_session.at、answer_question.region 未公开 | 不尝试靠额外参数绕过错误 | 实现并声明，或彻底删除不可达分支及旧示例 |
| stop_generation 的 ID 不生效 | 不能承诺定向停止 | 校验目标，返回实际停止的 session/turn |
| DOM/OCR 选择与坐标不同义 | 模糊、多命中、来源不明时拒绝点击 | 两驱动同一匹配语义；返回 coordinateSpace、targetId 与唯一性证据 |

## 上下文预算：现状与目标分开

**现状：**多数工具限制条数；search/pending 等做部分摘要，read_session 和 get_result 的正文没有统一总大小限制。当前没有 `maxOutputBytes`、`maxTokens` 或 `contextBudget` 工具参数。不能在调用里杜撰这些字段。

**本 Skill 推荐的调用方预算：**首读 brief limit=50、read_session limit=10、tail count=3/perSession=2、search limit=5、events limit=20、Bot read limit=10，includeThinking=false。需要更多证据再增量读取；不要反复 tools/list 或把整份规范、历史和所有 Bot 记忆附到每次问卷。

**待实现服务端默认：**单次文本结果 16 KiB UTF-8，单条摘要 2 KiB，返回 `truncated`、省略量、原始记录标识和继续读取位置。先脱敏，再生成预览；分页、长结果存储与读权限一起设计。整个 JSON envelope 应计入预算，不仅截断其中一个字段。问卷完整选项无法在预算内提供时，返回“需要继续读取/人工处理”，不得输出看似完整的决策输入。

**模型预算：**以每轮新增检索 8,000 tokens 作为初始策略，不是模型硬容量。已知容量 C 时，已有输入、预计工具结果和输出/后续调用预留的总和必须不超过 C；预留至少 25% C。用对应 tokenizer 或实际计量；无法计量时只给字节/字符值，不用固定字符比冒充 token。预算参数应可配置、可在决策记录中追踪，不允许模型自行无限提高。

工具清单、完整 schema 与本 Skill 都占上下文：按连接/契约指纹缓存发现结果，主 Skill 保持不超过 12 KiB UTF-8，审查与细节按需加载。未来若做分组发现，不能改变工具语义或把未授权工具误称为不存在。

## 套餐额度与自动恢复

当前代码的 `2056` / `Token Plan` 是恢复候选线索，不能据此推断模型上下文上限、恢复时间或费用。`getQuotaStatus()` 的 DOM 匹配失败与 `autoResume()` 默认 `isLimited:false` 都可能把未知误判为可用。

验收目标是 `available | exhausted | unknown` 三态，附 provider/source、checkedAt、expiresAt 和可用时的 resetAt；只接受未过期的正面可用证据。未知、离线、选择器变化或读取错误时只报告，不点击“继续”、重生成或发送。不得自动消耗重置卡、买额度或升级套餐。

所有恢复、问卷和催促共享一次 tick 的授权、allowSessions、闲置判断和动作额度，不能各自另算。当前每轮2次的设置**不能**保证总动作不超过2，续跑独立 limit=2 且绕过策略。显式 sessionId 也不能成为跳过幂等/冷却的理由。

## 协议演进

先修复现有工具行为与 schema，再考虑协议升级。当前 tasks 是服务端自动建任务的实现；2025-11-25 规范的任务增强需要单独核对 capability、每工具 taskSupport、请求 task 字段、CreateTaskResult、状态、取消及授权归属。不要只修改版本字符串。升级需锁定规范版本及客户端矩阵，不能把某个历史版本叫作“最新”。
