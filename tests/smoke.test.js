'use strict';

const assert = require('node:assert/strict');
const { connect } = require('../scripts/stdio-client');
const contracts = require('../skills/minimax-mcp/references/mcp-tool-contracts.json');
const examples = require('../skills/minimax-mcp/references/mcp-call-examples.json');
const manifest = require('../glama.json');

async function main() {
  const client = await connect({ clientName: 'minimax-live-smoke', timeoutMs: 25000 });
  let passed = 0;
  let cdpOnline = false;
  async function call(name, args, errorPattern = null) {
    const result = await client.call(name, args);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(result.isError, Boolean(errorPattern), payload.error);
    if (errorPattern) assert.match(payload.error, errorPattern);
    return payload;
  }
  function check(label, fn) {
    return Promise.resolve().then(fn).then(() => {
      passed += 1;
      console.log('[OK] ' + label);
    });
  }

  try {
    const catalog = await client.request('tools/list');
    const tools = new Map(catalog.tools.map((tool) => [tool.name, tool]));
    await check('initialize → tools/list 与文档契约一致', () => {
      assert.equal(client.init.protocolVersion, '2025-06-18');
      assert.equal(tools.size, manifest.tools);
      assert.deepEqual([...tools.keys()], contracts.tools.map((tool) => tool.name));
      for (const { name, input } of contracts.tools) {
        const tool = tools.get(name);
        assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), Object.keys(input).sort(), name);
      }
      for (const req of examples.examples.flatMap((example) => example.calls)) {
        const tool = tools.get(req.params.name);
        assert.ok(tool, req.params.name);
        for (const key of Object.keys(req.params.arguments)) assert.ok(Object.hasOwn(tool.inputSchema.properties, key), key);
        if (req.params.arguments.action) assert.ok(tool.inputSchema.properties.action.enum.includes(req.params.arguments.action));
      }
    });
    await check('状态、额度和待办摘要可读', async () => {
      const status = await call('minimax_status');
      assert.equal(status.dbFound, true);
      assert.equal(typeof status.app.running, 'boolean');
      assert.equal(typeof status.cdp.online, 'boolean');
      cdpOnline = status.cdp.online;
      assert.equal(typeof status.attention.pendingQuestions, 'number');
      if (status.cdp.online) assert.equal(typeof status.quota?.isLimited, 'boolean');
      assert.equal((await call('minimax_status', { includeBrief: false })).attention, undefined);
    });
    const list = (await call('minimax_session', { limit: 3 })).sessions;
    const sid = list.find((session) => session.messages > 2)?.sessionId || list[0]?.sessionId;
    assert.ok(sid, '需要一个现有 MiniMax 会话验证历史');
    await check('读取历史、翻页、按序号查询', async () => {
      const page = await call('minimax_session', { sessionId: sid, limit: 1 });
      assert.equal(page.sessionId, sid);
      assert.equal(page.returned, 1);
      if (page.hasMore) {
        const previous = await call('minimax_session', { sessionId: sid, limit: 1, before: page.oldestId });
        assert.equal(previous.returned, 1);
        assert.ok(previous.oldestId < page.oldestId);
      }
      const last = await call('minimax_session', { sessionId: '1', limit: 1 });
      assert.ok(last.messages.length);
      const legacy = await call('minimax_read_session', { session: sid, limit: 1 });
      assert.equal(legacy.sessionId, sid);
      await call('minimax_session', { sessionId: sid, session: 'another-session', limit: 1 }, /sessionId.*session.*冲突/);
    });
    await check('统一列表支持采样，旧 tail 仍兼容', async () => {
      const current = await call('minimax_session', { limit: 2, perSession: 1 });
      const legacy = await call('minimax_session', { action: 'tail', count: 2, perSession: 1 });
      const alias = await call('minimax_tail_sessions', { count: 2, perSession: 1 });
      for (const { sessions } of [current, legacy, alias]) {
        assert.ok(sessions.length > 0 && sessions.length <= 2);
        assert.ok(sessions.every((session) => session.latest.length === 1));
      }
      await call('minimax_session', { limit: 21, perSession: 1 }, /20/);
    });
    await check('搜索标题和正文，错误给出修正方式', async () => {
      const { hits } = await call('minimax_session', { query: 'MiniMax', limit: 4 });
      assert.ok(Array.isArray(hits) && hits.length <= 4);
      assert.ok(hits.every((hit) => hit.sessionId && ['session', 'message'].includes(hit.kind)));
      await call('minimax_session', { action: 'search', query: '  ' }, /搜索关键词/);
      await call('minimax_session', { sessionId: '%', limit: 1 }, /完整 sessionId/);
      await call('minimax_session', { limit: '5' }, /integer/);
      await call('minimax_session', { action: null }, /action/);
      await call('minimax_session', JSON.parse('{"__proto__":{"limit":1}}'), /不是这个工具支持/);
    });
    await check('查询指定轮次，拒绝未知会话', async () => {
      const result = await call('minimax_agent', { sessionId: sid });
      assert.equal(result.sessionId, sid);
      assert.equal(typeof result.done, 'boolean');
      await call('minimax_agent', { action: 'result', sessionId: 'mvs_missing_mcp_smoke' }, /找不到会话/);
    });
    await check('发送预览检查目标且保持当前会话', async () => {
      const snapshot = await call('minimax_agent', { message: 'MCP smoke preview', preview: true });
      const preview = await call('minimax_agent', { sessionId: sid, message: 'MCP smoke preview', send: true, preview: true });
      const newTask = await call('minimax_agent', { message: 'MCP smoke preview', newSession: true, preview: true });
      assert.equal(preview.preview, true);
      assert.equal(preview.wouldSend, true);
      assert.equal(preview.targetSessionId, sid);
      assert.equal(typeof preview.guard.wouldBlock, 'boolean');
      assert.equal(newTask.newSession, true);
      const after = await call('minimax_agent', { message: 'MCP smoke preview', preview: true });
      assert.equal(after.activeSessionId, snapshot.activeSessionId);
      assert.equal(after.newTaskOpen, snapshot.newTaskOpen);
      if (cdpOnline) {
        assert.equal(snapshot.via, 'cdp');
        assert.equal(typeof snapshot.windowFocused, 'boolean');
        assert.equal(typeof snapshot.composerReady, 'boolean');
        assert.equal(typeof snapshot.newTaskOpen, 'boolean');
      }
      await call('minimax_agent', { sessionId: sid, message: 'MCP smoke preview', newSession: true, preview: true }, /互斥/);
      await call('minimax_agent', { action: 'stop', sessionId: 'mvs_missing_mcp_smoke', preview: true }, /preview|找不到会话/);
      await call('minimax_send_message', { message: 'MCP smoke preview', at: 'bad', preview: true }, /坐标/);
    });
    await check('读取 Bot 名册与历史，缺少写入目标时返回错误', async () => {
      const roster = await call('minimax_bot');
      assert.ok(Array.isArray(roster.groups) && Array.isArray(roster.bots));
      const bot = roster.bots[0] || roster.groups[0];
      assert.ok(bot, '需要一个 Bot 或群聊验证历史');
      const history = await call('minimax_bot', { target: bot.name, limit: 2 });
      assert.equal(history.target.chatId, bot.chatId);
      assert.ok(Array.isArray(history.messages));
      assert.ok(['live', 'disk'].includes(history.source));
      console.log('  Bot 历史数据源 ' + history.source + '，返回 ' + history.messages.length + ' 条');
      await call('minimax_bot', { text: 'MCP smoke guard' }, /target/);
      await call('minimax_bot', { target: 'bot:../../wrong' }, /无效的 Bot chatId/);
      await call('minimax_bot', {
        action: 'answer', target: bot.chatId, messageId: 'msg_missing',
        answers: [{ stepId: 'step', selectedOptionIds: 'invalid' }],
      }, /selectedOptionIds/);
    });
    await check('读取问卷待办与预览', async () => {
      const { pending } = await call('minimax_questionnaire');
      assert.ok(Array.isArray(pending));
      if (pending[0]) {
        const preview = await call('minimax_questionnaire', { requestId: pending[0].requestId });
        assert.equal(preview.preview, true);
        assert.ok(preview.suggestion);
      } else {
        console.log('  当前没有待答问卷，隔离用例覆盖拟答与提交');
      }
      await call('minimax_questionnaire', { requestId: 'ask_missing_mcp_smoke' }, /找不到提问/);
    });
    await check('未知工具返回 JSON-RPC 错误', async () => {
      await assert.rejects(client.call('minimax_auto_resume'), { code: -32602 });
    });
    console.log(passed + ' 组真机 MCP 检查通过');
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
