# 2026-11-14 桌面自动化与 MCP 网关审查

## 范围、证据与结论

源码固定在 `ed3283266b32d395ed17282cc8b848a2d9ed9088`，不是用户未推送的工作区。该树没有 `.agents`；原规范位于 `skills/minimax-mcp`。本变更只更新文档与发现入口，不修改运行代码、协议版本或发布产物，也不代表以下缺陷已经修复。

用户报告本地 npm test 全绿（19/19 契约、28/28 策略、15/15 标准化、13/13 OCR、24/24 边缘及10组协议模拟）。本次没有访问用户本机、完整复跑该测试集、调用生产 Bot、点击桌面或实际探测远程代理。审查依据是源码、测试断言和隔离的源码摘录反例；不能把用户的本地验收与本次环境中的执行混为一谈。

**结论：**只读观察、参数检查、默认预览、部分 GUI 防覆盖与保守问卷分类有实质基础；尚不能认定跨会话无人值守执行、高危操作全路径隔离和审计隐私已经成立。先封闭网络与写入边界，再扩展 Bot 协同及实时自动拟答。

## 已经有价值的实现

- `validate.js` 会检查类型、必填、未知字段和范围，避免 NaN 坐标等静默错误。
- `send_message.send` 默认 false；`answer_question` 默认 preview，实际提交还要求 force；`auto_resume` 默认 dryRun。
- `policy.js` 对识别出的高风险问卷始终转人工；没有推荐、多步骤和不明确问题一般提升为 medium。
- GUI 分支有活跃应用与遮挡检查；问卷选项缺失会停止最终提交；发送和问卷尝试通过数据库检查结果。
- 协议读取与长等待支持并发/取消的方向正确，但共享桌面写入必须单独串行化。

这些保护需要扩展为同一条执行链上的不变量，而不是散落的局部约定。

## 发现与优先级

### R1 / P0（条件成立时）：远程代理扩大本地权限边界

位置：`src/gateway/miniapp-remote-proxy.js::createProxyServer/discoverTarget`。

默认及 CLI 启动均监听 `0.0.0.0:18888`。HTTP 和 upgrade 请求未经入站认证就转发，并注入 CDP 获取的本地 `x-mavis-miniapp-token`。如果代理运行且端口网络可达，调用者可能以本地权限访问 Bot；本审查未确认实际部署或发生过访问。

整改：默认 loopback；远程入口需显式开启、独立认证、逐动作/目标授权、路径与方法白名单、Host/Origin/CSRF 防护、超时/体积/速率限制，HTTP、SSE 和 WebSocket 一致执行。外部认证令牌与本地宿主令牌分离，禁止凭证写日志。TLS 或可信认证隧道不能替代应用层授权；CORS 也不是认证。

验收：未认证请求在调用 discoverTarget/上游之前即拒绝；无权目标、写权限不足、错误 Origin、upgrade、重放及过大请求均有失败测试。默认不对局域网监听。不为验证而对生产端口发送写请求。

### R2 / P1：watch 的续跑分支绕过策略

位置：`src/gateway/watch.js::tick`，第6段自动恢复；`src/mcp/handler.js::minimax_watch`。

tick 末尾仅检查 `opts.autoResume !== false`，直接调用 `autoResume({dryRun,limit:2})`，没有检查 mode、allowSessions、idle 或 actionBudget。MCP 的 watch schema/handler 也没有传入这个关闭选项。因此 `mode:off/observe`、空白名单或动作额度0都不能保证无续跑副作用。恢复绕过注入的 execute/callTool，缺少逐动作统一审计。dryRun 虽阻止实际恢复，仍保存巡检状态、事件和报告；不能叫零副作用。

整改：tick 的全部写入只能经过同一个 planner/authorizer/executor；off 不规划写动作，observe 仅产出计划，act 才可能执行。所有类别共享预算、白名单、授权、目标验证和每次动作前的闲置判断。dryRun 计划也应遵守同样的数量限制，文件副作用单独说明。

验收：模拟有额度阻断会话，对 off、observe、dryRun、maxActionsPerTick=0、allowSessions=[]、人正在使用桌面分别断言所有写 adapter 调用数为0；代答、催促、续跑混合时总动作≤预算；自动续跑也有逐动作审计。

### R3 / P1：会话定位与提交没有绑定成事务

