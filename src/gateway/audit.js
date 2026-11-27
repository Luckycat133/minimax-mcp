'use strict';
/** 操作审计：JSONL 只留明确允许的元数据，正文和原始错误不落盘。 */

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const DIR = process.env.MINIMAX_MCP_HOME || path.join(os.homedir(), '.minimax-mcp');
const FILE = path.join(DIR, 'audit.jsonl');
const MAX_BYTES = 2 * 1024 * 1024; // 超过 2MB 就滚一份，别无限长
const { O_RDONLY, O_WRONLY, O_APPEND, O_CREAT, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
const READ = O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
const WRITE = O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK;

// These values are audit labels, including previously recorded operations.
// This list does not register tools or grant permission to call them.
const TOOLS = new Set([
  'minimax_status', 'minimax_session', 'minimax_agent', 'minimax_bot', 'minimax_questionnaire',
  'minimax_brief', 'minimax_desktop', 'minimax_watch', 'minimax_events', 'minimax_tasks',
  'minimax_list_sessions', 'minimax_read_session', 'minimax_tail_sessions', 'minimax_search',
  'minimax_pending', 'minimax_draft_answer', 'minimax_answer_question', 'minimax_get_result',
  'minimax_bot_roster', 'minimax_bot_message', 'minimax_bot_turn',
  'minimax_activate', 'minimax_screenshot', 'minimax_windows', 'minimax_new_task',
  'minimax_stop_generation', 'minimax_send_message', 'minimax_open_session', 'minimax_click',
  'minimax_click_text', 'minimax_find_text', 'minimax_type', 'minimax_key', 'minimax_auto_resume',
]);
const LEVELS = new Set(['read', 'ui', 'commit']);
const ACTIONS = new Set([
  'list', 'read', 'search', 'tail', 'send', 'result', 'stop', 'new', 'activate', 'roster', 'cancel',
  'resume', 'resume_pending', 'answer', 'open', 'draft', 'screenshot', 'windows', 'tick', 'status', 'reset', 'config',
]);
const MODES = new Set(['direct', 'group', 'screen', 'region']);
const FLAGS = ['send', 'preview', 'force', 'newSession', 'dryRun', 'relaunchWithDebug'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  // Validate a configured directory without changing its access permissions.
  fs.closeSync(fs.openSync(DIR, O_RDONLY | O_DIRECTORY | O_NOFOLLOW));
}

function withLog(flags, use) {
  const fd = fs.openSync(FILE, flags, 0o600);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw new Error('Invalid audit log file');
    if (flags === WRITE && (info.mode & 0o777) !== 0o600) fs.fchmodSync(fd, 0o600);
    return use(fd, info);
  } finally {
    fs.closeSync(fd);
  }
}

function sanitizeArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const out = {};
  if (Object.hasOwn(args, 'action') && ACTIONS.has(args.action)) out.action = args.action;
  if (Object.hasOwn(args, 'mode') && MODES.has(args.mode)) out.mode = args.mode;
  for (const flag of FLAGS) {
    if (Object.hasOwn(args, flag) && typeof args[flag] === 'boolean') out[flag] = args[flag];
  }
  return out;
}

function point(value) {
  if (!value || typeof value !== 'object') return null;
  const [x, y] = Array.isArray(value) ? value : [value.x, value.y];
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function auditFields(entry, at) {
  const target = {};
  const input = point(entry.target?.at);
  const click = point(entry.target?.clicked);
  if (input) target.at = input;
  if (click) target.clicked = [click.x, click.y];
  const correlated = (entry.phase === 'admission' || entry.phase === 'outcome') &&
    typeof entry.operationId === 'string' && OPERATION_ID.test(entry.operationId);
  return {
    at,
    tool: TOOLS.has(entry.tool) ? entry.tool : 'unknown',
    level: LEVELS.has(entry.level) ? entry.level : 'unknown',
    args: sanitizeArgs(entry.args),
    ok: typeof entry.ok === 'boolean' ? entry.ok : null,
    ms: Number.isSafeInteger(entry.ms) && entry.ms >= 0 ? entry.ms : null,
    ...(correlated ? { phase: entry.phase, operationId: entry.operationId } : {}),
    ...(input || click ? { target } : {}),
    ...(entry.error ? { error: 'operation_error' } : {}),
  };
}

function appendLine(line, durable) {
  const append = (fd) => {
    fs.writeFileSync(fd, line);
    if (durable) fs.fsyncSync(fd);
  };
  const reopen = withLog(WRITE, (fd, info) => {
    if (info.size > MAX_BYTES) {
      const current = fs.lstatSync(FILE, { throwIfNoEntry: false });
      if (current?.ino === info.ino && current.dev === info.dev) fs.renameSync(FILE, `${FILE}.1`);
      return true;
    }
    append(fd);
    return false;
  });
  if (reopen) withLog(WRITE, append);
}

/** `ok` is the caller's observed outcome flag; an absent flag stays unknown. */
function record(entry) {
  try {
    const line = JSON.stringify(auditFields(entry, new Date().toISOString()));
    ensureDir();
    appendLine(`${line}\n`, entry.phase === 'admission');
    return true;
  } catch {
    return false;
  }
}

function admit(entry) {
  const operationId = randomUUID();
  return record({ ...entry, phase: 'admission', operationId }) ? operationId : null;
}

/** 读最近 N 条，给排障用。 */
function recent(limit = 20) {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  try {
    if (!fs.lstatSync(DIR).isDirectory()) return [];
    const text = withLog(READ, (fd) => fs.readFileSync(fd, 'utf8'));
    const lines = text.trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => {
      try {
        const entry = JSON.parse(l);
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          const at = typeof entry.at === 'string' && ISO_DATE.test(entry.at) ? entry.at : null;
          return auditFields(entry, at);
        }
      } catch {
        // An interrupted historical append can leave a partial JSON line.
      }
      return { malformed: true };
    });
  } catch {
    return [];
  }
}

module.exports = { admit, record, recent, sanitizeArgs, FILE, DIR };
