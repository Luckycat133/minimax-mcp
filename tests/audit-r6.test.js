'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { connect } = require('../scripts/stdio-client');

const SECRET = 'fixture-secret-r6';
const OLD_AT = '2026-11-14T00:00:00.000Z';

function fixture(t) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-audit-r6-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const directory = path.join(scratch, 'mcp');
  const name = require.resolve('../src/gateway/audit');
  const previous = process.env.MINIMAX_MCP_HOME;
  let audit;
  try {
    process.env.MINIMAX_MCP_HOME = directory;
    delete require.cache[name];
    audit = require(name);
  } finally {
    if (previous === undefined) delete process.env.MINIMAX_MCP_HOME;
    else process.env.MINIMAX_MCP_HOME = previous;
    delete require.cache[name];
  }
  return { audit, directory, scratch };
}

const mode = (file) => fs.statSync(file).mode & 0o777;

test('writes only allowlisted metadata with private permissions', (t) => {
  const { audit, directory } = fixture(t);
  audit.record({
    tool: 'minimax_send_message', level: 'commit', ok: false, ms: 12,
    args: {
      action: 'send', mode: 'direct', send: true, preview: false,
      message: SECRET + 'x'.repeat(200), text: 'a' + SECRET + 'b', query: SECRET,
      sessionId: SECRET, token: SECRET, content: 'x'.repeat(200) + SECRET,
      selections: [{ selectedOther: true, otherText: SECRET }], [SECRET]: 1,
    },
    target: { at: { x: 7, y: -3, source: 'explicit', label: SECRET }, clicked: { x: 9, y: 2, text: SECRET }, sessionId: SECRET },
    error: SECRET,
  });

  const raw = fs.readFileSync(audit.FILE, 'utf8');
  assert.equal(raw.includes(SECRET), false);
  assert.match(raw, /"tool":"minimax_send_message"/);
  const row = JSON.parse(raw);
  assert.deepEqual(row.args, { action: 'send', mode: 'direct', send: true, preview: false });
  assert.deepEqual(row.target, { at: { x: 7, y: -3 }, clicked: [9, 2] });
  assert.equal(row.error, 'operation_error');
  assert.equal(row.ok, false);
  assert.equal(row.ms, 12);
  assert.equal(mode(directory), 0o700);
  assert.equal(mode(audit.FILE), 0o600);
});

test('a legacy recent read redacts content and malformed records without rewriting old bytes', (t) => {
  const { audit, directory } = fixture(t);
  fs.mkdirSync(directory);
  const older = JSON.stringify({ at: OLD_AT, tool: 'minimax_answer_question', level: 'commit', args: { preview: false, message: SECRET },
    target: { at: { x: 3, y: 9, label: SECRET }, clicked: SECRET, sessionId: SECRET }, error: SECRET, ms: 3 });
  const newer = JSON.stringify({ at: SECRET, tool: SECRET, level: SECRET, args: { action: SECRET, mode: SECRET }, ok: true });
  const input = `${older}\nnot-json-${SECRET}\n${newer}\n`;
  fs.writeFileSync(audit.FILE, input);

  const rows = audit.recent(3);
  assert.equal(JSON.stringify(rows).includes(SECRET), false);
  assert.deepEqual(rows[0], { at: OLD_AT, tool: 'minimax_answer_question', level: 'commit', args: { preview: false },
    ok: null, ms: 3, target: { at: { x: 3, y: 9 } }, error: 'operation_error' });
  assert.deepEqual(rows[1], { malformed: true });
  assert.deepEqual(rows[2], { at: null, tool: 'unknown', level: 'unknown', args: {}, ok: true, ms: null });
  assert.deepEqual(audit.recent(1), [rows[2]]);
  assert.equal(fs.readFileSync(audit.FILE, 'utf8'), input);
});

test('rotation keeps a single private backup and preserves the existing directory mode', (t) => {
  const { audit, directory } = fixture(t);
  fs.mkdirSync(directory, { mode: 0o755 });
  fs.chmodSync(directory, 0o755);
  fs.writeFileSync(`${audit.FILE}.1`, 'previous backup\n');
  const archived = `${'x'.repeat(2 * 1024 * 1024)}\n`;
  fs.writeFileSync(audit.FILE, archived, { mode: 0o644 });
  fs.chmodSync(audit.FILE, 0o644);

  audit.record({ tool: 'minimax_bot', level: 'commit', args: { action: 'send', text: SECRET }, ok: true });

  assert.equal(fs.readFileSync(`${audit.FILE}.1`, 'utf8'), archived);
  assert.equal(mode(`${audit.FILE}.1`), 0o600);
  assert.equal(mode(audit.FILE), 0o600);
  assert.equal(mode(directory), 0o755);
  assert.deepEqual(audit.recent().map((entry) => entry.args), [{ action: 'send' }]);
  assert.equal(fs.readFileSync(audit.FILE, 'utf8').includes(SECRET), false);
});

