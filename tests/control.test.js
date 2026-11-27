'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { connect } = require('../scripts/stdio-client');

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-mcp-stdio-'));
const fixturePath = path.join(folder, 'runtime.sqlite');

async function checkBotTransport() {
  const chatId = 'bot:bot_test';
  const received = [];
  const earlyCancellation = {
    id: 'msg_earlycancel', chatId, role: 'bot', status: 'error', errorCode: 'REQUEST_CANCELLED',
    error: '已取消', retryable: true, retryInput: 'Will not run',
  };
  const otherOutcomes = [
    { id: 'msg_unknown', chatId, role: 'bot', status: 'error', errorCode: 'AGENT_OUTCOME_UNKNOWN' },
    { id: 'msg_failure', chatId, role: 'bot', status: 'error', errorCode: 'BUSY', error: '已取消' },
    { ...earlyCancellation, id: 'msg_latercancel', sessionId: 'mvs_started' },
    { id: 'msg_aborted', chatId, role: 'bot', status: 'aborted', sessionId: 'mvs_started' },
  ];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    received.push([req.method, req.url, body]);
    const messages = `/api/chats/${chatId}/messages`;
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/state') return res.end(JSON.stringify({ bots: [] }));
    if (req.method === 'GET' && req.url === `${messages}?limit=2`) {
      return res.end(JSON.stringify({ chatId, messages: [] }));
    }
    if (req.method === 'GET' && req.url === `${messages}?limit=5`) {
      return res.end(JSON.stringify({ chatId, messages: [earlyCancellation, ...otherOutcomes] }));
    }
    if (req.method === 'POST' && req.url === messages) {
      if (body.text === 'Ambiguous transport result') {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: 'internal' }));
      }
      return res.end(JSON.stringify({
        message: { chatId, id: 'msg_test', role: 'user', text: body.text, clientMessageId: body.clientMessageId },
      }));
    }
    if (req.method === 'POST' && req.url === `${messages}/msg_card/answer`) {
      return res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(404);
    return res.end(JSON.stringify({ message: 'Unknown route' }));
  });
  let client;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    client = await connect({
      clientName: 'minimax-bot-gateway-fixture',
      env: { ...process.env, MINIMAX_MCP_HOME: folder, MINIMAX_BOT_GATEWAY: `http://127.0.0.1:${server.address().port}` },
    });
    async function call(args, expectedError = null) {
      const result = await client.call('minimax_bot', args);
      const payload = JSON.parse(result.content[0].text);
      assert.equal(result.isError, Boolean(expectedError), payload.error);
      if (expectedError) assert.match(payload.error, expectedError);
      return payload;
    }
    assert.equal((await call({ action: 'open' })).source, 'live');
    assert.equal((await call({ target: chatId, limit: 2 })).source, 'live');
    await call({ target: 'bot:unknown', limit: 2 }, /HTTP 404/);

    const history = await call({ target: chatId, limit: 5 });
    assert.equal(history.source, 'live');
    const [cancelled, ...unchanged] = history.messages;
    assert.deepEqual(cancelled, {
      id: earlyCancellation.id, chatId, role: 'bot', status: 'aborted',
      cancellation: { phase: 'before-admission', code: 'REQUEST_CANCELLED', pluginStatus: 'error' },
    });
    assert.deepEqual(unchanged, otherOutcomes);
    console.log('[OK] Bot 宿主接收前确认取消，保留失败、结果未知与已接收轮次的原始状态');

    const sent = await call({ target: chatId, text: 'Fixture Bot', clientMessageId: 'fixture-send' });
    assert.equal(sent.verified, true);
    assert.equal(sent.messageId, 'msg_test');
    const uncertain = await call({ target: chatId, text: 'Ambiguous transport result', clientMessageId: 'fixture-ambiguous' });
    assert.equal(uncertain.sent, null);
    assert.equal(uncertain.verified, false);
    assert.equal(uncertain.clientMessageId, 'fixture-ambiguous');
    assert.equal(received.filter(([, , body]) => body?.clientMessageId === 'fixture-ambiguous').length, 1);

    const card = { action: 'answer', target: chatId, messageId: 'msg_card' };
    assert.equal((await call({ ...card, answers: { step1: 'yes' } })).accepted, true);
    assert.deepEqual(received.at(-1), ['POST', '/api/chats/bot:bot_test/messages/msg_card/answer', {
      answers: [{ stepId: 'step1', selectedOptionIds: ['yes'], selectedOther: false }],
    }]);
    console.log('[OK] Bot 实时路由、发送回执、未知结果不重发及旧卡片格式');
  } finally {
    client?.close();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}

