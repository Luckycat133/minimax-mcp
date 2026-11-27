'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { cdp } = require('./cdp');
const { control } = require('./agent');
const db = require('./db');
const { requireFront } = require('./desktop');

async function submit(detail, answers, ctx) {
  if (db.questionnaireDetail(detail.requestId)?.status !== 'pending') throw new Error('问卷已处理');
  requireFront();
  if (!await cdp.isAvailable()) throw new Error('提交问卷需要 MiniMax CDP 已连接');
  if (!detail.steps.length) throw new Error('这张卡片没有可提交的选项');

  const byStep = new Map(answers.map((answer) => [answer.stepId, answer]));
  const steps = detail.steps.map((step) => ({
    ...step,
    answer: byStep.get(step.stepId),
  }));
  if (ctx?.shouldStop?.()) throw new Error('客户端已取消提交');
  requireFront();
  const action = await cdp.answerQuestion(detail.requestId, steps).catch(() => null);
  if (action?.ok === false) throw new Error(action.error);

  let after = detail;
  for (let attempt = 0; attempt < 12 && after?.status === 'pending'; attempt += 1) {
    await delay(250);
    try {
      after = db.questionnaireDetail(detail.requestId);
    } catch {
      // A transient read failure after submission is an unknown outcome.
    }
  }
  const recorded = after?.answered?.answers;
  const verified = after?.status === 'answered' && Array.isArray(recorded) && steps.every(({ stepId, answer }) => {
    const item = recorded.find((entry) => entry.stepId === stepId);
    const wanted = [...(answer?.optionIds || [])].sort();
    const actual = [...(item?.selectedOptionIds || item?.optionIds || [])].sort();
    return JSON.stringify(actual) === JSON.stringify(wanted) &&
      Boolean(item?.selectedOther) === Boolean(answer?.selectedOther) &&
      (!answer?.selectedOther || item?.otherText === answer.otherText);
  });
  return {
    submitted: verified ? true : null,
    verified,
    requestId: detail.requestId,
    sessionId: detail.sessionId,
    status: after?.status || 'unknown',
    ...(!verified ? { note: '未能确认问卷已按选项入库，请查看卡片状态后再操作' } : {}),
  };
}

module.exports = { submit: (detail, answers, ctx) => control(() => submit(detail, answers, ctx)) };
