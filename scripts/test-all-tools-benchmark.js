'use strict';

const { performance } = require('node:perf_hooks');
const { connect } = require('./stdio-client');

async function main() {
  const client = await connect({ clientName: 'minimax-benchmark' });
  const measurements = [];
  try {
    const catalog = await client.request('tools/list');
    async function measure(label, name, args) {
      const started = performance.now();
      const result = await client.call(name, args);
      const text = result.content[0].text;
      if (result.isError) throw new Error(label + ' failed: ' + text);
      measurements.push({ call: label, ms: Math.round(performance.now() - started), bytes: Buffer.byteLength(text) });
      return JSON.parse(text);
    }
    await measure('status', 'minimax_status');
    const { sessions } = await measure('session.list', 'minimax_session', { limit: 3 });
    await measure('session.list + samples', 'minimax_session', { limit: 3, perSession: 1 });
    await measure('session.search', 'minimax_session', { query: 'MiniMax', limit: 3 });
    if (sessions[0]) {
      const { sessionId } = sessions[0];
      await measure('session.read', 'minimax_session', { sessionId, limit: 3 });
      await measure('agent.result', 'minimax_agent', { sessionId });
      await measure('agent.preview', 'minimax_agent', { sessionId, message: 'MCP benchmark preview', preview: true });
    }
    const roster = await measure('bot.roster', 'minimax_bot');
    const target = roster.bots[0]?.chatId || roster.groups[0]?.chatId;
    if (target) await measure('bot.read', 'minimax_bot', { target, limit: 3 });
    const { pending } = await measure('questionnaire.list', 'minimax_questionnaire');
    if (pending[0]) await measure('questionnaire.preview', 'minimax_questionnaire', { requestId: pending[0].requestId });
    console.log('tools/list ' + catalog.tools.length + ' tools, ' + Buffer.byteLength(JSON.stringify(catalog.tools)) + ' bytes');
    console.table(measurements);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
