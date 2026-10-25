'use strict';

/**
 * smoke.test.js — 起一次真实的 stdio MCP 会话，走 initialize → tools/list → 只读调用。
 * 不做任何点击、不发送消息，所以在用户正在用 MiniMax 时也能安全跑。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');

const SERVER = path.join(__dirname, '..', 'mcp-server.js');

function main() {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: child.stdout, terminal: false });
  const pending = new Map();
  let nextId = 1;

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  });

  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`超时: ${method}`)); }
    }, 60000);
  });

  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };

  const results = [];
  const record = (label, pass, detail) => {
    results.push({ label, pass, detail });
    console.log(`${pass ? '[OK]  ' : '[FAIL]'} ${label}${detail ? ` — ${detail}` : ''}`);
  };

  (async () => {
    const init = await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '1' },
    });
    record('initialize', Boolean(init.result?.serverInfo?.name), init.result?.serverInfo?.name);
    notify('notifications/initialized', {});

    const list = await send('tools/list', {});
    const tools = list.result?.tools || [];
    record('tools/list', tools.length >= 14, `${tools.length} 个工具`);

    for (const name of ['minimax_status', 'minimax_list_sessions', 'minimax_pending']) {
      const r = await send('tools/call', { name, arguments: {} });
      const isErr = r.result?.isError === true;
      let detail = '';
      if (!isErr) {
        try { detail = JSON.parse(r.result.content[0].text).dbPath || 'ok'; } catch { detail = 'ok'; }
      } else {
        detail = r.result?.content?.[0]?.text?.slice(0, 120) || 'error';
      }
      record(`tools/call ${name}`, !isErr, detail);
    }

    const bad = await send('tools/call', { name: 'minimax_nope', arguments: {} });
    record('未知工具被拒绝', Boolean(bad.error), bad.error?.message);

    // 回归：窗口/焦点窗口必须只属于 MiniMax，不能把宿主或别的 App 的窗口混进来。
    // 曾经在这里栽过——按"当前活跃应用"取焦点窗口，结果拿到的是 MCP 宿主自己的窗口。
    const wins = await send('tools/call', { name: 'minimax_windows', arguments: {} });
    let winOk = wins.result?.isError !== true;
    let detail = '';
    if (winOk) {
      const parsed = JSON.parse(wins.result.content[0].text);
      const foreign = (parsed.windows || []).filter((w) => w.app !== 'MiniMax Code');
      winOk = foreign.length === 0;
      detail = foreign.length ? `混进了 ${foreign.map((f) => f.app).join(',')}` : `${parsed.onScreenCount} 个在屏窗口`;
    } else {
      detail = '工具报错';
    }
    record('窗口列表只含 MiniMax', winOk, detail);

    // 回归：preview 是只读的，任何情况下都必须放行；且必须报告守卫状态。
    const pv = await send('tools/call', {
      name: 'minimax_send_message',
      arguments: { message: 'x', preview: true },
    });
    let pvOk = pv.result?.isError !== true;
    let pvDetail = '';
    if (pvOk) {
      const parsed = JSON.parse(pv.result.content[0].text);
      pvOk = parsed.preview === true
        && typeof parsed.guard === 'object'
        && typeof parsed.inputAt === 'object'
        && Array.isArray(parsed.busySessions);
      pvDetail = `guard.busy=${parsed.guard?.busy}, busySessions=${parsed.busySessions?.length}`;
    } else {
      pvDetail = pv.result?.content?.[0]?.text?.slice(0, 100) || 'error';
    }
    record('preview 只读且放行', pvOk, pvDetail);

    // 回归：有会话在活跃时，发送必须被守卫拒绝，且错误里要点名是哪些会话。
    const guarded = await send('tools/call', {
      name: 'minimax_send_message',
      arguments: { message: '联调守卫测试', send: true },
    });
    const gErr = guarded.result?.isError === true;
    const gText = guarded.result?.content?.[0]?.text || '';
    record('活跃守卫拦住发送', gErr && /已拒绝发送/.test(gText), gErr ? gText.slice(0, 110) : '竟然放行了');

    const failed = results.filter((r) => !r.pass).length;
    console.log(`\n${results.length - failed}/${results.length} 通过`);
    child.kill();
    process.exit(failed === 0 ? 0 : 1);
  })().catch((err) => {
    console.error('冒烟测试异常:', err.message);
    child.kill();
    process.exit(1);
  });
}

main();
