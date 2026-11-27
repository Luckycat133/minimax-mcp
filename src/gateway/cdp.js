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

// Shared by the renderer operations that need to verify their target before acting.
const CONTROL_CONTEXT = `
  const visible = (el) => Boolean(el?.getClientRects().length && !el.closest('[aria-hidden="true"]'));
  const taskHome = () => {
    const home = document.querySelector('[data-testid="mavis-home-content"]');
    return visible(home) ? home : null;
  };
  const activeSession = () => {
    if (taskHome()) return null;
    const rows = [...document.querySelectorAll('[data-shortcut-session-active="true"][data-shortcut-session-target]')];
    const ids = new Set(rows.filter(visible).map(row => row.dataset.shortcutSessionTarget));
    if (ids.size === 1) return ids.values().next().value;
    return window.__MAVIS_SESSION_STORE__?.getState?.()?.activeSessionId || null;
  };
  const sessionRow = (id) => {
    if (!id) return null;
    const key = CSS.escape(id);
    const rows = document.querySelectorAll(
      'button[data-shortcut-session-target="' + key + '"], button[data-session-id="' + key + '"], [data-session-id="' + key + '"] button[aria-current]'
    );
    return [...rows].find(visible) || null;
  };
  const conversation = (sessionId) => {
    const scopes = [...document.querySelectorAll('[data-testid="chat-main-conversation"]:not([data-floating-chat])')];
    const matches = scopes.filter(scope => visible(scope) && scope.querySelector(
      '[data-testid="message-list"][data-chat-selection-session-id="' + CSS.escape(sessionId) + '"]'
    ));
    return matches.length === 1 ? matches[0] : null;
  };
  const scopeFor = (target) => {
    if (target.newSession) return taskHome();
    const id = activeSession();
    if (target.sessionId && id !== target.sessionId) return null;
    return id ? conversation(id) : taskHome();
  };
  const editorIn = (scope) => scope?.querySelector('[data-testid="message-textarea"]');
  const normalize = (value) => String(value ?? '').replace(/\\r\\n?/g, '\\n').trim();
  const editorText = (editor) => normalize(editor.value ?? editor.innerText);
`;

