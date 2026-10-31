'use strict';
/**
 * validate.js — 按工具自己的 inputSchema 校验入参。
 *
 * 为什么要这一层：MCP 协议规定"参数不合 schema 时服务端应该报错"，但很多实现
 * 只是把参数直接丢进业务代码，于是 `limit: "abc"` 会一路变成 `limit NaN`、
 * `x: "foo"` 会变成 `click(NaN, NaN)`。这类问题不会崩，但会静默做错事——
 * 比崩溃更糟。
 *
 * 这里实现 JSON Schema 的一个够用子集：type / required / enum / minimum /
 * maximum / properties / additionalProperties / items / minLength。
 * 不追求完整规范，追求"把明显错的参数挡在门外"。
 */

const TYPE_CHECKS = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
};

function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number' && !Number.isFinite(v)) return 'NaN/Infinity';
  return typeof v;
}

/**
 * 校验一个值。返回错误字符串数组（空数组=通过）。
 * path 用于拼出 "policy.autoNudge.cooldownMinutes 必须是整数" 这种可读路径。
 */
function checkValue(schema, value, path, errors) {
  if (!schema || typeof schema !== 'object') return;

  // type
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = types.some((t) => (TYPE_CHECKS[t] ? TYPE_CHECKS[t](value) : true));
    if (!ok) {
      errors.push(`${path} 类型应为 ${types.join('|')}，实际是 ${describe(value)}`);
      return; // 类型不对就没法继续往下查
    }
  }

  // enum
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path} 只能是 ${schema.enum.map((x) => JSON.stringify(x)).join(' / ')}，实际是 ${JSON.stringify(value)}`);
  }

  // 数字范围
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${path} 不能小于 ${schema.minimum}，实际是 ${value}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${path} 不能大于 ${schema.maximum}，实际是 ${value}`);
    }
  }

  // 字符串长度
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${path} 长度不能小于 ${schema.minLength}（当前 ${value.length}）`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(`${path} 长度不能大于 ${schema.maxLength}（当前 ${value.length}）`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path} 不符合格式 ${schema.pattern}`);
    }
  }

  // 对象
  if (TYPE_CHECKS.object(value) && schema.properties) {
    for (const key of schema.required || []) {
      if (value[key] === undefined) errors.push(`缺少必填参数 ${path ? `${path}.` : ''}${key}`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!schema.properties[key]) {
          errors.push(`${path ? `${path}.` : ''}${key} 不是这个工具支持的参数（支持：${Object.keys(schema.properties).join(', ')}）`);
        }
      }
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (value[key] === undefined) continue;
      checkValue(sub, value[key], path ? `${path}.${key}` : key, errors);
    }
  }

  // 数组
  if (TYPE_CHECKS.array(value) && schema.items) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${path} 至少要有 ${schema.minItems} 项`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${path} 最多 ${schema.maxItems} 项`);
    }
    value.forEach((item, i) => checkValue(schema.items, item, `${path}[${i}]`, errors));
  }
}

/**
 * 校验一次工具调用。
 * 返回 {ok, errors, args}；args 会把 undefined 去掉并补上默认值，
 * 这样业务代码不用到处写 `?? 默认值`。
 */
function validateArgs(tool, args) {
  const errors = [];
  const input = args === undefined || args === null ? {} : args;

  if (!TYPE_CHECKS.object(input)) {
    return { ok: false, errors: [`参数必须是一个对象，实际是 ${describe(input)}`], args: {} };
  }

  checkValue(tool.inputSchema || { type: 'object' }, input, '', errors);

  // 补默认值（只对顶层，够用且不会让人意外）
  const withDefaults = { ...input };
  for (const [key, schema] of Object.entries((tool.inputSchema || {}).properties || {})) {
    if (withDefaults[key] === undefined && schema.default !== undefined) {
      withDefaults[key] = schema.default;
    }
  }

  return { ok: errors.length === 0, errors, args: withDefaults };
}

module.exports = { validateArgs, checkValue };
