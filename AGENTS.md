# minimax-mcp — 工程约定

## 架构边界

薄 MCP 层 + 本地 gateway 严格分离：`mcp-server.js` 仅转发；改工具面只动 `src/mcp/`（handler 只做参数校验、前台校验和错误转换，不写底层实现）；改数据/GUI/OCR 只动 `src/gateway/` 与 `scripts/mac_gui.py`、`scripts/ocr.swift`；配套 Skill 在 `skills/minimax-mcp/`。

## 校验与打包命令

```sh
npm run doctor       # 环境自检（不启动 MiniMax，不点击）
npm test             # 真实 stdio 冒烟（刻意只调只读工具，用户使用 MiniMax 时可安全跑）
npm run pack:npm     # 打 tarball 并校验内容（不发布）
npm run pack:mcpb    # 打 .mcpb bundle 并解包验证能 require
```

- 跑 `edge.test.js` 等涉及 `watch`/`audit`/`tasks` 的测试必须通过 `MINIMAX_MCP_HOME` 隔离到临时目录，否则会向真实 `~/.minimax-mcp/events.jsonl` 写假事件。

## 硬规则（附原因）

1. **数据库只读**：MiniMax App 运行时有内存缓存，直接写 SQLite 会导致状态不一致。
2. **零第三方依赖**：SQLite 走系统 `sqlite3` CLI（参数转义后内联），GUI 走 `python3` ctypes，传输层自写。
3. **控制工具先过前台校验**：不在前台必须直接报错，禁止硬点；`minimax_send_message` 默认不发送（`send: true` 才回车），发送/答问卷后必须回库验证（`verified` 以数据库为准，不信“我点了”）。
4. **增删工具同步清单**：同步更新 `src/mcp/tools.js`、`skills/minimax-mcp/references/mcp-tool-contracts.json`、`glama.json`（tools 计数）及 `tests/smoke.test.js`。
5. **契约版本与协议版本分离**：`CONTRACT_VERSION`（工具面版本）与 MCP 协议修订号不要混用。

## 高危踩坑警告（均已修，勿回退）

- **前台与焦点窗口**：判断前台必须用 `lsappinfo front` → `lsappinfo info <ASN>`（浮动 `NSPanel` 永远在最上层，不能看最上层窗口）；窗口枚举用 `kCGWindowListOptionAll` + `open -a`（`OnScreenOnly` 会漏最小化/跨 Space 窗口）；取焦点窗口必须按目标 App 的 PID 查 `AXFocusedWindow`（否则 MCP 宿主在前台时会误点宿主）；主窗口宽度阈值保持 `320`（非 `800`）。
- **SQLite 与截图坐标**：`sqlite3` CLI 不收绑定参数且占位符替换须避开单引号字面量；`screencapture -R` 按屏幕点计坐标（切勿重复乘 backing scale，换 Retina 机需复测）；`at` 坐标必须先校验非 NaN。
- **OCR（macOS Vision）**：侧栏与顶栏会出现同名标题，必须用 `pickLeftmostColumn` 取最左列最上方；`prefix` 模式严禁兜底到 `contains`（点错按钮比找不到更危险）；Vision y 轴向上须用 `1 - bbox.maxY`；长锚点跨行由 `findByAnchor` 逐级缩短重试。
- **问卷与打包**：`src/mcp/questionnaire.js` 同时兼容 `optionIds`/`selectedOptionIds`，未知 ID 必须显式报错不静默忽略；构建脚本拷 `.py` 必须用 shell `cp`（先 `mkdir -p`，宿主 `fs.copyFileSync` 会以 `CODEBUDDY_BROKER_DENY` 拒 `.py`）；`dist/` 保持在 `.gitignore` 且排除在 `npm pack` 外。
- **launchd 安装**：沙箱下 `launchctl bootstrap` 可能报 `Input/output error`，安装脚本失败时必须保持旧任务原样，绝不能停旧装新失败。

## 深入参考（按需读取，1 跳指针）

- 设计取舍（`brief` 优先级、三档风险、审计、主动巡检四道闸、`ask_human` vs `skip`）与 2026-10-31 真机排坑全记录：[docs/design-and-pitfalls.md](docs/design-and-pitfalls.md)
- 配套 Agent Skill：[skills/minimax-mcp/SKILL.md](skills/minimax-mcp/SKILL.md)
