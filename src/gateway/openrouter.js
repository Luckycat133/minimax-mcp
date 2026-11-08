'use strict';

/**
 * openrouter.js — OpenRouter AI Gateway Driver
 *
 * Integrates with crouter and macOS Keychain to dispatch background research,
 * code evaluation, and reasoning tasks to OpenRouter's model fleet.
 */

const { execSync } = require('node:child_process');

class OpenRouterClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || null;
    this.defaultModel = options.defaultModel || 'openrouter/free';
    this.baseUrl = options.baseUrl || 'https://openrouter.ai/api/v1';
  }

  getApiKey() {
    if (this.apiKey) return this.apiKey;
    if (process.env.OPENROUTER_API_KEY) {
      this.apiKey = process.env.OPENROUTER_API_KEY.trim();
      return this.apiKey;
    }
    try {
      const key = execSync('security find-generic-password -s openrouter-api-key -w 2>/dev/null', {
        encoding: 'utf8',
        timeout: 3000,
      }).trim();
      if (key) {
        this.apiKey = key;
        return this.apiKey;
      }
    } catch {}
    throw new Error('未检测到 OpenRouter API 密钥：请在系统 Keychain (openrouter-api-key) 或环境变量 OPENROUTER_API_KEY 中配置。');
  }

  async complete({ prompt, model = null, system = null, temperature = 0.2, maxTokens = 4000 } = {}) {
    const key = this.getApiKey();
    const candidateModels = [
      model,
      'openrouter/free',
      'nvidia/nemotron-3.5-super-vl:free',
      'recursive/flint-v1.0:free',
    ].filter(Boolean);

    const messages = [];
    if (system) {
      messages.push({ role: 'system', content: system });
    }
    messages.push({ role: 'user', content: prompt });

    let lastError = null;

    for (const m of candidateModels) {
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/jack/minimax-mcp',
            'X-Title': 'MiniMax Agentic Control Plane',
          },
          body: JSON.stringify({
            model: m,
            messages,
            temperature,
            max_tokens: maxTokens,
          }),
        });

        const raw = await res.text();
        let data = null;
        try {
          data = JSON.parse(raw.trim());
        } catch {
          throw new Error(`非合法 JSON 响应: ${raw.slice(0, 150)}`);
        }

        if (data.error) {
          throw new Error(data.error.message || JSON.stringify(data.error));
        }

        const choice = data.choices?.[0];
        const msg = choice?.message;
        const text = (msg?.content && msg.content.trim()) || (msg?.reasoning && msg.reasoning.trim()) || '';

        if (!text) {
          throw new Error(`模型 ${m} 返回的内容为空`);
        }

        return {
          content: text,
          model: data.model || m,
          usage: data.usage,
          reasoning: msg?.reasoning || null,
        };
      } catch (err) {
        lastError = err;
        // Continue to fallback model
      }
    }

    throw new Error(`所有候选模型均调用失败，最后错误: ${lastError?.message}`);
  }
}

const openrouter = new OpenRouterClient();

module.exports = {
  OpenRouterClient,
  openrouter,
};
