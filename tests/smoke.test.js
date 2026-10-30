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

    // 逐个调所有只读工具。用真实参数，确保不只是"能返回错误"。
    const readOnlyCalls = [
      ['minimax_status', {}],
      ['minimax_list_sessions', { limit: 3 }],
      ['minimax_pending', {}],
      ['minimax_tasks', { limit: 3 }],
      ['minimax_tail_sessions', { count: 2, perSession: 1 }],
      ['minimax_search', { query: 'minimax', limit: 2 }],
      ['minimax_windows', {}],
      ['minimax_get_result', { timeoutSeconds: 2 }],
    ];
    for (const [name, args] of readOnlyCalls) {
      const r = await send('tools/call', { name, arguments: args });
      const isErr = r.result?.isError === true;
      let detail = 'ok';
      if (isErr) {
        detail = r.result?.content?.[0]?.text?.slice(0, 120) || 'error';
      } else {
        try {
          const parsed = JSON.parse(r.result.content[0].text);
          detail = parsed.dbPath || `${Object.keys(parsed).slice(0, 3).join('/')}`;
        } catch { detail = 'ok'; }
      }
      record(`tools/call ${name}`, !isErr, detail);
    }

    // read_session 用序号和用 ID 两条路都要通
    const byIndex = await send('tools/call', { name: 'minimax_read_session', arguments: { session: '1', limit: 1 } });
    record('read_session 按序号', byIndex.result?.isError !== true);
    const listRes = await send('tools/call', { name: 'minimax_list_sessions', arguments: { limit: 1 } });
    let firstId = null;
    try { firstId = JSON.parse(listRes.result.content[0].text).sessions[0].sessionId; } catch { /* 忽略 */ }
    if (firstId) {
      const byId = await send('tools/call', { name: 'minimax_read_session', arguments: { session: firstId, limit: 1 } });
      record('read_session 按 ID', byId.result?.isError !== true);
    }

    // draft_answer：没有 pending 时对任意 requestId 调用必须给出可读的错误，不能崩
    const draft = await send('tools/call', { name: 'minimax_draft_answer', arguments: { requestId: 'ask_nonexistent' } });
    record('draft_answer 对不存在的 ID 报错', draft.result?.isError === true);

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

    // 回归：守卫必须能拦住发送。
    // 用 quietSeconds 设成极大值 + send:false —— 既保证一定触发守卫，
    // 又保证即使守卫失效也绝不会真的发出任何东西（不会污染用户的会话）。
    const guarded = await send('tools/call', {
      name: 'minimax_send_message',
      arguments: { message: '联调守卫测试', send: false, quietSeconds: 999999 },
    });
    const gErr = guarded.result?.isError === true;
    const gText = guarded.result?.content?.[0]?.text || '';
    record('活跃守卫拦住发送', gErr && /已拒绝发送/.test(gText), gErr ? gText.slice(0, 110) : '竟然放行了');

    // 回归：get_result 必须能在不改任何状态的情况下收回某个会话的最终回复。
    const gr = await send('tools/call', {
      name: 'minimax_get_result',
      arguments: { timeoutSeconds: 3 },
    });
    let grOk = gr.result?.isError !== true;
    let grDetail = '';
    if (grOk) {
      const parsed = JSON.parse(gr.result.content[0].text);
      grOk = typeof parsed.sessionId === 'string' && typeof parsed.done === 'boolean';
      grDetail = `session=${parsed.sessionId?.slice(0, 14)} done=${parsed.done}`;
    } else {
      grDetail = gr.result?.content?.[0]?.text?.slice(0, 100) || 'error';
    }
    record('get_result 可收回结果', grOk, grDetail);

    // OCR：找一段绝不存在的文字，必须是 0 命中且不报错（不能瞎给一个坐标）
    const nf = await send('tools/call', {
      name: 'minimax_find_text',
      arguments: { text: 'zzz-绝对不存在的文字-qqq', refresh: true },
    });
    let nfOk = nf.result?.isError !== true;
    let nfDetail = '';
    if (nfOk) {
      const parsed = JSON.parse(nf.result.content[0].text);
      nfOk = parsed.total === 0 && parsed.picked === null && parsed.scanned > 0;
      nfDetail = `扫了 ${parsed.scanned} 段，0 命中`;
    } else {
      nfDetail = nf.result?.content?.[0]?.text?.slice(0, 120) || 'error';
    }
    record('find_text 找不到时不瞎给坐标', nfOk, nfDetail);

    // OCR：找一段必然存在的文字（MiniMax 窗口标题），必须能定位到
    const ft = await send('tools/call', {
      name: 'minimax_find_text',
      arguments: { text: '新建任务', refresh: true },
    });
    let ftOk = ft.result?.isError !== true;
    let ftDetail = '';
    if (ftOk) {
      const parsed = JSON.parse(ft.result.content[0].text);
      ftOk = parsed.total >= 1 && typeof parsed.picked?.cx === 'number' && parsed.picked.cx > 0;
      ftDetail = parsed.total ? `${parsed.total} 命中 @(${parsed.picked.cx},${parsed.picked.cy})` : '0 命中';
    } else {
      ftDetail = ft.result?.content?.[0]?.text?.slice(0, 120) || 'error';
    }
    record('find_text 能定位真实控件', ftOk, ftDetail);

    // click_text：目标不存在时必须报错且不点击
    const ct = await send('tools/call', {
      name: 'minimax_click_text',
      arguments: { text: 'zzz-绝对不存在的按钮-qqq' },
    });
    record('click_text 找不到就拒绝点击', ct.result?.isError === true,
      ct.result?.content?.[0]?.text?.slice(0, 90) || '竟然点了');

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