test('filesystem failures stay best effort and linked files are never read or written', (t) => {
  const { audit, directory, scratch } = fixture(t);
  const entry = { tool: 'minimax_bot', level: 'commit', args: { action: 'send' }, ok: true };
  fs.writeFileSync(directory, 'not a directory');
  assert.doesNotThrow(() => audit.record(entry));
  assert.deepEqual(audit.recent(), []);
  assert.equal(fs.readFileSync(directory, 'utf8'), 'not a directory');
  fs.unlinkSync(directory);
  fs.mkdirSync(directory);

  const neighbor = path.join(scratch, 'neighbor');
  fs.writeFileSync(neighbor, SECRET);
  fs.chmodSync(neighbor, 0o644);
  for (const link of [fs.symlinkSync, fs.linkSync]) {
    link(neighbor, audit.FILE);
    assert.doesNotThrow(() => audit.record(entry));
    assert.deepEqual(audit.recent(), []);
    assert.equal(fs.readFileSync(neighbor, 'utf8'), SECRET);
    assert.equal(mode(neighbor), 0o644);
    fs.unlinkSync(audit.FILE);
  }

  audit.record(entry);
  const before = fs.readFileSync(audit.FILE, 'utf8');
  const full = t.mock.method(fs, 'writeFileSync', () => {
    throw Object.assign(new Error(SECRET), { code: 'ENOSPC' });
  });
  assert.doesNotThrow(() => audit.record({ ...entry, error: SECRET }));
  assert.equal(audit.admit(entry), null);
  full.mock.restore();
  assert.equal(fs.readFileSync(audit.FILE, 'utf8'), before);
});

test('real MCP stdio audits a verified, unknown and failed response from an isolated Bot fixture', async (t) => {
  const { audit, directory, scratch } = fixture(t);
  const chatId = 'bot:fixture_audit_r6';
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, `/api/chats/${chatId}/messages`);
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { text, clientMessageId } = JSON.parse(raw);
    calls += 1;
    res.setHeader('content-type', 'application/json');
    if (calls === 1) res.end(JSON.stringify({ message: { chatId, id: 'msg_fixture', role: 'user', text, clientMessageId } }));
    else res.writeHead(calls === 2 ? 503 : 400).end(JSON.stringify({ message: SECRET }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let client;
  try {
    client = await connect({
      clientName: 'minimax-audit-r6-fixture',
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MINIMAX_'))),
        MINIMAX_MCP_HOME: directory,
        MINIMAX_DB_PATH: path.join(scratch, 'unused.sqlite'),
        MINIMAX_BOT_GATEWAY: `http://127.0.0.1:${server.address().port}`,
      },
    });
    assert.equal(client.init.protocolVersion, '2025-06-18');
    const { tools } = await client.request('tools/list');
    assert.deepEqual(tools.map(({ name }) => name), [
      'minimax_status', 'minimax_session', 'minimax_agent', 'minimax_bot', 'minimax_questionnaire',
    ]);
    const responses = [];
    for (const text of [SECRET, 'before ' + SECRET + ' after', 'x'.repeat(350) + SECRET]) {
      responses.push(await client.call('minimax_bot', { action: 'send', target: chatId, text, clientMessageId: `synthetic-${calls}` }));
    }
    const payloads = responses.map((result) => JSON.parse(result.content[0].text));
    assert.equal(payloads[0].verified, true);
    assert.equal(payloads[1].sent, null);
    assert.equal(responses[2].isError, true);
    assert.equal(calls, 3);

    const raw = fs.readFileSync(audit.FILE, 'utf8');
    assert.equal(raw.includes(SECRET) || raw.includes(chatId) || raw.includes('synthetic-'), false);
    const rows = audit.recent();
    assert.deepEqual(rows.map(({ phase }) => phase), ['admission', 'outcome', 'admission', 'outcome', 'admission', 'outcome']);
    for (let i = 0; i < rows.length; i += 2) {
      assert.equal(rows[i].ok, null);
      assert.match(rows[i].operationId, /^[a-f0-9-]{36}$/);
      assert.equal(rows[i].operationId, rows[i + 1].operationId);
    }
    assert.equal(new Set(rows.map(({ operationId }) => operationId)).size, 3);
    assert.deepEqual(rows.filter(({ phase }) => phase === 'outcome').map(({ tool, level, args, ok, error }) => ({ tool, level, args, ok, error })), [
      { tool: 'minimax_bot', level: 'commit', args: { action: 'send', mode: 'direct' }, ok: true, error: undefined },
      { tool: 'minimax_bot', level: 'commit', args: { action: 'send', mode: 'direct' }, ok: false, error: undefined },
      { tool: 'minimax_bot', level: 'commit', args: { action: 'send', mode: 'direct' }, ok: false, error: 'operation_error' },
    ]);
  } finally {
    client?.close();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
});
