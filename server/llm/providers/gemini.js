/* ============================================
   MeetNote AI — Google Gemini adapter
   Gemini generateContent with a response schema.
   API key is sent in the x-goog-api-key header, never
   in the URL/query string. Endpoint host is constant.
   ============================================ */

const { LLM_ERROR, llmError, normalizeSummary, normalizeTitle, withRepair } = require('../contracts');
const { SYSTEM_INSTRUCTION } = require('../prompts');
const { postJson, httpErrorFor } = require('./api-helpers');

const API_HOST = 'https://generativelanguage.googleapis.com/v1beta';

// Server-owned allowlist.
const MODELS = [
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', contextWindow: 1_000_000 },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', contextWindow: 1_000_000 },
  { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', contextWindow: 1_000_000 }
];

// Gemini responseSchema (OpenAPI subset — no $schema / additionalProperties).
const SUMMARY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    keyPoints: { type: 'ARRAY', items: { type: 'STRING' } },
    decisions: { type: 'ARRAY', items: { type: 'STRING' } },
    actionItems: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          text: { type: 'STRING' },
          assignee: { type: 'STRING' },
          dueDate: { type: 'STRING' }
        },
        required: ['text', 'assignee', 'dueDate'],
        propertyOrdering: ['text', 'assignee', 'dueDate']
      }
    },
    openQuestions: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['summary', 'keyPoints', 'decisions', 'actionItems', 'openQuestions'],
  propertyOrdering: ['summary', 'keyPoints', 'decisions', 'actionItems', 'openQuestions']
};

const TITLE_SCHEMA = {
  type: 'OBJECT',
  properties: { title: { type: 'STRING' } },
  required: ['title']
};

/**
 * @param {object} deps
 * @param {() => Promise<string>} deps.getKey resolves the API key (env or Keychain)
 * @param {number} deps.timeoutMs per-request timeout
 */
function createGeminiAdapter(deps) {
  const { getKey, timeoutMs } = deps;
  const id = 'gemini';

  function modelSpec(modelId) {
    return MODELS.find(model => model.id === modelId) || MODELS[0];
  }

  async function requireKey() {
    const key = (await getKey()) || '';
    if (!key) throw llmError(LLM_ERROR.AUTH_REQUIRED, 'Gemini API key is not configured.', { provider: id });
    return key;
  }

  async function getStatus() {
    const configured = Boolean(await getKey());
    return {
      configured,
      available: configured,
      state: configured ? 'ready' : 'setup_required',
      message: configured ? 'Gemini API key is configured.' : 'Add a Gemini API key to enable this provider.'
    };
  }

  function listModels() {
    return MODELS.map(({ id: modelId, label }) => ({ id: modelId, label }));
  }

  function getModelSpec(model) {
    return modelSpec(model);
  }

  // Runs an already-built prompt. Budget is enforced by the service.
  async function run({ prompt, model, normalize, responseSchema }) {
    const key = await requireKey();
    const spec = modelSpec(model);

    let usage = {};
    const callModel = async repairHint => {
      const parts = [{ text: prompt }];
      if (repairHint) parts.push({ text: repairHint });

      const response = await postJson(`${API_HOST}/models/${encodeURIComponent(spec.id)}:generateContent`, {
        headers: { 'x-goog-api-key': key },
        body: {
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
          contents: [{ role: 'user', parts }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema
          }
        },
        timeoutMs,
        provider: id
      });
      if (!response.ok) throw await httpErrorFor(response, id, body => body?.error?.message);

      const body = await response.json().catch(() => ({}));
      usage = {
        inputTokens: Number(body?.usageMetadata?.promptTokenCount) || 0,
        outputTokens: Number(body?.usageMetadata?.candidatesTokenCount) || 0
      };
      const textParts = body?.candidates?.[0]?.content?.parts || [];
      return textParts.map(part => part?.text || '').join('');
    };

    const data = await withRepair(callModel, raw => normalize(raw, id), id);
    return { data, usage, model: spec.id };
  }

  async function testConnection() {
    const key = await requireKey();
    const response = await postJson(`${API_HOST}/models/${encodeURIComponent(MODELS[0].id)}:generateContent`, {
      headers: { 'x-goog-api-key': key },
      body: {
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 1 }
      },
      timeoutMs,
      provider: id
    });
    if (!response.ok) throw await httpErrorFor(response, id, body => body?.error?.message);
    return { ok: true, message: 'Gemini connection succeeded.' };
  }

  return {
    id,
    name: 'Google Gemini',
    kind: 'api',
    needsKey: true,
    getStatus,
    listModels,
    getModelSpec,
    testConnection,
    summarize: ({ prompt, model }) => run({ prompt, model, normalize: normalizeSummary, responseSchema: SUMMARY_SCHEMA }),
    title: ({ prompt, model }) => run({ prompt, model, normalize: normalizeTitle, responseSchema: TITLE_SCHEMA })
  };
}

module.exports = { createGeminiAdapter, MODELS };
