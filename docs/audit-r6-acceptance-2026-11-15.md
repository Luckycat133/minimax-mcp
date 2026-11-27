# MiniMax MCP 审计 R6 本地验收

2026-11-15 在 `main@1c6f4f4122f33c833a9f6aea062ad1d0d574e9d4` 的现有五工具工作树上验证。任务依据为审查分支 `916692d031fbea3ba0a38e0ee58396f6cb81b3ef` 的 `skills/minimax-mcp/references/safety-review-2026-11-14.md` R6。

操作日志只保留时间、已知工具和风险级别、枚举动作和模式、布尔操作标志、耗时、调用方结果标志及有限的数值坐标。缺少结果标志时写 `ok:null`。原始错误只记录固定标记 `operation_error`，消息、查询、凭据、标识符、问卷内容及点击文字均不写入新记录。`recent()` 保留最近记录的顺序和元数据形状，过滤旧 JSONL，损坏行仅返回 `malformed:true`。

在 macOS arm64 / Node 26.13.1 执行：

| 检查 | 结果 |
| --- | --- |
| `node --test tests/audit-r6.test.js` | 5/5。验证内容前中后及短字符串、嵌套字段、坐标对象和返回诊断的合成敏感值均未进入新审计。新目录位为 `0700`，已存在的目录保留原权限。活跃日志和本次生成的轮转备份为 `0600`。保留一份 `.1`，旧行过滤不改历史字节。链接文件与磁盘错误处理通过。 |
| 上述套件内的 MCP `initialize → tools/list → tools/call` | 协商 `2025-06-18`，仍为 5 个公开工具；链路在隔离 Bot fixture 上运行，已验证、结果未知和拒绝各产生一条仅含元数据的审计。 |
| `node tests/contract.test.js` | 19/19，包含更正后的审计白名单约定。 |
| `node tests/control.test.js` | 临时 SQLite、模拟原生控制和环回 Bot 接口通过，包括 sends/stop、问卷回读和 Bot 结果未知时不重发。 |
| `node --check src/gateway/audit.js`、`git diff --check` | 通过。 |

临时 `MINIMAX_MCP_HOME` 独立于用户数据，本轮未迁移历史日志。历史文件仍可能含早期内容，`recent()` 的过滤只作用于读出的结果。本切片只覆盖 `audit.jsonl`，审查报告中的 watch、事件、任务持久化以及审计不可用时的高风险准入仍需独立处理。
