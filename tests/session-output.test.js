'use strict';

// Exercise the public stdio boundary against an isolated database, never the app DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { connect } = require('../scripts/stdio-client');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-session-output-'));
  const dbPath = path.join(root, 'fixture.sqlite');
  const sid = 'fixture-session';
  const long = '中文🙂abc'.repeat(10000);
  const thinking = '思考🙂'.repeat(3000);
  const contents = ['short', long, '🙂'.repeat(4000), 'x'.repeat(3999) + '🙂end'];
  const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'";
  const sql = [
    'create table local_runtime_sessions(session_id text);',
    'create table local_runtime_message_rows(id integer primary key, session_id text, role text, created_at_ms integer, data_json text);',
    `insert into local_runtime_sessions values (${quote(sid)});`,
    ...contents.map((content, i) => `insert into local_runtime_message_rows values (${i + 1},${quote(sid)},'assistant',${1000 + i},${quote(JSON.stringify({ msg_content: content, thinking_content: thinking }))});`),
  ].join('\n');
  let client;
  try {
    execFileSync('sqlite3', [dbPath], { input: sql });
    client = await connect({ env: { ...process.env, MINIMAX_DB_PATH: dbPath, MINIMAX_MCP_HOME: root } });
    const call = async (args) => {
      const response = await client.call('minimax_session', args);
      assert.equal(response.isError, false, response.content[0].text);
      return JSON.parse(response.content[0].text);
    };
    const page = await call({ sessionId: sid, limit: 4 });
    assert.deepEqual(page.messages.map((m) => m.id), [1, 2, 3, 4]);
    assert.equal(page.oldestId, 1);
    assert.equal(page.hasMore, false);
    assert.equal(page.messages[0].content, 'short');
    assert.equal(page.messages[0].contentTruncated, undefined);
    assert.equal(page.messages[1].contentChars, 60000);
    assert.equal(page.messages[1].contentTruncated, true);
    assert.equal([...page.messages[1].content].length, 4000);
    assert.equal(page.messages[2].content, contents[2]);
    assert.equal(page.messages[2].contentTruncated, undefined);
    assert.equal(page.messages[3].content, 'x'.repeat(3999) + '🙂');
    assert.ok(page.messages.every((m) => !Object.hasOwn(m, 'thinking')));

    const full = await call({ sessionId: sid, limit: 1, before: 3, maxChars: 0, includeThinking: true });
    assert.equal(full.messages[0].id, 2);
    assert.equal(full.messages[0].content, long);
    assert.equal(full.messages[0].thinking, thinking);
    assert.equal(full.messages[0].contentTruncated, undefined);
    const preview = await call({ sessionId: sid, limit: 1, before: 3, maxChars: 7, includeThinking: true });
    assert.equal(preview.messages[0].content, [...long].slice(0, 7).join(''));
    assert.equal(preview.messages[0].thinking, [...thinking].slice(0, 7).join(''));
    assert.equal(preview.messages[0].thinkingChars, 9000);
    assert.equal(preview.messages[0].thinkingTruncated, true);

    const seen = [];
    let before;
    do {
      const current = await call({ sessionId: sid, limit: 2, before });
      seen.unshift(...current.messages.map((m) => m.id));
      before = current.hasMore ? current.oldestId : null;
    } while (before !== null);
    assert.deepEqual(seen, [1, 2, 3, 4]);
    const samples = await call({ limit: 1, perSession: 4 });
    assert.equal(samples.sessions[0].latest[1].contentTruncated, true);
    const fullSamples = await call({ limit: 1, perSession: 4, maxChars: 0 });
    assert.equal(fullSamples.sessions[0].latest[1].content, long);
    for (const maxChars of [-1, 1.5, '4000', null]) {
      const invalid = await client.call('minimax_session', { sessionId: sid, maxChars });
      assert.equal(invalid.isError, true);
    }
    const fullPage = await call({ sessionId: sid, limit: 4, maxChars: 0 });
    console.log(JSON.stringify({ passed: true, fixture: '4 mixed Unicode messages', fullBytes: Buffer.byteLength(JSON.stringify(fullPage)), defaultBytes: Buffer.byteLength(JSON.stringify(page)) }));
  } finally {
    client?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
