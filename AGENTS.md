# minimax-mcp — 工程约定

## 架构

薄 MCP 层 + 本地 gateway，两层严格分开：

```
mcp-server.js            薄入口，只转发
src/mcp/                 协议与工具面：contract / tools / handler / stdio-server
src/gateway/db.js        只读 SQLite（系统 sqlite3 CLI，参数转义后内联）
src/gateway/gui.js       GUI 驱动（调 scripts/mac_gui.py）
scripts/mac_gui.py       CoreGraphics 事件注入，纯 ctypes
skills/minimax-mcp/      配套 Agent Skill
```

改工具面只动 `src/mcp/`；改数据来源只动 `src/gateway/`。handler 不做实现，
只做参数校验、前台校验和错误转换。

## 硬规则

1. **数据库只读。** MiniMax App 运行时有内存缓存，写库会造成状态不一致。
2. **不引第三方依赖。** SQLite 走 CLI，GUI 走 python3，传输自己写。
3. **控制工具必须先过前台校验**，不在前台就返回错误，不允许硬点。
4. **`minimax_send_message` 默认不发送**，`send: true` 才回车；发送后必须查库验证。
5. **加工具要同步更新** `src/mcp/tools.js`、`references/mcp-tool-contracts.json`、
   `glama.json` 里的 tools 计数，以及 `tests/smoke.test.js`。

## 测试

```sh
npm run doctor   # 环境自检（不启动 MiniMax，不点击）
npm test         # 真实 stdio 会话冒烟：initialize → tools/list → 只读调用
```

冒烟测试刻意只调只读工具，这样用户正在用 MiniMax 时也能安全跑。

## 已知限制

- 不能按按钮文字可靠点击（Electron 无 AX 树，中文 OCR 不可用）。
- 切会话要点左侧列表，坐标随布局变。
- 窗口被完全遮挡时后台截到旧帧。
- MCP 工具面版本（CONTRACT_VERSION）与 MCP 协议修订号是两件事，别混。