function seed() {
  const db = new DatabaseSync(fixturePath);
  db.exec([
    'create table local_runtime_sessions(session_id text primary key, title text, status text, error_message text, updated_at_ms integer, archived integer);',
    'create table local_runtime_message_rows(id integer primary key, session_id text, role text, created_at_ms integer, data_json text, turn_id text);',
    'create table local_runtime_turn_ingress(turn_id text primary key, session_id text, status text, accepted_sequence integer, completed_at_ms integer);',
    'create table local_runtime_session_locks(session_id text primary key, owner_kind text, expires_at_ms integer);',
    'create table questionnaire_requests(request_id text primary key, session_id text, agent_name text, status text, created_at integer, request_json text, reply_payload text);',
    'create table local_runtime_queue_pauses(session_id text, cause text);',
    'create table local_runtime_queue_items(session_id text, status text);',
    'create table local_runtime_background_tasks(owner_session_id text, status text, ended_at_ms integer, record_json text);',
    "insert into local_runtime_sessions values ('mvs_test_target', 'Target', 'idle', null, 10, 0), ('mvs_test_other', 'Other', 'idle', null, 1, 0), ('mvs_test_wait', 'Wait', 'started', null, 1, 0), ('mvs_test_focus_lost', 'Focus', 'idle', null, 1, 0);",
    "insert into local_runtime_sessions values ('mvs_test_aborted', 'Aborted', 'aborted', null, 10, 0);",
  ].join('\n'));
  const insert = db.prepare('insert into local_runtime_message_rows(session_id,role,created_at_ms,data_json) values (?,?,?,?)');
  insert.run('mvs_test_target', 'user', 10, JSON.stringify({ msg_content: 'Earlier message' }));
  insert.run('mvs_test_other', 'user', 1, JSON.stringify({ msg_content: 'Other session' }));
  insert.run('mvs_test_wait', 'assistant', 1, JSON.stringify({ msg_content: 'Same reply before idle' }));
  insert.run('mvs_test_aborted', 'user', 10, JSON.stringify({ msg_content: 'The user stopped this turn' }));
  db.prepare('insert into local_runtime_sessions values (?, ?, ?, ?, ?, ?)').run(
    'mvs_test_recent', 'Recent session', 'idle', null, Date.now(), 0,
  );
  const question = { title: 'Continue?', steps: [
    { id: 'step', selectionMode: 'single', options: [
      { id: 'yes', label: 'Continue', recommended: true },
      { id: 'no', label: 'Stop' },
    ] },
  ] };
  db.prepare('insert into questionnaire_requests values (?,?,?,?,?,?,null)').run(
    'ask_test', 'mvs_test_target', 'fixture', 'pending', 1, JSON.stringify(question)
  );
  db.close();
}