位置：`handler.js::minimax_open_session/minimax_send_message/minimax_answer_question/minimax_stop_generation`；`watch.js::tick`；`cdp.js::discover/connect`。

open_session 使用标题片段/侧栏几何，不验证实际 session；send_message 不接受目标 sessionId。watch 挑选某会话催促，却直接向当前视图发送；问卷代答同样未核验屏幕上的 request/session。stop_generation 接收 ID 但不使用。CDP 会发现目标却复用既有 WebSocket，缺少目标代际校验。活动守卫只能判断最近是否有活动，不是身份确认。

`stdio-server.js` 并发处理请求本身合理，但不能让两个写事务交错。读取目标数据库记录也不能证明 GUI 已切换到该目标。

整改：gateway 引入唯一 mutation orchestrator，使用完整稳定 ID、固定 CDP target/window、会话/问卷 revision 和短期 focus lease；导航、确认、写入和核验处于同一互斥事务。GUI 全桌面写锁；多 MCP 进程共享桌面时采用跨进程租约/单写入进程。读操作保持并发；紧急停止不应排在长时间等待之后。锁不能阻止真人切窗，仍需在每次副作用前重新确认目标。

验收：A/B 同名、同前10字、侧栏未渲染、多窗口、CDP 重连、用户中途切换、并发 send/open/answer、多个服务进程等场景中，写入要么落在完整绑定目标，要么无写入失败；审计分别记录 intendedTarget 与 observedTarget。

### R4 / P1：成功证据弱，未知结果可能触发二次提交

位置：`db.js::waitForUserMessage`；`handler.js::minimax_send_message/minimax_answer_question`。

消息验证查询全库最后一条用户消息，仅比较前12字符，不约束目标或完整内容。CDP 已尝试发送但验证未成功或抛错后，执行可能落到 GUI 再发。问卷把任何非 pending 状态当成功，未区分 answered、expired、cancelled，也未比较实际答复；自动提交型问卷的状态检查在整个点击计划后才做。

整改：明确 `not_attempted / committed / unknown / rejected`，未知不得自动跨驱动重放。优先使用上游 operationId/idempotencyKey；无法获得时只能保证本地去重与核对，不能承诺端到端 exactly-once。发送核对 session、消息身份与完整规范化内容；问卷核对 requestId、revision、answered 和实际答案。可能 auto-submit 的每次点击后立即核验并停止过期计划。

验收：相同前缀不同正文/会话、DB 延迟、发送后响应丢失、按钮触发后超时、人工同时提交、问卷过期/撤销、多步 auto-submit 均不会误报完成或重发；未收到确定结果时不增加“成功”计数。

### R5 / P1：高危默认拒绝只覆盖部分入口

位置：`policy.js::classifyQuestion/classifyOutgoing/decideQuestion`；`handler.js::callTool`；`annotations.js`；`bot.js`；`resume.js`。

高风险问卷被 watch 拦截，但直接 answer/send、通用 click/key、Bot 写动作、恢复没有共享同一个裁决器。classifyOutgoing 未命中词表时归 low；未知语言或间接“继续原任务”不等于安全。annotations 和 GATES 文本是说明，不是执行授权。force/confirmed 布尔由调用者自报，不能证明人的批准。Bot schema 默认 send 和固定群聊，使省略目标也可能发出消息。

整改：默认不启用无人值守写入，由用户明确选择允许会话和低风险动作类型；模式默认 observe。高危操作必须有可信 UI/宿主签发、绑定目标/动作/内容摘要/有效期的单次批准，模型不能自行签发。通用控制工具不能成为绕过批准的通道。未知/冲突证据至少转人工，不因某个推荐或较高置信度自动降低风险。

验收：逐个调用所有写入口，缺授权、过期/重放/目标不匹配批准、未知风险和提示注入时 adapter 写计数为0；“点击购买”和“购买工具”应用同一规则。Bot 显式 chatId/action，取消和续跑也纳入策略。

### R6 / P1：审计截断不是脱敏

位置：`audit.js::sanitizeArgs/record`；`handler.js::callTool`；watch 的事件/报告与 tasks 持久记录。

字符串≤80字符原样保存；长文本保留前80字符；target 直接写入，error 只截前300字符。秘密位于开头或短字符串时仍暴露，点击结果也可能包含原始文本。默认目录/文件权限没有明确设为0700/0600；审计异常被吞掉。`ok` 主要取决于 isError，不能代表 verified 或业务已完成。

