#!/usr/bin/env node
'use strict';

const { connect } = require('./stdio-client');

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const [tool, rawArgs] = argv.filter((arg) => arg !== '--dry-run');
  if (!tool) throw new Error('用法: node scripts/call.js <工具名> [JSON参数] [--dry-run]');
  let args = rawArgs ? JSON.parse(rawArgs) : {};
  if (dryRun) {
    if (!['minimax_agent', 'minimax_send_message'].includes(tool) || (args?.action && args.action !== 'send')) {
      throw new Error('--dry-run 仅用于原生 Agent 的 send 动作');
    }
    args = { ...args, action: 'send', preview: true, send: false };
  }

  const client = await connect({ timeoutMs: 310000 });
  try {
    const result = await client.call(tool, args);
    const output = result.content.map((item) => item.text || '').join('\n');
    if (result.isError) throw new Error(output);
    console.log(output);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
