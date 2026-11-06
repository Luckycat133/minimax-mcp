/**
 * MiniMax Bot Remote Access Gateway
 *
 * Transparent reverse proxy that automatically discovers the running MiniMax Bot
 * Mini App instance, retrieves the dynamic loopback authentication token from the
 * Electron host via CDP, and proxies HTTP & SSE requests to allow remote access
 * from LAN (phones/tablets) and remote tunnels.
 */

const http = require('http');

let cachedPort = null;
let cachedToken = null;
let lastDiscoveryAt = 0;
let discoveryPromise = null;

async function discoverTarget(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedPort && cachedToken && (now - lastDiscoveryAt < 60000)) {
    return { port: cachedPort, token: cachedToken };
  }

  if (discoveryPromise) {
    return discoveryPromise;
  }

  discoveryPromise = (async () => {
    try {
      const r = await fetch('http://127.0.0.1:9223/json/list');
      if (!r.ok) throw new Error(`CDP unreachable (status ${r.status})`);
      const targets = await r.json();
      
      const botTarget = targets.find(t => t.url && t.url.includes('/bot'));
      if (!botTarget) {
        throw new Error('MiniMax Bot webview target not currently open or found in CDP');
      }

      const port = new URL(botTarget.url).port;
      const wsUrl = botTarget.webSocketDebuggerUrl;
      if (!wsUrl) throw new Error('No webSocketDebuggerUrl on bot target');

      const token = await new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error('Timeout capturing loopback token from CDP'));
        }, 5000);

        ws.onopen = () => {
          ws.send(JSON.stringify({ id: 1, method: 'Network.enable' }));
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.id === 1) {
              ws.send(JSON.stringify({
                id: 2,
                method: 'Runtime.evaluate',
                params: { expression: 'fetch("/api/state").then(r => r.status)' }
              }));
            }
            if (msg.method === 'Network.requestWillBeSentExtraInfo') {
              clearTimeout(timer);
              const headers = msg.params.headers || {};
              const captured = headers['x-mavis-miniapp-token'] || headers['X-Mavis-Miniapp-Token'];
              ws.close();
              if (captured) {
                resolve(captured);
              } else {
                reject(new Error('x-mavis-miniapp-token header missing in request'));
              }
            }
          } catch (e) {
            clearTimeout(timer);
            ws.close();
            reject(e);
          }
        };

        ws.onerror = (err) => {
          clearTimeout(timer);
          reject(err);
        };
      });

      cachedPort = port;
      cachedToken = token;
      lastDiscoveryAt = Date.now();
      return { port, token };
    } finally {
      discoveryPromise = null;
    }
  })();

  return discoveryPromise;
}

function createProxyServer(listenPort = 18888, listenHost = '0.0.0.0') {
  const server = http.createServer(async (req, res) => {
    // Top-level redirect
    if (req.url === '/' || req.url === '') {
      res.writeHead(302, { Location: '/bot' });
      res.end();
      return;
    }

    let targetInfo;
    try {
      targetInfo = await discoverTarget();
    } catch (err) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: 'miniapp_unavailable',
        message: 'MiniMax Bot is not currently running in MiniMax Code desktop app: ' + err.message
      }));
      return;
    }

    const { port, token } = targetInfo;

    const proxyHeaders = {
      ...req.headers,
      host: `127.0.0.1:${port}`,
      'x-mavis-miniapp-token': token,
    };

    // Delete hop-by-hop headers that should not be forwarded
    delete proxyHeaders['accept-encoding']; // let raw pass through for simple debugging if needed

    const options = {
      hostname: '127.0.0.1',
      port: Number(port),
      path: req.url,
      method: req.method,
      headers: proxyHeaders,
    };

    const proxyReq = http.request(options, (proxyRes) => {
      // If unauthorized, token might have refreshed
      if (proxyRes.statusCode === 401) {
        cachedToken = null;
      }

      // Handle SSE and stream responses
      const isSse = (proxyRes.headers['content-type'] || '').includes('text/event-stream');
      if (isSse) {
        res.writeHead(proxyRes.statusCode, {
          ...proxyRes.headers,
          'cache-control': 'no-cache, no-transform',
          'connection': 'keep-alive',
          'x-accel-buffering': 'no',
        });
      } else {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
      }

      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      cachedPort = null;
      cachedToken = null;
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'bad_gateway', message: err.message }));
      }
    });

    req.pipe(proxyReq);
  });

  server.on('upgrade', async (req, socket, head) => {
    try {
      const { port, token } = await discoverTarget();
      const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: Number(port),
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: `127.0.0.1:${port}`,
          'x-mavis-miniapp-token': token,
        }
      });

      proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n` +
          Object.keys(proxyRes.headers).map(k => `${k}: ${proxyRes.headers[k]}`).join('\r\n') +
          '\r\n\r\n');
        proxySocket.pipe(socket);
        socket.pipe(proxySocket);
      });

      proxyReq.on('error', () => {
        socket.destroy();
      });

      proxyReq.end();
    } catch {
      socket.destroy();
    }
  });

  return new Promise((resolve) => {
    server.listen(listenPort, listenHost, () => {
      resolve(server);
    });
  });
}

if (require.main === module) {
  const PORT = parseInt(process.env.PORT || '18888', 10);
  createProxyServer(PORT, '0.0.0.0').then(() => {
    console.log(`[MiniMax Bot Remote Proxy] Running on http://0.0.0.0:${PORT}`);
  }).catch((err) => {
    console.error('[MiniMax Bot Remote Proxy] Failed to start:', err);
    process.exit(1);
  });
}

module.exports = { createProxyServer, discoverTarget };