整改：默认正文不入审计，仅允许必要元数据；对 args/target/error/events/tasks/report 采用同一白名单和脱敏管线，脱敏先于截断。关联摘要采用 keyed HMAC 与轮换密钥，不能将猜测空间很小的正文用裸 hash 当匿名化。明确文件权限、保留期和截屏保护；审计健康状态要可观察，高危操作审计不可用则拒绝，读取/紧急停止保留。参数校验失败应有不含原始敏感值的拒绝事件。

验收：合成密钥放在开头/中间/结尾、短文本、嵌套对象/数组、error、target.clicked、事件和任务正文；断言所有落盘及返回诊断不包含 canary，而非只断言长度。覆盖日志轮转、权限、磁盘错误、部分失败与 unknown 状态。

### R7 / P1：契约与行为漂移

位置：`tools.js`、`handler.js`、`questionnaire.js`、`validate.js`。

get_result 的 schema 是 sinceMessageId，handler 却读 afterMessageId；open_session.at 和 answer_question.region 仅存在于执行代码/旧文档；selectedOptionIds 内部支持但公开 selections 要求 optionIds；stop 的 sessionId 不生效。find/click_text 的 CDP 路径没有落实所有匹配参数。new_task 找不到新建按钮时仅聚焦旧编辑器也可能返回 opened:true。

整改：一个规范字段来源生成 schema、契约摘要和合法示例；别名先去冲突再归一化，不保留会被 additionalProperties 拒绝的未知键。响应描述实际证据，不把“点击成功”冒充“目标状态达成”。更新输出错误码/结构时同步版本与兼容策略。

验收：每个文档示例经过真实 tools/call 校验并断言所选参数确实影响执行；两驱动参数语义一致；不支持参数必须明确拒绝。schema 名称覆盖测试不能替代行为测试。

### R8 / P1：额度未知按可用处理，恢复缺少真实确认

位置：`resume.js::autoResume`；`cdp.js::getQuotaStatus`。

额度默认 `isLimited:false`，CDP 不可用/读取失败后继续使用该值；DOM 无 banner 也不能排除选择器变更。原生恢复忽略会话导航是否成功，并把 send-button 当继续按钮兜底。Bot 映射缺失时回落固定群聊。历史按一小时冷却，不是真实重置周期；显式 sessionId 跳过该冷却；某些失败尝试仍计入 resumedCount/history。

整改：额度三态+来源/时间/TTL；未知只报告。精确绑定目标及暂停原因，不使用普通发送按钮猜测恢复；registry 映射缺失报错。去重按真实 operation/turn/额度周期证据，不将人工指定目标当豁免；区分 planned/attempted/verified/resumed。

验收：CDP 离线、选择器变化、额度未知/过期、非额度错误、导航失败、无目标 Bot、409 含义不明确、重复恢复和跨周期等测试。没有证据不能把409统一解释为已经安全完成。

### R9 / P2：上下文与协议边界不够明确

位置：`db.js::readSession/waitForResult`；`handler.js::ok`；`stdio-server.js`；`contract.js`。

条数限制不是正文总量限制；大量完整历史/结果仍可挤占模型上下文。当前 Tasks 实现的协商和服务端自动建任务需要与锁定版本规范单独比对，不能只靠 capabilities.tasks 存在及方法有响应判合规。

整改与预算见 mcp-surface.md：按需读取、服务端总字节预算、明确截断/分页、实际 tokenizer 计量、已知容量下预留空间；不要把上下文窗口、计费 Token Plan 和每 tick 动作额度混用。协议升级与安全修复分开，不只改版本号。

## 本次隔离反例

使用原函数摘录与合成数据，不访问 SQLite/CDP/GUI，不导入运行网关：

| 反例 | 观察结果 |
|---|---|
| sanitizeArgs 的短敏感文本 | 合成 canary 完整保留 |
| sanitizeArgs 的长敏感前缀 | 截断后仍包含前缀 canary |
| waitForUserMessage 的数据访问桩返回其他会话、相同前12字但不同正文 | 返回 ok:true 与其他会话 ID |
| schema 合法的 sinceMessageId=100 代入 handler 消费表达式 | afterMessageId 基线变成0 |

这些证明局部缺陷，不是完整 npm test、macOS 实机验证或远程渗透测试。现有 contract.test.js 的“脱敏”仅断言长度和占位符；“commit 默认不动作”主要检查布尔默认值和 GATES 文本。测试全绿与上述反例可以同时成立。

