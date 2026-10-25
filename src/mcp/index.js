'use strict';

/** index.js — MCP 层统一出口。 */

const { CONTRACT_VERSION, SERVER_INFO, PROTOCOL_VERSIONS } = require('./contract');
const { TOOLS, TOOL_NAMES } = require('./tools');
const { callTool, READONLY } = require('./handler');
const { startStdioServer, handle, negotiateProtocol } = require('./stdio-server');

module.exports = {
  CONTRACT_VERSION,
  SERVER_INFO,
  PROTOCOL_VERSIONS,
  TOOLS,
  TOOL_NAMES,
  READONLY,
  callTool,
  handle,
  negotiateProtocol,
  startStdioServer,
};
