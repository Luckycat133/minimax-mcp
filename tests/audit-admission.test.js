'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const test = require('node:test');
const { connect } = require('../scripts/stdio-client');

const CHAT_ID = 'bot:audit_fixture';
const TEXT = 'synthetic text for admission testing';
const MESSAGE_ID = 'synthetic-id';

async function fixture(t, respondToSend) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-admission-'));
  const auditDir = path.join(home, 'audit');
  const auditFile = path.join(auditDir, 'audit.jsonl');
  const journal = path.join(home, 'driver.log');
  const preload = path.join(home, 'driver.cjs');
  const root = path.join(__dirname, '..');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const path = require('node:path');
    const local = name => require(path.join(process.env.FIXTURE_ROOT, 'src/gateway', name));
    const record = action => fs.appendFileSync(process.env.FIXTURE_JOURNAL, action + '\\n');
    const agent = local('agent');
    agent.send = args => {
      record(args.preview ? 'preview' : 'send');
      return { preview: args.preview, wouldSend: args.send };
    };
    agent.stop = args => {
      record('stop');
      return { stopped: true, sessionId: args.sessionId, turnStatus: 'aborted' };
    };
    const questions = local('questions');
    questions.submit = () => { record('answer'); return { verified: true }; };
  `);
  const requests = [];
  let serverError;
  const server = http.createServer(async (req, res) => {
    requests.push(req.method);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') {
      res.end(JSON.stringify({ chatId: CHAT_ID, messages: [] }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      await respondToSend?.({ auditFile, body: JSON.parse(raw) });
    } catch (error) {
      serverError = error;
      res.writeHead(500).end('{}');
      return;
    }
    res.end(JSON.stringify({ message: { chatId: CHAT_ID, id: 'msg_fixture', role: 'user', text: TEXT, clientMessageId: MESSAGE_ID } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const client = await connect({
    clientName: 'minimax-audit-admission-fixture',
    nodeArgs: ['--require', preload],
    env: {
      PATH: process.env.PATH, HOME: home, MINIMAX_MCP_HOME: auditDir,
      MINIMAX_DB_PATH: path.join(home, 'unused.sqlite'),
      MINIMAX_BOT_GATEWAY: `http://127.0.0.1:${server.address().port}`,
      FIXTURE_ROOT: root, FIXTURE_JOURNAL: journal,
    },
  });
  t.after(() => client.close());
  async function call(name, args) {
    const result = await client.call(name, args);
    if (serverError) throw serverError;
    return { isError: result.isError, payload: JSON.parse(result.content[0].text) };
  }
  return { home, auditDir, auditFile, journal, requests, call };
}

test('commit commands fail before transport or a desktop action when audit cannot be written', async (t) => {
  const { home, auditDir, auditFile, journal, requests, call } = await fixture(t);
  const blocked = async (tool, args) => {
    const result = await call(tool, args);
    assert.equal(requests.includes('POST'), false, 'rejected commit reached the loopback transport');
    assert.equal(result.isError, true);
    assert.equal(result.payload.code, 'AUDIT_UNAVAILABLE');
    assert.equal(result.payload.executed, false);
  };
  fs.writeFileSync(auditDir, 'fixture file in place of directory');
  await blocked('minimax_bot', { target: CHAT_ID, text: TEXT, clientMessageId: MESSAGE_ID });
  await blocked('minimax_agent', { message: TEXT, send: true, force: true });
  await blocked('minimax_questionnaire', { requestId: 'ask_fixture', preview: false, force: true });
  assert.deepEqual(requests, []);
  assert.equal(fs.existsSync(journal), false);

  fs.unlinkSync(auditDir);
  fs.mkdirSync(auditDir);
  const target = path.join(home, 'untouched');
  fs.writeFileSync(target, 'sentinel');
  fs.symlinkSync(target, auditFile);
  await blocked('minimax_bot_message', { target: CHAT_ID, text: TEXT });
  const history = await call('minimax_bot', { target: CHAT_ID });
  assert.equal(history.isError, false);
  assert.equal(history.payload.source, 'live');
  const preview = await call('minimax_agent', { message: TEXT, send: true, preview: true });
  assert.equal(preview.isError, false);
  assert.equal(preview.payload.preview, true);
  const stop = await call('minimax_agent', { sessionId: 'mvs_audit_fixture', action: 'stop' });
  assert.equal(stop.isError, false);
  assert.equal(stop.payload.stopped, true);
  assert.deepEqual(requests, ['GET']);
  assert.equal(fs.readFileSync(journal, 'utf8'), 'preview\nstop\n');
  assert.equal(fs.readFileSync(target, 'utf8'), 'sentinel');
});

test('a committed send preserves its receipt if writing the outcome fails', async (t) => {
  let admission;
  const { call, requests } = await fixture(t, ({ auditFile, body }) => {
    const raw = fs.readFileSync(auditFile, 'utf8');
    assert.equal(raw.includes(TEXT) || raw.includes(CHAT_ID) || raw.includes(MESSAGE_ID), false);
    admission = JSON.parse(raw);
    assert.equal(admission.phase, 'admission');
    assert.equal(admission.ok, null);
    assert.equal(body.clientMessageId, MESSAGE_ID);
    fs.renameSync(auditFile, `${auditFile}.saved`);
    fs.mkdirSync(auditFile);
  });
  const result = await call('minimax_bot', { target: CHAT_ID, text: TEXT, clientMessageId: MESSAGE_ID });
  assert.equal(result.isError, false);
  assert.equal(result.payload.sent, true);
  assert.equal(result.payload.verified, true);
  assert.deepEqual(result.payload.audit, { state: 'outcome-unavailable', operationId: admission.operationId });
  assert.deepEqual(requests, ['POST']);
});