## 下一步交付顺序

**阶段 A：封闭执行边界。** 先修 R1、R2，再建立统一写入执行器、目标绑定、未知结果状态与审计白名单。先加失败测试，再实现；所有现有测试也必须保持通过。此阶段不增加自动执行范围。

**阶段 B：Bot Studio 只读/拟答协同。** 以能力协商和明确对象 ID 替代默认群聊与标题点击。保留既有本地适配器作为兼容路径，优先对接受宿主认证/审批控制的正式 Mini App/hosted MCP/Agent API，不能把当前私有 HTTP 路由当稳定公开契约。

**阶段 C：问卷低风险受控自动提交。** 先 shadow 运行，记录建议与真实人工选择差异，再对用户明确允许的单步可逆题型开启执行；不把“自动化覆盖率提高”作为放松授权/目标验证的理由。

## 与 MiniMax Bot Studio 协同的接口提案

这里的“团队”同时覆盖项目里的 Bot 团队与需要对齐接口的上游维护者；本审查没有替用户向任何团队发送信息。

要求上游确认（这些是提案，不声称已经支持）：

- 稳定的 workspaceId/chatId/botId/sessionId/turnId/requestId 映射及能力/版本发现；不可用、无权限和未知状态可区分。
- 事件携带 eventId、entity revision、cursor；断线重放/去重/重新同步，且不把推送顺序当全局因果顺序。没有正式订阅时保留只读轮询。
- 提交接口支持 expectedRevision、幂等 operationId、服务端结果查询、过期/冲突语义和真实答复回显；答题、发消息、取消、续跑分别授权。
- 正式宿主认证与最小权限能力；不要以导出本地令牌给任意入站请求作为集成契约。

建议职责：Bot 提出候选与领域证据；按需要由另一个 Bot 检查证据和冲突；MCP 网关单点负责授权、绑定、预算、执行和审计；人保留高危决定及偏好冲突的最终控制。双 Bot 一致不能构成独立权限批准。

## 实时问卷自动拟答路线

**决策对象建议：** decisionId、requestId、revision、sessionId、status、题干/完整选项、候选 selections、证据定位、用户偏好版本、风险类别、缺失信息、模型/策略版本、上下文用量、审批要求。模型返回草稿，不返回可自行生效的批准令牌。

**状态机建议：** observed → drafted → needs_review / eligible → authorized → executing → verified；并行终态含 stale、rejected、unknown。每次提交前重新读 pending/revision 和授权；unknown 不重试，先查结果。当前只有 recommended/首项启发式，不能称为实时智能拟答已完成。

**逐级推进：**

1. 规则拟答：明确声明的用户偏好与会话目标优先，recommended 仅是提示；没有可靠答案时 abstain，禁止默认第一项。
2. 证据增强：仅取该会话必要的近期消息、相关成果和有限偏好记录；标记外部/问卷文本为不可信数据，不能被其中的“忽略规则”改变授权。选项未完整加载则停止。
3. Shadow 模式：不点击，只与人类实际答案对照；用独立样本和不同题型验证，不以拟答器自己的置信度自证。
4. 受控自动提交：仅已授权会话和动作类型，revision 未变，低风险、证据充分且结果可验证；发生目标不一致、隐私泄露或未知提交立即熔断。

建议评估：分题型候选正确率/人工修改率、拒答率、过期草稿拦截率、错误会话写入数、重复提交数、高危漏放数、秘密泄露数、每题上下文用量与端到端延迟。安全反例测试必须零错误，但有限样本的零错误不证明真实风险为零；为线上观察保留采样数和不确定性。不要用未经校准的固定置信度（如0.9）直接替代授权。

## 外部依据（访问于 2026-11-14）

MiniMax 在 2026-10-22 的 Mini App 介绍中说明了 hosted MCP、Agent API、Host Connectors、宿主认证/工具审批和 MiniMax Bot 的团队协调角色；这支持优先协商正式接口，但不证明上述具体字段已存在。MCP tools 规范将 annotations 定位为提示而非授权机制；2025-11-25 Tasks 文档用于对照，不声称是当前最新修订。

```text
https://www.minimax.io/blog/minimax-code-mini-app-1792650729
https://modelcontextprotocol.io/specification/2025-11-25/server/tools
https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks
```
