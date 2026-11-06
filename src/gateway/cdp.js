/**
 * cdp.js — MiniMax Code Chrome DevTools Protocol (CDP) Driver
 *
 * Provides direct, zero-permission, DOM-level control over MiniMax Code.
 * Inspired by TRAECNclaw architecture: skips macOS Accessibility (TCC)
 * and Screen Capture entirely by connecting to MiniMax Code via WebSocket.
 */

'use strict';

const http = require('http');

const DEFAULT_CDP_PORTS = [9223, 9222, 9224];
const DEFAULT_TIMEOUT_MS = 5000;

class MiniMaxCDPDriver {
  constructor(options = {}) {
    this.port = options.port || Number(process.env.MINIMAX_CDP_PORT) || 9223;
    this.ports = options.ports || DEFAULT_CDP_PORTS;
    this.targetUrlMatch = options.targetUrlMatch || 'archon';
    this._ws = null;
    this._reqId = 1;
    this._targetInfo = null;
  }

  /**
   * Probe whether a CDP port is reachable and returns targets.
   */
  async probePort(port) {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/json/list`, { timeout: 1500 }, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          try {
            const list = JSON.parse(raw);
            if (Array.isArray(list)) {
              resolve({ ok: true, port, list });
              return;
            }
          } catch {}
          resolve({ ok: false, port });
        });
      });
      req.on('error', () => resolve({ ok: false, port }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, port });
      });
    });
  }

  /**
   * Discover the Archon page target across candidate ports.
   */
  async discover() {
    // Try preferred port first, then others
    const candidatePorts = [this.port, ...this.ports.filter(p => p !== this.port)];
    for (const port of candidatePorts) {
      const probe = await this.probePort(port);
      if (!probe.ok) continue;

      const target = probe.list.find(t => t.url && t.url.includes(this.targetUrlMatch));
      if (target) {
        this.port = port;
        this._targetInfo = target;
        return { ok: true, port, target };
      }
    }
    return { ok: false, error: 'MiniMax Code archon window target not found' };
  }

  /**
   * Check if CDP is currently available.
   */
  async isAvailable() {
    const discovery = await this.discover();
    return discovery.ok;
  }

  /**
   * Connect to the discovered WebSocket debugger.
   */
  async connect() {
    const discovery = await this.discover();
    if (!discovery.ok) {
      throw new Error(`CDP discovery failed: ${discovery.error}`);
    }

    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      return this._ws;
    }

    const wsUrl = discovery.target.webSocketDebuggerUrl;
    if (!wsUrl) {
      throw new Error('No webSocketDebuggerUrl found on target');
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('CDP WebSocket connection timeout'));
      }, DEFAULT_TIMEOUT_MS);

      ws.onopen = () => {
        clearTimeout(timer);
        this._ws = ws;
        resolve(ws);
      };

      ws.onerror = (err) => {
        clearTimeout(timer);
        reject(err);
      };

      ws.onclose = () => {
        this._ws = null;
      };
    });
  }

  /**
   * Send a CDP method and wait for response.
   */
  async send(method, params = {}) {
    const ws = await this.connect();
    const id = this._reqId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.removeEventListener('message', onMessage);
        reject(new Error(`CDP request timeout for ${method} (id=${id})`));
      }, DEFAULT_TIMEOUT_MS);

      const onMessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.id === id) {
            clearTimeout(timer);
            ws.removeEventListener('message', onMessage);
            if (data.error) {
              reject(new Error(`CDP error: ${JSON.stringify(data.error)}`));
            } else {
              resolve(data.result);
            }
          }
        } catch (e) {
          clearTimeout(timer);
          ws.removeEventListener('message', onMessage);
          reject(e);
        }
      };

      ws.addEventListener('message', onMessage);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Evaluate a JavaScript expression in the renderer context.
   */
  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return res && res.result ? res.result.value : null;
  }

  /**
   * Snapshot current UI status: buttons, inputs, unread dots, active task info.
   */
  async getUiSnapshot() {
    const script = `
      (() => {
        const queryText = (selector) => {
          const el = document.querySelector(selector);
          return el ? el.innerText.trim() : null;
        };
        const editor = document.querySelector("[data-testid='message-textarea'], [contenteditable='true'], textarea, input[type='text'], input:not([type])");
        const sendBtn = document.querySelector("[data-testid='send-button'], [data-testid*='submit']");
        const unreadDot = document.querySelector("[data-testid='inbox-unread-dot']");
        
        const allButtons = Array.from(document.querySelectorAll("button, [role='button'], [data-testid*='button']"))
          .map(b => ({
            text: b.innerText.trim(),
            testId: b.getAttribute("data-testid") || null,
            disabled: b.disabled || b.getAttribute("aria-disabled") === "true"
          }))
          .filter(b => b.text.length > 0 && b.text.length < 50);

        return {
          title: document.title,
          hasEditor: Boolean(editor),
          editorText: editor ? (editor.innerText || editor.value || "").trim() : "",
          canSend: sendBtn ? (!sendBtn.disabled && sendBtn.getAttribute("aria-disabled") !== "true") : false,
          hasUnread: Boolean(unreadDot),
          buttons: allButtons.slice(0, 20)
        };
      })()
    `;
    return await this.evaluate(script);
  }

  /**
   * Type message into the MiniMax TipTap/ProseMirror editor or active input field.
   */
  async typeMessage(text, { append = false } = {}) {
    const escaped = JSON.stringify(text);
    const script = `
      (() => {
        const el = document.querySelector("[data-testid='message-textarea'], [contenteditable='true'], textarea, input[type='text'], input:not([type])");
        if (!el) return { ok: false, error: "editor not found" };
        el.focus();
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          if (!${append}) el.value = '';
          el.value += ${escaped};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return { ok: true, currentText: el.value.trim() };
        }
        if (!${append}) {
          document.execCommand("selectAll", false, null);
          document.execCommand("delete", false, null);
        }
        document.execCommand("insertText", false, ${escaped});
        return { ok: true, currentText: (el.innerText || el.value || "").trim() };
      })()
    `;
    return await this.evaluate(script);
  }

  /**
   * Click send button or trigger Cmd+Enter in editor.
   */
  async sendMessage(text = null) {
    if (text) {
      await this.typeMessage(text);
    }
    const script = `
      (() => {
        const btn = document.querySelector("[data-testid='send-button']");
        if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
          btn.click();
          return { ok: true, via: "send-button" };
        }
        // Fallback: Dispatch Enter event
        const editor = document.querySelector("[data-testid='message-textarea']");
        if (editor) {
          editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", which: 13, keyCode: 13, bubbles: true }));
          return { ok: true, via: "enter-event" };
        }
        return { ok: false, error: "no send trigger available" };
      })()
    `;
    return await this.evaluate(script);
  }

  /**
   * Click an element by testId or text content.
   */
  async clickElement({ testId = null, text = null, selector = null }) {
    const escapedText = text ? JSON.stringify(text) : 'null';
    const escapedTestId = testId ? JSON.stringify(testId) : 'null';
    const escapedSelector = selector ? JSON.stringify(selector) : 'null';

    const script = `
      (() => {
        let el = null;
        if (${escapedTestId}) {
          el = document.querySelector("[data-testid=" + ${escapedTestId} + "]");
        }
        if (!el && ${escapedSelector}) {
          el = document.querySelector(${escapedSelector});
        }
        if (!el && ${escapedText}) {
          const targets = Array.from(document.querySelectorAll("button, a, span, div, [role='button']"));
          el = targets.find(e => e.innerText && e.innerText.trim() === ${escapedText});
          if (!el) {
            el = targets.find(e => e.innerText && e.innerText.includes(${escapedText}));
          }
        }
        if (!el) return { ok: false, error: "element not found" };
        el.click();
        return { ok: true, clickedTag: el.tagName, text: el.innerText ? el.innerText.trim().slice(0, 30) : "" };
      })()
    `;
    return await this.evaluate(script);
  }

  /**
   * Capture a pixel-perfect screenshot directly from the Chromium compositor (0 permissions needed!).
   */
  async captureScreenshot(outputPath = null) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(res.data, 'base64');
    if (outputPath) {
      const fs = require('fs');
      const path = require('path');
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, buf);
      return { path: outputPath, bytes: buf.length };
    }
    return { data: buf, bytes: buf.length };
  }

  /**
   * Find text in DOM elements and return their bounding rects and selectors.
   */
  async findText(text) {
    const escaped = JSON.stringify(text);
    const script = `
      (() => {
        const query = ${escaped}.toLowerCase();
        const matches = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.children.length === 0 && node.innerText && node.innerText.trim()) {
            const t = node.innerText.trim();
            if (t.toLowerCase().includes(query)) {
              const rect = node.getBoundingClientRect();
              matches.push({
                text: t,
                testId: node.getAttribute("data-testid") || null,
                tagName: node.tagName,
                cx: Math.round(rect.left + rect.width / 2),
                cy: Math.round(rect.top + rect.height / 2),
                rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
              });
            }
          }
        }
        return matches;
      })()
    `;
    return await this.evaluate(script);
  }

  /**
   * Get quota and reset-card status from the UI.
   */
  async getQuotaStatus() {
    const script = `
      (() => {
        const banner = document.querySelector(".usage-limit-banner, [data-testid*='limit']");
        const resetBtn = document.querySelector(".reset-card-use-button");
        const buyBtn = document.querySelector("[data-testid*='buy_credits']");
        const upgradeBtn = document.querySelector("[data-testid*='upgrade']");
        const text = banner ? banner.innerText.trim() : "";
        const mReset = text.match(/将于\\s*([\\d:]+)\\s*重置/);
        return {
          isLimited: Boolean(banner || resetBtn),
          resetAt: mReset ? mReset[1] : null,
          hasResetCard: Boolean(resetBtn && !resetBtn.disabled),
          canBuyCredits: Boolean(buyBtn),
          canUpgrade: Boolean(upgradeBtn),
          bannerSummary: text.replace(/\\s+/g, " ").slice(0, 100)
        };
      })()
    `;
    return await this.evaluate(script);
  }

  /**
   * Use reset card to restore quota immediately.
   * STRICT SAFETY GATE: Requires explicit user confirmation (confirmed: true).
   */
  async useResetCard({ confirmed = false } = {}) {
    if (!confirmed) {
      throw new Error('使用重置卡属于高风险资产消耗操作：强制要求人机交互确认。请先询问用户获得明确同意后，传 confirmed: true 才能执行。');
    }
    const script = `
      (() => {
        const btn = document.querySelector(".reset-card-use-button");
        if (!btn) return { ok: false, error: "当前界面没有可用的重置卡按钮" };
        if (btn.disabled) return { ok: false, error: "重置卡按钮处于禁用状态" };
        btn.click();
        return { ok: true, action: "reset_card_used" };
      })()
    `;
    return await this.evaluate(script);
  }

  /**
   * 获取每日签到状态（周期、天数、今日是否可签、积分详情）
   */
  async getCheckinStatus() {
    const script = `
      (async () => {
        try {
          let req = null;
          window.webpackChunk_N_E.push([["checkin_status_" + Date.now()], {}, (r) => { req = r; }]);
          if (!req) return { ok: false, error: "webpack require not found" };
          const axios = req("98304").ZP;
          const res = await axios.get("/minimax-cloud/api/v1/signin/status", { showToast: false });
          const raw = res.data?.data;
          if (!raw) return { ok: false, error: res.data?.base_resp?.status_msg || "获取签到数据失败" };
          const days = raw.days || [];
          const today = days.find(d => d.is_today);
          const claimable = today ? today.status === 2 : false;
          const claimed = today ? today.status === 3 : false;
          return {
            ok: true,
            scene: raw.scene,
            today: today || null,
            claimable,
            claimed,
            days,
          };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      })()
    `;
    return await this.evaluate(script);
  }

  /**
   * 执行每日签到领取积分
   */
  async claimCheckin() {
    const script = `
      (async () => {
        try {
          let req = null;
          window.webpackChunk_N_E.push([["checkin_claim_" + Date.now()], {}, (r) => { req = r; }]);
          if (!req) return { ok: false, error: "webpack require not found" };
          const axios = req("98304").ZP;
          const res = await axios.post("/minimax-cloud/api/v1/signin/claim", {}, { showToast: false });
          const raw = res.data?.data;
          if (!raw) return { ok: false, error: res.data?.base_resp?.status_msg || "签到失败" };
          return {
            ok: true,
            claimId: raw.claim_id,
            claimResult: raw.claim_result,
            dayNo: raw.day_no,
            points: raw.points,
            expireAtMs: raw.expire_at_ms,
            panel: raw.panel,
          };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      })()
    `;
    return await this.evaluate(script);
  }

  /**
   * Disconnect WebSocket.
   */
  close() {
    if (this._ws) {
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
  }
}

const defaultDriver = new MiniMaxCDPDriver();

module.exports = {
  MiniMaxCDPDriver,
  cdp: defaultDriver,
};
