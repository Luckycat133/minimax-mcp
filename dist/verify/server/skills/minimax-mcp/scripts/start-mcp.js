#!/usr/bin/env node
'use strict';

/**
 * start-mcp.js — Skill 自带的启动器。
 * 解析到本仓库根目录，然后跑 mcp-server.js。不接受环境变量指定的入口，
 * 避免被注入任意 JS。
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..', '..');
const entry = path.join(root, 'mcp-server.js');

const child = spawn(process.execPath, [entry], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
