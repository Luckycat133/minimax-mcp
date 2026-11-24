# Changelog

本项目的所有重要变更均记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本迭代采用 `0.x.y` 语义化版本号（pre-1.0）。

## [Unreleased]

### Added

- 写操作前增加同步脱敏审计准入机制：本地审计目录不可用时阻断执行并返回 `AUDIT_UNAVAILABLE` 与 `executed:false`；新增 `npm run test:audit` 与 `npm run test:mcp` 隔离回归测试及 R6 验收记录（[docs/audit-r6-acceptance-2026-11-15.md](docs/audit-r6-acceptance-2026-11-15.md)）。
- 拆分 `src/gateway/agent.js`、`src/gateway/desktop.js`、`src/gateway/questions.js` 模块并移除遗留的 `cua.js` 与 `resume.js`。

### Changed

- 会话历史读取与采样默认按 4000 个 Unicode 字符截断，返回 `contentTruncated`/`thinkingTruncated` 与原文长度，支持通过 `maxChars: 0` 按单条取回全文。
- 审计日志收紧为元数据白名单（不落盘正文、查询词、凭据或问卷内容）并限制目录与日志权限。

### Fixed

- 将 `.agents/skills/minimax-mcp` 从残缺副本修复为指向 `../../skills/minimax-mcp` 的符号链接，确保 `references/mcp-surface.md` 等配套资产可正常解析。

### Docs

- 同步 `README.md`、`llms.txt`、`llms-full.txt` 与 Skill 文档至五工具面、全文取回流程与审计准入说明。

## [0.3.0] - 2026-11-13

### Changed

- 重构为目标优先（target-first）的 Agent Harness 架构，将公开 MCP 工具面从 27 个分步收敛至 11 个，最终精简为 5 个领域驱动工具（`minimax_status`、`minimax_session`、`minimax_agent`、`minimax_bot`、`minimax_questionnaire`），并同步更新工具契约与 Skill（`eebb547`, `e9ecb3b`, `9981571`）。

### Removed

- 移除底层屏幕点击等原始 UI 工具以及不成立的 `auto_resume` 概念，严格锚定真实原生会话交互与 Token Plan 额度追踪（`eebb547`, `1c6f4f4`）。

## [0.2.0] - 2026-11-13

### Added

- 巡检唤醒时间对齐 MiniMax 额度重置时间戳，并引入 fast-gate 冷却锁定保护（`9db41a8`, `1e267b4`）。
- 扩展 `status` 观测面，补齐连接、CDP 与 Bot 状态回报（`c70ac27`）。

### Fixed

- 实现零代理直连发现本地 Bot Studio 服务，并在激活客户端时支持自动注入 CDP 调试端口（`c70ac27`）。

### Docs

- 全面更新 `SKILL.md`，补充工具覆盖、工作流配方与零代理 Bot 架构说明（`365e2ad`）。

## [0.1.1] - 2026-11-11

### Fixed

- 空闲 CDP WebSocket 自动断开连接并增强队列暂停自愈检测（`602ab1c`）。

### Docs

- 补充 Smithery 安装指南与生态徽章（`ed32832`）。

## [0.1.0] - 2026-11-09

*(对应 Git 标签 `v0.1.0` @ `e0688fd`，涵盖 2026-10-25 至 2026-11-09 的首个完整里程碑。)*

### Added

- 建立本地优先的 stdio MCP 服务、只读 SQLite 数据层、CoreGraphics GUI 驱动、一次性调用脚本 `scripts/call.js` 与配套 `minimax-mcp` Agent Skill（`2300712`, `a284e18`）。
- 补齐 `get_result`、`stop_generation`、`answer_question` 草稿模式、会话管理、Tasks 扩展以及 npm / `.mcpb` 打包流程（`92e2f02`, `d7a869c`）。
- 引入基于 macOS Vision 的 OCR 识别层与数据库回读校验，支持「选中即提交」型问卷核验（`4438121`, `5a3e12e`）。
- 新增 `brief` 态势快照、read/ui/commit 三档风险分级、本地操作审计、风险策略裁决、快照 diff 主动巡检队列与 macOS launchd 安装脚本（`c2529f3`, `e7abd52`, `ab6b40e`）。
- 升级为无权限 CDP/REST 控制面，新增 MiniMax Bot 团队协同与 OpenRouter 集成（`25469f7`, `f321f3c`, `20301a6`）。

### Fixed

- 修复活跃应用判定、隐藏窗口发现、按目标 PID 取焦点窗口与 Retina 缩放换算，并加入双信号活跃守卫与 `--dry-run` 预览（`6568547`, `0d38d93`）。
- 修复 8 项自查缺陷（不存在会话静默回退、重复 `emit` 吞通知、轮询空转、`runningTasks` 计数、SQL 占位符解析、窗口宽度阈值、截图缩放与坐标校验），并补齐 `read_session` 翻页、`search` 搜标题与策略持久化（`32ed22b`）。
- 真机打通 `answer_question` 提交流程与自动代答，修复 `new_task` 仅识别新窗口的问题并新增 `MINIMAX_MCP_HOME` 测试隔离，补充 `osascript` 窗口激活兜底（`1ea4bf2`, `9aeb6c3`）。

### Docs

- 新增 2026 现代 MCP 技术栈调研报告、`llms.txt` / `llms-full.txt`、`smithery.yaml` 及 Glama/npm 发现关键词（`e748294`, `da4a967`, `5f53391`, `e0688fd`）。
