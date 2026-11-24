# minimax-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![Glama](https://glama.ai/mcp/servers/Luckycat133/minimax-mcp/badge)](https://glama.ai/mcp/servers/Luckycat133/minimax-mcp)

`minimax-mcp` 是 macOS 上 MiniMax Code 的本地 stdio MCP 服务和 Agent Skill。它提供会话检索、任务调度、Bot Studio 对话、问卷和额度状态。会话数据从 MiniMax 的 SQLite 运行时库只读获取，原生会话的定向控制通过 Chrome DevTools Protocol（CDP）完成。

## 工具

| 工具 | 用途 |
| --- | --- |
| `minimax_status` | 查看应用、数据库、CDP、额度和待处理事项。 |
| `minimax_session` | 列出或采样最近会话，读取历史，搜索标题和消息。 |
| `minimax_agent` | 激活窗口、预览或发送指令、查询回复、打开新任务、停止轮次。 |
| `minimax_bot` | 打开 Bot Studio、查看名册、读写对话、取消或恢复轮次、回答卡片。 |
| `minimax_questionnaire` | 查看待答问卷、预览推荐答案、提交选项。 |

历史读取与会话采样默认每条文本最多 4000 个 Unicode 字符，截断会带 `contentTruncated`/`thinkingTruncated` 和原长度。全文取回用同一 `sessionId`、`limit:1`、`before:消息id+1`、`maxChars:0`，核对返回消息 ID；思考字段另加 `includeThinking:true`。这不影响 `minimax_agent` 的最终结果。

常用参数和旧调用的迁移方式见 [MCP 工具面](skills/minimax-mcp/references/mcp-surface.md)。会话、Bot 和问卷的工作流见 [MiniMax MCP Skill](skills/minimax-mcp/SKILL.md)。

## 安装与配置

需要 macOS、Node.js 22+、Python 3、SQLite 3，以及已登录的 [MiniMax Code](https://agent.minimax.cn/)。

```sh
git clone https://github.com/Luckycat133/minimax-mcp.git
cd minimax-mcp
npm run doctor
```

在支持 `mcpServers` 的客户端（如 Claude Desktop 或 Cursor）中添加以下配置，将脚本路径替换为本机的绝对路径。若客户端找不到 `node`，在 `command` 中填写 Node.js 的绝对路径。

```json
{
  "mcpServers": {
    "minimax-mcp": {
      "command": "node",
      "args": ["/path/to/minimax-mcp/mcp-server.js"],
      "env": {
        "MINIMAX_PYTHON": "python3",
        "MINIMAX_SQLITE_BIN": "sqlite3"
      }
    }
  }
}
```

在本机使用 `npm link` 后，也可将 `command` 设为 `minimax-mcp` 并省略 `args`。

从仓库根目录运行以下命令可启用 CDP，脚本在端口未启用时会重启 MiniMax Code。默认端口为 `9223`，就绪后可在 `minimax_status` 的 `cdp.online` 字段确认。

```sh
node scripts/launch-with-debug.js
```

## 调用与验证

先通过 `minimax_session` 获取已有会话的完整 `sessionId`。发送前可用 `minimax_agent` 的 `preview:true` 检查目标和守卫状态。默认 `send:false` 只填写草稿，实际发送需显式传 `send:true`。服务端从 SQLite 核对消息，确认后返回 `sent:true`、`verified:true` 和 `messageId`。将该消息 ID 作为 `afterMessageId` 查询本轮结果。若返回 `sent:null`，先读取目标会话确认。

原生会话控制需要 CDP 已连接。用 `minimax_agent({action:"activate"})` 将窗口切到前台。停止时传 `sessionId`，可用发送回执的 `messageId` 作为 `afterMessageId` 锁定该轮。运行库确认后返回 `stopped:true`。问卷默认返回题目和推荐答案，提交前打开目标卡片并传 `preview:false` 和 `force:true`。

用 `minimax_bot({action:"open"})` 启动 Bot Studio 实时连接。写入需传具体的 `target`，读历史时可用 `source` 判断数据来源。控制动作的审计记录位于 `~/.minimax-mcp/audit.jsonl`。

执行发送、提交答案等写操作前，MCP 会同步写入脱敏准入记录。收到 `AUDIT_UNAVAILABLE` 和 `executed:false` 时，修复本地审计目录后再调用。读取、预览和原生停止仍可用。若回执包含 `audit.state:"outcome-unavailable"`，按原回执与历史核对结果后再决定是否重试。

在 MiniMax Code 已登录的 Mac 上，从仓库根目录运行 stdio MCP 冒烟测试和只读基准。基准记录 MCP 调用耗时。

```sh
npm run test:mcp
node scripts/test-all-tools-benchmark.js
```

用 `npm run test:audit` 在临时目录运行审计准入与脱敏回归。测试使用隔离的 stdio 服务和 loopback Bot 替身。

## 后台巡检

可用 macOS launchd 按默认 5 分钟间隔运行巡检。巡检记录状态变化，并按本地策略处理会话和待答问卷。报告和审计保存在 `~/.minimax-mcp/`。遇到额度限制，通过 `minimax_status` 查看可用的重置时间，再决定何时继续任务。

```sh
node scripts/install-watch-agent.js --dry-run
node scripts/install-watch-agent.js
node scripts/install-watch-agent.js --uninstall
```

## 文档、更新日志与许可证

- 文档索引：[docs/README.md](docs/README.md)
- 变更记录：[CHANGELOG.md](CHANGELOG.md)
- 许可证：[MIT](LICENSE)
