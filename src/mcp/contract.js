'use strict';

/**
 * contract.js — MCP 工具面契约。
 * CONTRACT_VERSION 是工具面版本，与 MCP 协议修订号是两件事。
 */

const CONTRACT_VERSION = 1;

const SERVER_INFO = {
  name: 'minimax-mcp',
  title: 'MiniMax Code MCP',
  version: '0.1.0',
  contractVersion: CONTRACT_VERSION,
};

const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];

module.exports = { CONTRACT_VERSION, SERVER_INFO, PROTOCOL_VERSIONS };
