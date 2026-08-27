/* ============================================
   MeetNote AI — DeepSeek adapter
   DeepSeek Chat Completions with JSON output.
   Endpoint is a fixed constant (no client-supplied
   base URL) to avoid SSRF.
   ============================================ */

const { LLM_ERROR, llmError, normalizeSummary, normalizeTitle, withRepair } = require('../contracts');
const { SYSTEM_INSTRUCTION } = require('../prompts');
const { postJson, httpErrorFor } = require('./api-helpers');

const ENDPOINT = 'https://api.deepseek.com/chat/completions';

// Server-owned allowlist. Client-supplied model ids are validated against this.
const MODELS = [
  { id: 'deepseek-chat', label: 'DeepSeek Chat', contextWindow: 65536 },
  { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', contextWindow: 65536 }
];

/**
 * @param {object} deps
 * @param {() => Promise<string>} deps.getKey resolves the API key (env or Keychain)
 * @param {number} deps.timeoutMs per-request timeout
 */
function createDeepSeekAdapter(deps) {
  const { getKey, timeoutMs } = deps;
  const id = 'deepseek';

  function modelSpec(modelId) {
    return MODELS.find(model => model.id === modelId) || MODELS[0];
  }

  async function requireKey() {
    const key = (await getKey()) || '';
    if (!key) throw llmError(LLM_ERROR.AUTH_REQUIRED, 'DeepSeek API key is not configured.', { provider: id });
    return key;
  }

  async function getStatus() {
    const configured = Boolean(await getKey());
    return {
      configured,
      available: configured,
      state: configured ? 'ready' : 'setup_required',
      message: configured ? 'DeepSeek API key is configured.' : 'Add a DeepSeek API key to enable this provider.'
    };
  }

  function listModels() {
    return MODELS.map(({ id: modelId, label }) => ({ id: modelId, label }));
  }

  function getModelSpec(model) {
    return modelSpec(model);
  }

  // Shared call path for summary + title on an already-built prompt.
  // Returns { data, usage, model }. Budget is enforced by the service.
  async function run({ prompt, model, normalize }) {
    const key = await requireKey();
    const spec = modelSpec(model);

    let usage = {};
    const callModel = async repairHint => {
      const messages = [
        { role: 'system', content: SYSTEM_INSTRUCTION },
        { role: 'user', content: prompt }
      ];
      if (repairHint) messages.push({ role: 'user', content: repairHint });

      const response = await postJson(ENDPOINT, {
        headers: { Authorization: `Bearer ${key}` },
        body: {
          model: spec.id,
          messages,
          response_format: { type: 'json_object' },
          temperature: 0,
          stream: false
        },
        timeoutMs,
        provider: id
      });
      if (!response.ok) throw await httpErrorFor(response, id, body => body?.error?.message);

      const body = await response.json().catch(() => ({}));
      usage = {
        inputTokens: Number(body?.usage?.prompt_tokens) || 0,
        outputTokens: Number(body?.usage?.completion_tokens) || 0
      };
      return body?.choices?.[0]?.message?.content || '';
    };

    const data = await withRepair(callModel, raw => normalize(raw, id), id);
    return { data, usage, model: spec.id };
  }

  async function testConnection() {
    // Minimal, cheap round trip to verify the key works.
    const key = await requireKey();
    const response = await postJson(ENDPOINT, {
      headers: { Authorization: `Bearer ${key}` },
      body: { model: MODELS[0].id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false },
      timeoutMs,
      provider: id
    });
    if (!response.ok) throw await httpErrorFor(response, id, body => body?.error?.message);
    return { ok: true, message: 'DeepSeek connection succeeded.' };
  }

  return {
    id,
    name: 'DeepSeek',
    kind: 'api',
    needsKey: true,
    getStatus,
    listModels,
    getModelSpec,
    testConnection,
    summarize: ({ prompt, model }) => run({ prompt, model, normalize: normalizeSummary }),
    title: ({ prompt, model }) => run({ prompt, model, normalize: normalizeTitle })
  };
}

module.exports = { createDeepSeekAdapter, MODELS };