async function main() {
  seed();
  const preload = path.join(folder, 'preload.cjs');
  const journal = path.join(folder, 'actions.jsonl');
  fs.writeFileSync(preload, [
    "'use strict';",
    "const { DatabaseSync } = require('node:sqlite');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const root = process.env.MINIMAX_TEST_ROOT;",
    "const gui = require(path.join(root, 'src/gateway/gui'));",
    "const { cdp } = require(path.join(root, 'src/gateway/cdp'));",
    "const db = new DatabaseSync(process.env.MINIMAX_DB_PATH);",
    "const record = (action) => fs.appendFileSync(process.env.MINIMAX_TEST_JOURNAL, JSON.stringify(action) + '\\n');",
    "const update = db.prepare('update local_runtime_sessions set status = ? where session_id = ?');",
    "const insert = db.prepare('insert into local_runtime_message_rows(session_id,role,created_at_ms,data_json,turn_id) values (?,?,?,?,?)');",
    "const message = (sid, text, role = 'user', turnId = null) => insert.run(sid, role, Date.now(), JSON.stringify({ msg_content: text }), turnId);",
    "let current = 'mvs_test_other';",
    "let draft = '';",
    "let isHome = false;",
    "let waiting = false;",
    "let appActive = false;",
    "let windowFocused = false;",
    "let changeOnPaste = false;",
    "const note = (type, ...values) => record([type, ...values]);",
    "gui.activeApp = () => ({ app: appActive ? gui.APP : 'background' });",
    "gui.openApp = () => { note('activate'); appActive = true; };",
    "gui.mainWindow = () => ({ x: 0, y: 0, width: 800, height: 600 });",
    "gui.topmostAt = () => ({ app: gui.APP });",
    "gui.sleep = () => {};",
    "gui.click = () => note('guiClick');",
    "gui.clipboard = (text) => { draft = text; };",
    "gui.pressKey = (key) => {",
    "  note('guiKey', key);",
    "  if (key === 'v' && changeOnPaste) current = 'mvs_test_other';",
    "  if (key === 'return') message('mvs_test_other', draft);",
    "};",
    "cdp.isAvailable = async () => true;",
    "cdp.bringToFront = async () => { windowFocused = appActive; return { ok: true }; };",
    "cdp.controlContext = async (sessionId) => ({",
    "  activeSessionId: current, newTaskOpen: isHome, targetAvailable: Boolean(sessionId), composerReady: true, windowFocused,",
    "});",
    "cdp.switchSession = async (sid) => {",
    "  note('switch', sid); current = sid; isHome = false;",
    "  windowFocused = sid !== 'mvs_test_focus_lost';",
    "  return { ok: true };",
    "};",
    "cdp.newTask = async () => { note('new'); current = null; isHome = true; return { ok: true }; };",
    "cdp.stopGeneration = async ({ sessionId, turnId }) => {",
    "  note('stop', sessionId, turnId);",
    "  const status = turnId === 'turn-finished-first' ? 'completed' : 'aborted';",
    "  db.prepare('update local_runtime_turn_ingress set status = ?, completed_at_ms = ? where session_id = ? and turn_id = ?').run(status, Date.now(), sessionId, turnId);",
    "  db.prepare('delete from local_runtime_session_locks where session_id = ?').run(sessionId);",
    "  update.run(status === 'aborted' ? status : 'idle', sessionId);",
    "  return { ok: true };",
    "};",
    "cdp.typeMessage = async (text) => { note('type', text); draft = text; return { ok: true, currentText: text }; };",
    "cdp.sendMessage = async (text, target) => {",
    "  note('send', text, target.sessionId);",
    "  if (draft !== text) return { ok: false, error: 'mismatched draft' };",
    "  if (text === 'MCP switch on next paste') changeOnPaste = true;",
    "  if (text === 'MCP isolated unconfirmed') { message('mvs_test_other', text); return { ok: true }; }",
    "  const sid = target.sessionId || 'mvs_test_new';",
    "  if (text.startsWith('MCP stop test ')) {",
    "    const turnId = text.endsWith('race') ? 'turn-finished-first' : 'turn-to-stop';",
    "    const { lastInsertRowid } = message(sid, text, 'user', turnId);",
    "    db.prepare('insert into local_runtime_turn_ingress values (?,?,?,?,null)').run(turnId, sid, 'accepted', lastInsertRowid);",
    "    db.prepare('insert into local_runtime_session_locks values (?,?,?)').run(sid, 'turn', Date.now() + 60000);",
    "    update.run('started', sid);",
    "    return { ok: true };",
    "  }",
    "  message(sid, text);",
    "  message('mvs_test_other', 'Interleaved user message');",
    "  message(sid, 'MCP isolated reply', 'assistant');",
    "  update.run('idle', sid);",
    "  return { ok: true };",
    "};",
    "cdp.answerQuestion = async (requestId, steps) => {",
    "  note('answer', requestId);",
    "  const answers = steps.filter(({ answer }) => answer).map(({ stepId, answer }) => ({",
    "    stepId, selectedOptionIds: answer.optionIds, selectedOther: false,",
    "  }));",
    "  db.prepare('update questionnaire_requests set status = ?, reply_payload = ? where request_id = ?').run(",
    "    'answered', JSON.stringify({ answers }), requestId",
    "  );",
    "  return { ok: true };",
    "};",
    "const dbGateway = require(path.join(root, 'src/gateway/db'));",
    "const originalQuery = dbGateway.waitForResult;",
    "dbGateway.waitForResult = (...args) => {",
    "  if (args[0] === 'mvs_test_wait' && !waiting) {",
    "    waiting = true;",
    "    setTimeout(() => update.run('idle', 'mvs_test_wait'), 200);",
    "  }",
    "  return originalQuery(...args);",
    "};",
  ].join('\n'));
  const clientOptions = {
    clientName: 'minimax-isolated-workflow',
    timeoutMs: 20000,
    nodeArgs: ['--require', preload],
    env: {
      ...process.env,
      MINIMAX_DB_PATH: fixturePath,
      MINIMAX_MCP_HOME: folder,
      MINIMAX_TEST_ROOT: path.join(__dirname, '..'),
      MINIMAX_TEST_JOURNAL: journal,
    },
  };
  const client = await connect({ ...clientOptions, capabilities: { tasks: {} } });
  const actions = () => fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8').trim().split('\n').map(JSON.parse) : [];
  async function call(name, args, expectedError = null) {
    const result = await client.call(name, args);
    const data = JSON.parse(result.content[0].text);
    assert.equal(result.isError, Boolean(expectedError), data.error);
    if (expectedError) assert.match(data.error, expectedError);
    return data;
  }

  try {
    const extension = 'io.modelcontextprotocol/tasks';
    assert.equal(client.init.capabilities.tasks, undefined);
    assert.equal(client.init.capabilities.experimental?.[extension], undefined);
    await assert.rejects(client.request('tasks/list'), { code: -32601 });
    const legacyClient = await connect({
      ...clientOptions,
      capabilities: { experimental: { [extension]: {} } },
    });
    try {
      assert.equal(legacyClient.init.capabilities.tasks, undefined);
      assert.deepEqual(legacyClient.init.capabilities.experimental[extension], {});
      assert.deepEqual(await legacyClient.request('tasks/list'), { tasks: [] });
      const activation = await legacyClient.call('minimax_desktop', { action: 'activate' });
      assert.equal(JSON.parse(activation.content[0].text).activated, true);
      const receipt = await legacyClient.call('minimax_agent', {
        sessionId: 'mvs_test_other', message: 'MCP legacy Tasks', send: true, force: true,
      });
      assert.equal(receipt.isError, false);
      const { taskId } = JSON.parse(receipt.content[0].text);
      assert.ok(taskId);
      const task = await legacyClient.request('tasks/get', { taskId });
      assert.equal(task.status, 'working');
      assert.equal((await legacyClient.request('tasks/cancel', { taskId })).status, 'canceled');
    } finally {
      legacyClient.close();
    }
    console.log('[OK] 标准 Tasks 不误宣告，显式旧扩展可查询和取消');

    const inactive = await call('minimax_agent', { message: 'Activation probe', preview: true });
    assert.equal(inactive.windowFocused, false);
    await call('minimax_agent', { action: 'new' }, /action:"activate"/);
    const activation = await call('minimax_agent', { action: 'activate' });
    assert.equal(activation.activated, true);
    const active = await call('minimax_agent', { message: 'Activation probe', preview: true });
    assert.equal(active.windowFocused, true);
    assert.equal(actions().filter(([action]) => action === 'activate').length, 2);
    console.log('[OK] 激活先切到 macOS 前台，再核对 MiniMax 窗口焦点');

    const target = 'mvs_test_target';
    const text = 'MCP isolated round trip';
    const options = { sessionId: target, message: text, force: true };
    const previousActions = actions().length;
    const preview = await call('minimax_agent', { ...options, send: true, preview: true });
    assert.equal(preview.activeSessionId, 'mvs_test_other');
    assert.equal(preview.targetSessionId, target);
    await call('minimax_agent', { ...options, sessionId: 'mvs_test_', send: true }, /不唯一/);
    await call('minimax_agent', { ...options, text: 'Different message', send: true }, /message.*text.*冲突/);
    await call('minimax_agent', { action: 'stop', sessionId: target }, /没有可停止的轮次/);
    assert.equal(actions().length, previousActions);
    console.log('[OK] 预览、歧义目标与空闲会话停止均无写入');

    const draft = await call('minimax_agent', options);
    assert.equal(draft.sent, false);
    assert.deepEqual(actions().slice(previousActions).map(([action]) => action), ['switch', 'type']);
    const sent = await call('minimax_agent', { ...options, send: true });
    assert.equal(sent.sent, true);
    assert.equal(sent.verified, true);
    assert.equal(sent.taskId, undefined);
    assert.equal(sent.sessionId, target);
    assert.ok(sent.messageId > 3);
    const reply = await call('minimax_agent', { sessionId: target, afterMessageId: sent.messageId });
    assert.equal(reply.done, true);
    assert.equal(reply.result, 'MCP isolated reply');
    const page = await call('minimax_session', { sessionId: target, limit: 3 });
    assert.equal(page.hasMore, false);
    assert.equal(page.returned, 3);
    console.log('[OK] 草稿、发送、入库、结果和最后一页');

    const second = await call('minimax_agent', { ...options, message: 'MCP isolated second turn', send: true });
    assert.ok(second.messageId > sent.messageId);
    const firstTurn = await call('minimax_agent', { sessionId: target, afterMessageId: sent.messageId });
    assert.equal(firstTurn.lastAssistantMessageId, reply.lastAssistantMessageId);
    assert.equal(firstTurn.done, true);
    console.log('[OK] 下一轮开始后仍返回原发送对应的回复');

    const running = await call('minimax_agent', { ...options, message: 'MCP stop test exact', send: true });
    const stopsBefore = actions().filter(([action]) => action === 'stop').length;
    await call('minimax_agent', { action: 'stop', sessionId: target, afterMessageId: second.messageId }, /不属于目标会话的原生轮次/);
    await call('minimax_agent', { action: 'stop', sessionId: 'mvs_test_other', afterMessageId: running.messageId }, /不属于目标会话/);
    assert.equal(actions().filter(([action]) => action === 'stop').length, stopsBefore);
    const stopped = await call('minimax_agent', { action: 'stop', sessionId: target, afterMessageId: running.messageId });
    assert.deepEqual(actions().at(-1), ['stop', target, 'turn-to-stop']);
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.verified, true);
    const race = await call('minimax_agent', { ...options, message: 'MCP stop test race', send: true });
    await call('minimax_agent', { action: 'stop', sessionId: target, afterMessageId: running.messageId }, /已不在运行.*aborted/);
    const raced = await call('minimax_agent', { action: 'stop', sessionId: target, afterMessageId: race.messageId });
    assert.equal(raced.stopped, false);
    assert.equal(raced.turnStatus, 'completed');
    const afterStop = await call('minimax_agent', { sessionId: target, afterMessageId: running.messageId, timeoutSeconds: 5 });
    assert.equal(afterStop.status, 'aborted');
    assert.equal(afterStop.done, false);
    assert.equal(afterStop.waitedSeconds, 0);
    console.log('[OK] 旧轮次和其他会话不会停止新轮次，自然结束不会报成取消');

    const newTask = await call('minimax_agent', { action: 'new' });
    assert.equal(newTask.opened, true);
    const newSession = await call('minimax_agent', { message: 'MCP new session', newSession: true, send: true, force: true });
    assert.equal(newSession.sessionId, 'mvs_test_new');
    assert.equal(newSession.verified, true);
    console.log('[OK] 新任务页与新会话首条消息');

    const waiting = await call('minimax_agent', { sessionId: 'mvs_test_wait', timeoutSeconds: 1 });
    assert.equal(waiting.done, true);
    assert.equal(waiting.result, 'Same reply before idle');
    console.log('[OK] 回复早于 idle 入库也能返回完整轮次');

    const qn = await call('minimax_questionnaire', { requestId: 'ask_test' });
    assert.equal(qn.preview, true);
    assert.equal(qn.wouldSubmit.answers[0].selectedOptionIds[0], 'yes');
    const legacy = await call('minimax_draft_answer', { id: 'ask_test', preview: false, force: true });
    assert.equal(legacy.preview, true);
    await call('minimax_questionnaire', { requestId: 'ask_test', preview: false }, /force:true/);
    await call('minimax_questionnaire', {
      requestId: 'ask_test', preview: false, force: true, selections: [],
    }, /缺少必答步骤/);
    assert.equal(actions().filter(([action]) => action === 'answer').length, 0);
    const answer = await call('minimax_questionnaire', {
      requestId: 'ask_test', preview: false, force: true,
      selections: [{ stepId: 'step', selectedOptionIds: ['no'] }],
    });
    assert.equal(answer.verified, true);
    assert.equal(answer.status, 'answered');
    assert.equal((await call('minimax_questionnaire', { requestId: 'ask_test' })).answered.answers[0].selectedOptionIds[0], 'no');
    console.log('[OK] 问卷拟答、兼容字段、提交确认与实际选项核对');

    const uncertain = await call('minimax_agent', { ...options, message: 'MCP isolated unconfirmed', send: true });
    assert.equal(uncertain.sent, null);
    assert.equal(uncertain.verified, false);
    assert.equal(actions().filter(([action, message]) => action === 'send' && message === 'MCP isolated unconfirmed').length, 1);
    assert.equal(actions().some(([action]) => action.startsWith('gui')), false);
    console.log('[OK] 相同正文出现在其他会话时返回未确认，且只提交一次');

    const coordinateWrite = await call('minimax_send_message', {
      message: 'MCP isolated coordinate send', at: '20,30', send: true, force: true,
    });
    assert.equal(coordinateWrite.sessionId, target);
    assert.equal(coordinateWrite.sent, null);
    assert.equal(coordinateWrite.verified, false);
    await call('minimax_agent', { ...options, message: 'MCP switch on next paste', send: true });
    await call('minimax_send_message', {
      message: 'MCP switched coordinate send', at: '20,30', send: true, force: true,
    }, /会话|窗口/);
    assert.equal(actions().filter(([action, key]) => action === 'guiKey' && key === 'return').length, 1);
    console.log('[OK] 旧坐标发送按会话核对，粘贴后切换会话时取消发送');

    await call('minimax_agent', { ...options, sessionId: 'mvs_test_focus_lost', send: true }, /焦点|前台/);
    assert.equal(actions().at(-1)[0], 'switch');
    console.log('[OK] 等待目标会话时失焦后停止写入');

    const beforeWatch = actions().length;
    const brief = await call('minimax_brief', {});
    assert.ok(brief.items.every((item) => item.sessionId !== 'mvs_test_aborted'));
    const fixture = new DatabaseSync(fixturePath);
    fixture.prepare('update local_runtime_message_rows set role = ? where session_id = ?').run('user', 'mvs_test_wait');
    fixture.close();
    const nudge = await call('minimax_watch', {
      action: 'tick',
      policy: { mode: 'act', minIdleSeconds: 0, maxActionsPerTick: 1, allowSessions: ['mvs_test_wait'] },
    });
    assert.equal(nudge.actions[0]?.ok, false);
    assert.ok(nudge.needsHuman.some((entry) => entry.sessionId === 'mvs_test_wait' && entry.reason.includes('近期有会话活动')));
    assert.equal(actions().length, beforeWatch);
    console.log('[OK] 后台巡检保留活跃守卫，近期活动时不催促');
  } finally {
    client.close();
  }
  await checkBotTransport();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => fs.rmSync(folder, { recursive: true, force: true }));
