/* ============================================
   MeetNote AI — LLM shared contracts
   Typed errors, output normalization, repair loop.
   Keeps every provider adapter honest about the
   single output shape the app stores.
   ============================================ */

// Stable machine-readable error codes shared with the client.
const LLM_ERROR = {
  PROVIDER_NOT_FOUND: 'LLM_PROVIDER_NOT_FOUND',
  MODEL_NOT_SUPPORTED: 'LLM_MODEL_NOT_SUPPORTED',
  AUTH_REQUIRED: 'LLM_AUTH_REQUIRED',
  AUTH_INVALID: 'LLM_AUTH_INVALID',
  RATE_LIMITED: 'LLM_RATE_LIMITED',
  TIMEOUT: 'LLM_TIMEOUT',
  CONTEXT_TOO_LARGE: 'LLM_CONTEXT_TOO_LARGE',
  INVALID_OUTPUT: 'LLM_INVALID_OUTPUT',
  PROVIDER_UNAVAILABLE: 'LLM_PROVIDER_UNAVAILABLE'
};

// Default HTTP status per error code so routes stay declarative.
const STATUS_BY_CODE = {
  [LLM_ERROR.PROVIDER_NOT_FOUND]: 404,
  [LLM_ERROR.MODEL_NOT_SUPPORTED]: 400,
  [LLM_ERROR.AUTH_REQUIRED]: 401,
  [LLM_ERROR.AUTH_INVALID]: 401,
  [LLM_ERROR.RATE_LIMITED]: 429,
  [LLM_ERROR.TIMEOUT]: 504,
  [LLM_ERROR.CONTEXT_TOO_LARGE]: 413,
  [LLM_ERROR.INVALID_OUTPUT]: 502,
  [LLM_ERROR.PROVIDER_UNAVAILABLE]: 502
};

const RETRYABLE_CODES = new Set([
  LLM_ERROR.RATE_LIMITED,
  LLM_ERROR.TIMEOUT,
  LLM_ERROR.PROVIDER_UNAVAILABLE
]);

/**
 * Build a typed LLM error carrying the machine code, provider and HTTP status.
 * @param {string} code one of LLM_ERROR
 * @param {string} message human readable, safe to show the user
 * @param {{provider?: string, retryable?: boolean, statusCode?: number}} [meta]
 */
function llmError(code, message, meta = {}) {
  const error = new Error(message);
  error.llmCode = code;
  error.provider = meta.provider || '';
  error.retryable = meta.retryable ?? RETRYABLE_CODES.has(code);
  error.statusCode = meta.statusCode || STATUS_BY_CODE[code] || 502;
  return error;
}

/** Attach the provider id to any typed error that is missing one. */
function tagProvider(error, provider) {
  if (error && error.llmCode && !error.provider) error.provider = provider;
  return error;
}

/**
 * Extract a JSON object from a model response that may be wrapped in
 * markdown fences or surrounded by prose. Returns null when nothing parses.
 */
function parseJsonLoose(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const candidates = [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(raw);
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function cleanString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function cleanStringList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => cleanString(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

/**
 * Coerce a raw provider object into the canonical summary contract.
 * Throws LLM_INVALID_OUTPUT when the payload cannot yield a usable summary.
 * @returns {{summary:string,keyPoints:string[],decisions:string[],actionItems:Array,openQuestions:string[]}}
 */
function normalizeSummary(raw, provider) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : parseJsonLoose(raw);
  if (!source || typeof source !== 'object') {
    throw llmError(LLM_ERROR.INVALID_OUTPUT, 'The provider returned an unreadable summary.', { provider });
  }

  const summary = cleanString(source.summary, 20000);
  if (!summary) {
    throw llmError(LLM_ERROR.INVALID_OUTPUT, 'The provider returned a summary without any content.', { provider });
  }

  const actionItems = (Array.isArray(source.actionItems) ? source.actionItems : [])
    .map(item => (item && typeof item === 'object' ? item : {}))
    .map(item => ({
      text: cleanString(item.text, 2000),
      assignee: cleanString(item.assignee, 200),
      dueDate: cleanString(item.dueDate, 100)
    }))
    .filter(item => item.text)
    .slice(0, 200);

  return {
    summary,
    keyPoints: cleanStringList(source.keyPoints, 100, 2000),
    decisions: cleanStringList(source.decisions, 100, 2000),
    actionItems,
    openQuestions: cleanStringList(source.openQuestions, 100, 2000)
  };
}

/**
 * Coerce a raw provider object into the canonical title contract.
 * @returns {{title:string}}
 */
function normalizeTitle(raw, provider) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : parseJsonLoose(raw);
  const title = cleanString(source?.title, 120);
  if (title.length < 3) {
    throw llmError(LLM_ERROR.INVALID_OUTPUT, 'The provider returned an empty meeting title.', { provider });
  }
  return { title };
}

/**
 * Call a text-producing model, normalize its output, and on the first
 * schema failure ask it to repair the JSON exactly once. No extra meeting
 * data is sent during repair — only the prior malformed answer.
 *
 * @param {(repairHint?: string) => Promise<string>} callModel returns raw text
 * @param {(raw: string) => object} normalize throws on invalid output
 * @param {string} provider provider id for error tagging
 */
async function withRepair(callModel, normalize, provider) {
  let lastRaw = '';
  try {
    lastRaw = await callModel();
    return normalize(lastRaw);
  } catch (error) {
    if (error.llmCode && error.llmCode !== LLM_ERROR.INVALID_OUTPUT) throw error;
  }

  const repairHint = [
    'Your previous response was not valid JSON matching the required schema.',
    'Return only a single JSON object with the required fields and nothing else.',
    'Previous response:',
    String(lastRaw || '').slice(0, 4000)
  ].join('\n');

  const repaired = await callModel(repairHint);
  return normalize(repaired);
}

/**
 * Retry a task while its error is marked retryable (network, 429, 5xx, timeout),
 * with short exponential backoff. Non-retryable errors propagate immediately.
 * @param {() => Promise<any>} task
 * @param {{retries?: number, baseDelayMs?: number}} [options]
 */
async function withRetry(task, options = {}) {
  const retries = options.retries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 400;
  let attempt = 0;
  for (;;) {
    try {
      return await task();
    } catch (error) {
      attempt += 1;
      if (!error.retryable || attempt > retries) throw error;
      await new Promise(resolve => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
}

module.exports = {
  LLM_ERROR,
  RETRYABLE_CODES,
  llmError,
  tagProvider,
  parseJsonLoose,
  normalizeSummary,
  normalizeTitle,
  withRepair,
  withRetry
};
