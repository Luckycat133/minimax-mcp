#!/usr/bin/env node
'use strict';

/**
 * MCP 服务器入口 — 薄包装层，实现都在 src/mcp/。
 * 直接运行即启动 stdio MCP 服务器。
 */

const mcp = require('./src/mcp');

if (require.main === module) {
  mcp.startStdioServer();
}

module.exports = {
  CONTRACT_VERSION: mcp.CONTRACT_VERSION,
  SERVER_INFO: mcp.SERVER_INFO,
  TOOLS: mcp.TOOLS,
  TOOL_NAMES: mcp.TOOL_NAMES,
  callTool: mcp.callTool,
  startStdioServer: mcp.startStdioServer,
};