class MiniMaxCDPDriver {
  constructor(options = {}) {
    this.port = options.port || Number(process.env.MINIMAX_CDP_PORT) || 9223;
    this.ports = options.ports || DEFAULT_CDP_PORTS;
    this.matchesTarget = options.matchesTarget || ((target) =>
      target.type === 'page' && /\/archon\/?(?:[?#]|$)/.test(target.url));
    this.targetName = options.targetName || 'MiniMax Code';
    this._ws = null;
    this._connecting = null;
    this._reqId = 1;
    this._targetInfo = null;
    this._idleTimer = null;
    this._pendingRequests = 0;
  }

  /**
   * Reset idle auto-disconnect timer.
   * Auto-closes WebSocket after 3.5s of inactivity so Node event loop can cleanly exit.
   */
  _resetIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    if (this._pendingRequests > 0) return;
    this._idleTimer = setTimeout(() => {
      this.close();
    }, 3500);
    if (this._idleTimer && typeof this._idleTimer.unref === 'function') {
      this._idleTimer.unref();
    }
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

      const targets = probe.list.filter((target) => target.url && this.matchesTarget(target));
      if (targets.length) {
        this.port = port;
        const target = targets.find((candidate) => candidate.id === this._targetInfo?.id) || targets[0];
        this._targetInfo = target;
        return { ok: true, port, target };
      }
    }
    return { ok: false, error: `${this.targetName} renderer not found` };
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
    if (!this._connecting) {
      this._connecting = this._connect().finally(() => { this._connecting = null; });
    }
    return this._connecting;
  }

  async _connect() {
    if (this._ws?.readyState === WebSocket.OPEN) return this._ws;

    const discovery = await this.discover();
    if (!discovery.ok) throw new Error(`CDP discovery failed: ${discovery.error}`);
    const wsUrl = discovery.target.webSocketDebuggerUrl;
    if (!wsUrl) {
      throw new Error('No webSocketDebuggerUrl found on target');
    }

    this.close();
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

      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket connection failed for ${this.targetName}`));
      };

      ws.onclose = () => {
        if (this._ws === ws) this._ws = null;
      };
    });
  }

  /**
   * Send a CDP method and wait for response.
   */
  async send(method, params = {}) {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    this._pendingRequests += 1;
    try {
      const ws = await this.connect();
      const id = this._reqId++;
      return await new Promise((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          ws.removeEventListener('message', onMessage);
          ws.removeEventListener('close', onClose);
        };
        const onClose = () => {
          finish();
          reject(new Error(`CDP connection closed during ${method}`));
        };
        const onMessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.id !== id) return;
            finish();
            if (data.error) reject(new Error(`CDP error: ${JSON.stringify(data.error)}`));
            else resolve(data.result);
          } catch (error) {
            finish();
            reject(error);
          }
        };
        const timer = setTimeout(() => {
          finish();
          reject(new Error(`CDP request timeout for ${method} (id=${id})`));
        }, DEFAULT_TIMEOUT_MS);

        ws.addEventListener('message', onMessage);
        ws.addEventListener('close', onClose);
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          finish();
          reject(error);
        }
      });
    } finally {
      this._pendingRequests -= 1;
      this._resetIdleTimer();
    }
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

  async evaluateControl(body, args = {}) {
    return this.evaluate(`((args) => { ${CONTROL_CONTEXT} ${body} })(${JSON.stringify(args)})`);
  }

  async controlContext(sessionId = null) {
    return this.evaluateControl(`
      const activeSessionId = activeSession();
      const scope = activeSessionId ? conversation(activeSessionId) : taskHome();
      return {
        activeSessionId,
        targetAvailable: args.sessionId ? activeSessionId === args.sessionId || Boolean(sessionRow(args.sessionId)) : null,
        newTaskOpen: Boolean(taskHome()),
        composerReady: visible(editorIn(scope)),
        windowFocused: document.hasFocus(),
      };
    `, { sessionId });
  }

  /**
   * Type message into the MiniMax TipTap/ProseMirror editor or active input field.
   */
  async typeMessage(text, { append = false, ...target } = {}) {
    return this.evaluateControl(`
      if (!document.hasFocus()) return { ok: false, error: 'MiniMax 会话窗口没有焦点' };
      const editor = editorIn(scopeFor(args));
      if (!visible(editor)) return { ok: false, error: '找不到目标会话的输入框' };
      const expected = normalize(args.append ? (editor.value ?? editor.innerText) + args.text : args.text);
      editor.focus();
      if (editor.matches('textarea, input')) {
        const proto = editor.matches('textarea') ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setValue = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setValue.call(editor, args.append ? editor.value + args.text : args.text);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (editor.isContentEditable) {
        const selection = document.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        if (args.append) range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
        if (args.text) document.execCommand('insertText', false, args.text);
        else if (!args.append) document.execCommand('delete', false);
      } else {
        return { ok: false, error: '目标输入框不可编辑' };
      }
      const currentText = editorText(editor);
      return currentText === expected ? { ok: true, currentText } : { ok: false, error: '输入框内容与草稿不一致' };
    `, { ...target, text, append });
  }

  /**
   * Switch active session in MiniMax UI via Mavis Session Store / DOM.
   */
  async switchSession(sessionId) {
    if (!sessionId) throw new Error('sessionId 不能为空');
    const select = (expand) => this.evaluateControl(`
      if (!document.hasFocus()) return { ok: false, error: 'MiniMax 会话窗口没有焦点' };
      if (activeSession() === args.sessionId) return { ok: true, via: 'current-session' };
      const row = sessionRow(args.sessionId);
      if (!row && args.expand) {
        const toggle = document.querySelector('[data-testid="mavis-sidebar-expand"]');
        if (visible(toggle) && !toggle.disabled) {
          toggle.click();
          return { expanded: true };
        }
      }
      if (!row || row.disabled) return { ok: false, error: '目标会话未出现在 MiniMax 侧栏。请在 MiniMax 打开该会话后重试' };
      row.click();
      return { ok: true, via: 'sidebar' };
    `, { sessionId, expand });
    const result = await select(true);
    if (!result?.expanded) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return select(false);
  }

  /**
   * Create and switch to a new task session.
   */
  async newTask() {
    return this.evaluateControl(`
      if (!document.hasFocus()) return { ok: false, error: 'MiniMax 会话窗口没有焦点' };
      const selector = '[data-testid="mavis-new-task"], [data-testid="sidebar-shortcut-task.new"]';
      const button = [...document.querySelectorAll(selector)].find((element) =>
        visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true'
      );
      if (button) {
        button.click();
        return { ok: true, via: 'new-task-button' };
      }
      if (taskHome()) return { ok: true, via: 'current-home' };
      return { ok: false, error: '找不到新建任务按钮' };
    `);
  }

  /**
   * Click send button or trigger Cmd+Enter in editor.
   */
  async sendMessage(text, target) {
    return this.evaluateControl(`
      if (!document.hasFocus()) return { ok: false, error: 'MiniMax 会话窗口没有焦点' };
      const scope = scopeFor(args);
      const editor = editorIn(scope);
      if (!visible(editor) || editorText(editor) !== normalize(args.text)) {
        return { ok: false, error: '会话或草稿已变化，已取消发送' };
      }
      const button = scope.querySelector('[data-testid="send-button"]');
      if (!visible(button) || button.disabled || button.getAttribute('aria-disabled') === 'true') {
        return { ok: false, error: '目标会话的发送按钮不可用' };
      }
      button.click();
      return { ok: true };
    `, { ...target, text });
  }

  async stopGeneration({ sessionId, turnId }) {
    return this.evaluate(`(async ({ sessionId, turnId }) => {
      if (!document.hasFocus()) return { ok: false, error: 'MiniMax 会话窗口没有焦点' };
      if (location.protocol !== 'app:' || location.hostname !== '.') {
        return { ok: false, error: '当前 MiniMax 版本的窗口没有可验证的停止接口' };
      }
      const response = await fetch('/minimax-desktop/api/v1/session/' + encodeURIComponent(sessionId) + '/abort', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ turn_id: turnId, reason: 'user_stop' }),
        signal: AbortSignal.timeout(3500), redirect: 'error',
      });
      return { ok: response.ok, status: response.status };
    })(${JSON.stringify({ sessionId, turnId })})`);
  }

  async openMiniApp(pluginId, sessionId) {
    return this.evaluate(`(async (args) => {
      ${CONTROL_CONTEXT}
      if (!document.hasFocus()) return { success: false, code: 'window_not_focused' };
      const id = activeSession();
      if (!id || (args.sessionId && args.sessionId !== id)) return { success: false, code: 'session_not_active' };
      if (typeof window.miniAppAPI?.open !== 'function') return { success: false, code: 'unsupported' };
      return await window.miniAppAPI.open({ sessionId: id, pluginId: args.pluginId });
    })(${JSON.stringify({ pluginId, sessionId })})`);
  }

  async answerQuestion(requestId, steps) {
    return this.evaluate(`(async (requestId, steps) => {
      const byTestId = (scope, id) => scope.querySelector('[data-testid="' + CSS.escape(id) + '"]');
      const card = () => document.querySelector('[data-testid="questionnaire-composer"][data-request-id="' + CSS.escape(requestId) + '"]');
      const usable = (el) => Boolean(el?.getClientRects().length && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
      const pressed = (el) => el?.getAttribute('aria-checked') === 'true';
      const pause = () => new Promise(resolve => setTimeout(resolve, 45));
      const fail = (error) => ({ ok: false, error });
      if (!usable(card()) || !document.hasFocus()) return fail('请在 MiniMax 中打开目标问卷卡片后重试');
      const expectedStep = (root, step) => {
        if (step.options.length) return step.options.every((item) => byTestId(root, 'questionnaire-option-' + step.stepId + '-' + item.optionId));
        return Boolean(byTestId(root, 'questionnaire-others-toggle-' + step.stepId));
      };

      // Return to the first step so every submitted choice belongs to this request.
      for (let index = 1; index < steps.length; index += 1) {
        const root = card();
        if (!usable(root) || !document.hasFocus()) return fail('目标卡片已切换或 MiniMax 失去焦点');
        const previous = byTestId(root, 'questionnaire-progress-prev');
        if (!usable(previous)) break;
        previous.click();
        await pause();
      }

      for (const [index, step] of steps.entries()) {
        const root = card();
        if (!usable(root) || !document.hasFocus()) return fail('目标卡片已切换或 MiniMax 失去焦点');
        if (!expectedStep(root, step)) return fail('当前步骤与问卷记录不匹配');
        const answer = step.answer;
        if (!answer) {
          const skip = byTestId(root, 'questionnaire-skip');
          if (!usable(skip)) return fail('当前问卷步骤无法跳过');
          skip.click();
          if (index === steps.length - 1) return { ok: true };
          await pause();
          continue;
        }

        const option = (id) => byTestId(root, 'questionnaire-option-' + step.stepId + '-' + id);
        const other = byTestId(root, 'questionnaire-others-toggle-' + step.stepId);
        const selected = new Set(answer.optionIds);
        const relevant = step.options.map((item) => ({ id: item.optionId, button: option(item.optionId) }));
        if (relevant.some(({ button }) => !usable(button))) return fail('当前步骤的选项与问卷记录不匹配');
        if (step.selectionMode === 'single' && !answer.selectedOther) {
          const button = option(answer.optionIds[0]);
          if (!usable(button)) return fail('目标单选项不可用');
          button.click();
          if (index === steps.length - 1) return { ok: true };
          await pause();
          continue;
        }

        for (const { id, button } of relevant) {
          if (pressed(button) === selected.has(id)) continue;
          button.click();
          await pause();
        }
        if (pressed(other) !== answer.selectedOther) {
          if (!usable(other)) return fail('目标步骤的其他选项不可用');
          other.click();
          await pause();
        }
        if (answer.selectedOther) {
          const editor = byTestId(root, 'questionnaire-others-input-' + step.stepId);
          if (!usable(editor) || !editor.isContentEditable) return fail('找不到问卷文本输入框');
          editor.focus();
          const selection = document.getSelection();
          const range = document.createRange();
          range.selectNodeContents(editor);
          selection.removeAllRanges();
          selection.addRange(range);
          document.execCommand('insertText', false, answer.otherText);
          if (editor.innerText.trim() !== answer.otherText.trim()) return fail('问卷文本写入未确认');
          await pause();
        }
        if (relevant.some(({ id, button }) => pressed(button) !== selected.has(id)) || pressed(other) !== answer.selectedOther) {
          return fail('当前步骤的选项未确认');
        }
        const last = index === steps.length - 1;
        const next = byTestId(root, last ? 'questionnaire-submit' : 'questionnaire-next');
        if (!usable(next) || !document.hasFocus()) return fail('问卷提交或下一步按钮不可用');
        next.click();
        if (last) return { ok: true };
        await pause();
      }
      return fail('未找到提交步骤');
    })(${JSON.stringify(requestId)}, ${JSON.stringify(steps)})`);
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
   * 将 MiniMax 窗口带到前台 (零权限 CDP 原生实现)
   */
  async bringToFront() {
    try {
      await this.send('Page.bringToFront');
      await this.evaluate('window.focus()');
      return { ok: true, via: 'cdp' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
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
        const mReset = text.match(/(?:将于|reset at)\\s*([^\\s,。]+(?:\\s*[\\d:]+)?)\\s*(?:重置|\\.)/i) || text.match(/将于\\s*([\\d:]+)\\s*重置/);
        
        // 尝试从 React Fiber 直接获取高精度的 resetAtMs 毫秒时间戳
        let fiberResetAtMs = null;
        if (banner) {
          const fiberKey = Object.keys(banner).find(k => k.startsWith('__reactFiber'));
          if (fiberKey && banner[fiberKey]) {
            let curr = banner[fiberKey];
            let depth = 0;
            while (curr && depth < 20) {
              if (curr.memoizedProps && typeof curr.memoizedProps.resetAtMs === 'number') {
                fiberResetAtMs = curr.memoizedProps.resetAtMs;
                break;
              }
              curr = curr.return;
              depth++;
            }
          }
        }

        // 若 Fiber 未直接命中，则尝试从文本时间转换精确时间戳
        let resetAtMs = fiberResetAtMs;
        const resetAtStr = mReset ? mReset[1] : null;
        if (!resetAtMs && resetAtStr) {
          try {
            const mCnDate = resetAtStr.match(/^(\\d{1,2})月(\\d{1,2})日\\s*(\\d{1,2}):(\\d{2})$/);
            if (mCnDate) {
              const now = new Date();
              const mo = Number(mCnDate[1]);
              const da = Number(mCnDate[2]);
              const h = Number(mCnDate[3]);
              const m = Number(mCnDate[4]);
              const target = new Date(now.getFullYear(), mo - 1, da, h, m, 0, 0);
              if (target.getTime() < now.getTime() - 86400000) {
                target.setFullYear(target.getFullYear() + 1); // 跨年重置
              }
              resetAtMs = target.getTime();
            } else if (/^\\d{1,2}:\\d{2}$/.test(resetAtStr)) {
              const now = new Date();
              const [h, m] = resetAtStr.split(':').map(Number);
              const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
              if (target.getTime() < now.getTime() - 60000) {
                target.setDate(target.getDate() + 1); // 跨天重置
              }
              resetAtMs = target.getTime();
            } else {
              const parsed = Date.parse(resetAtStr);
              if (!isNaN(parsed)) resetAtMs = parsed;
            }
          } catch {}
        }

        // 关键修复：精确区分"已达/已达到上限"(硬阻断)与"即将达到上限"(软提醒)
        const isHardLimited = Boolean(resetBtn) || /已达到?[^。\\n]{0,12}上限/.test(text) || /usage limit reached/i.test(text);
        const waitSeconds = resetAtMs ? Math.max(0, Math.ceil((resetAtMs - Date.now()) / 1000)) : null;

        return {
          isLimited: isHardLimited,
          isApproachingLimit: Boolean(banner) && !isHardLimited,
          resetAt: resetAtStr,
          resetAtMs,
          waitSeconds,
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
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
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
