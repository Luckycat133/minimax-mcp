'use strict';
/**
 * questionnaire.js — 问卷答案的规范化与校验。
 *
 * 为什么要单独一层：调用方可能传两种格式（optionIds / selectedOptionIds），
 * 也可能传错 stepId 或不存在的 option。静默忽略会变成"点了半天什么都没选中"，
 * 所以这里一律严格校验，错了就报清楚。
 */

/** 把各种写法统一成 {stepId, optionIds, selectedOther, otherText} */
function normalizeSelections(detail, raw) {
  const steps = detail.steps || [];
  const byStep = new Map(steps.map((s) => [s.stepId, s]));
  const out = [];
  const errors = [];

  for (const item of raw || []) {
    if (!item || typeof item !== 'object') {
      errors.push('selections 里有一项不是对象');
      continue;
    }
    const stepId = item.stepId;
    const step = byStep.get(stepId);
    if (!step) {
      errors.push(`没有这一步: ${stepId}（可选: ${steps.map((s) => s.stepId).join(', ')}）`);
      continue;
    }
    let ids = item.optionIds || item.selectedOptionIds || [];
    if (typeof ids === 'string') ids = [ids];
    if (!Array.isArray(ids)) ids = [];

    const valid = new Set((step.options || []).map((o) => o.optionId));
    const unknown = ids.filter((id) => !valid.has(id));
    if (unknown.length) {
      errors.push(`步骤 ${stepId} 没有这些选项: ${unknown.join(', ')}（可选: ${[...valid].join(', ')}）`);
      ids = ids.filter((id) => valid.has(id));
    }
    if (step.selectionMode === 'single' && ids.length > 1) {
      errors.push(`步骤 ${stepId} 是单选，但给了 ${ids.length} 个选项`);
      ids = ids.slice(0, 1);
    }
    const selectedOther = item.selectedOther === true;
    const otherText = item.otherText || '';
    if (!ids.length && !selectedOther) {
      errors.push(`步骤 ${stepId} 没有选中任何选项`);
    }
    if (selectedOther && !otherText.trim()) {
      errors.push(`步骤 ${stepId} 选了"其他"但没给 otherText`);
    }
    out.push({ stepId, optionIds: ids, selectedOther, otherText });
  }

  // 必填步骤必须有答案
  for (const s of steps) {
    if (s.required === false) continue;
    if (!out.some((a) => a.stepId === s.stepId)) {
      errors.push(`缺少必答步骤: ${s.stepId}`);
    }
  }

  return { answers: out, errors };
}

/** 组装成 MiniMax 认识的 reply_payload。 */
function buildReplyPayload(detail, answers) {
  return {
    schemaVersion: 2,
    requestId: detail.requestId,
    answers: answers.map((a) => ({
      stepId: a.stepId,
      selectedOptionIds: a.optionIds,
      selectedOther: a.selectedOther === true,
      ...(a.selectedOther ? { otherText: a.otherText } : {}),
    })),
  };
}

/**
 * 生成"点哪里"的计划：把每个选中的选项翻译成要在屏幕上点的文字。
 * 单选用选项 label；多选同理（逐个点）。这一步不做任何动作，纯规划。
 */
function clickPlan(detail, answers) {
  const steps = new Map((detail.steps || []).map((s) => [s.stepId, s]));
  const plan = [];
  for (const a of answers) {
    const step = steps.get(a.stepId);
    if (!step) continue;
    for (const id of a.optionIds) {
      const opt = (step.options || []).find((o) => o.optionId === id);
      if (!opt) continue;
      plan.push({
        stepId: a.stepId,
        optionId: id,
        // 选项文字可能很长（带说明），点的时候用前 18 个字做 OCR 锚点
        anchor: String(opt.label || '').slice(0, 18),
        label: opt.label,
      });
    }
    if (a.selectedOther && a.otherText) {
      plan.push({
        stepId: a.stepId,
        optionId: null,
        anchor: '其他',
        label: '其他',
        thenType: a.otherText,
      });
    }
  }
  return plan;
}

/** 从建议答案里取一份可直接用的 selections。 */
function fromSuggestion(suggestion) {
  return (suggestion?.answers || []).map((a) => ({
    stepId: a.stepId,
    optionIds: a.selectedOptionIds || [],
    selectedOther: a.selectedOther === true,
    otherText: a.otherText || '',
  }));
}

module.exports = { normalizeSelections, buildReplyPayload, clickPlan, fromSuggestion };
