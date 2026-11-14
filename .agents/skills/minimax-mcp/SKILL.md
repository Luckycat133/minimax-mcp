---
name: minimax-mcp
description: 开发或审查 minimax-mcp 的会话隔离、高危操作、审计隐私、上下文预算、Bot 协同与问卷拟答时，加载仓库中的唯一规范正文。
---

# MiniMax MCP 仓库入口

先完整读取 [唯一 Skill 正文](../../../skills/minimax-mcp/SKILL.md)，再按任务读取其 references。不要复制维护第二套工具列表或默认值；发布包继续使用 `skills/minimax-mcp`。

本入口补于 2026-11-14；审查基线 `ed3283266b32d395ed17282cc8b848a2d9ed9088` 当时没有 `.agents` 目录。文档更新不表示运行时缺陷已修复。

在修复验收前不启用无人值守跨会话写入。特别注意：当前 watch 的 observe/off 不能阻止末尾自动续跑，诊断 tick 必须显式 dryRun:true；原始远程代理没有入站认证，不得对外开放。
