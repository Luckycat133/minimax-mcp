---
name: minimax-mcp
description: "Inspect MiniMax Code (MCode) status and quota, read native sessions, dispatch tasks, or collaborate with Bot Studio on macOS via minimax-mcp."
---

# MiniMax Code Controller (`minimax-mcp`)

`minimax-mcp` is invoked headlessly via Node without mounting permanent MCP tools (zero idle context tax):

```bash
/Users/jack/.local/bin/node -e '
  require("/Users/jack/Documents/DevProjects/minimax-mcp/mcp-server")
    .callTool("<tool_name>", <json_args>)
    .then(r => { for (const c of r.content || []) console.log(c.text); });
'
```

| Tool | Purpose |
| :--- | :--- |
| `minimax_status` | App/CDP status, active tasks, and quota (`quota.resetAtMs` / `waitSeconds`). |
| `minimax_session` | Search sessions (`{query, limit}`), read history (`{sessionId, limit, before, maxChars: 0}`), or sample recent activity (`{perSession: 2}`). |
| `minimax_agent` | Activate window (`{action:"activate"}`), send task (`{sessionId, message, send:true}` or `{newSession:true, message, send:true}`), poll result (`{action:"result", sessionId, afterMessageId, timeoutSeconds:60}`), or abort (`{action:"stop", sessionId}`). |
| `minimax_bot` | Open/query Bot Studio (`{action:"open"}` / `{target:"剪辑师", limit:5}`), send (`{action:"send", target, text, clientMessageId}`), or answer Bot cards (`{action:"answer", target, messageId, answers}`). |
| `minimax_questionnaire` | List pending cards (`{}`) or submit answers (`{requestId, selections, preview:false, force:true}`). |

## Execution Rules

1. **Direct Dispatch**: When the user asks you to dispatch a task or reply in MiniMax, pass `send: true` directly (no extra `preview: true` confirmation round-trip). Use `preview: true` only when self-checking an uncertain target before sending.
2. **Handle Truncation**: Default history truncates at 4000 chars (`contentTruncated: true`). Re-read a specific message in full with `{sessionId, limit: 1, before: messageId + 1, maxChars: 0}` (`includeThinking: true` if needed).
3. **Config Boundary**: Never copy or symlink external IDE skill directories into `~/.minimax/` (`skills.external.enabled` is intentionally `false`). Full tool contracts live in [mcp-surface.md](references/mcp-surface.md).
4. **Audit Admission**: Sends, answer submissions and Bot writes require a writable audit log. With `AUDIT_UNAVAILABLE` and `executed:false`, repair the audit directory first. Read-only previews and native stop remain available. With `audit.state:"outcome-unavailable"`, use the original receipt and session history to determine the result.
5. **Quota Exhausted → Self-Wakeup & Resume**: Never ask the user to wake you up when MiniMax quota is exhausted (`quota.isLimited === true`, error `2056`, or `wakeup.shouldSchedule === true`).
   - Run `minimax_status` to read `quota.resetAtMs` / `quota.waitSeconds` / `wakeup.wakeAfterSeconds`. If `cdp.online === false`, run `/Users/jack/.local/bin/node /Users/jack/Documents/DevProjects/minimax-mcp/scripts/launch-with-debug.js` first and re-check `minimax_status` to get the exact reset time.
   - Immediately schedule a one-shot self-wakeup timer (e.g. `schedule` with `DurationSeconds = wakeup.wakeAfterSeconds`, which adds a 30s buffer after `resetAtMs`, or 600s fallback if unavailable) whose prompt records the exact `sessionId` / Bot `target` and pending task.
   - Upon waking up, re-check `minimax_status` to confirm `quota.isLimited === false`, then resume: **Bot Studio** via `minimax_bot` `{action:"resume", target}` (or re-send a continue prompt if no pending turn remains); **Native Session** via `minimax_agent` `{sessionId, message:"额度已重置，请从上次中断处继续完成任务。", send:true}`.
