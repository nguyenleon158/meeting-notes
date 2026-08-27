/* ============================================
   MeetNote AI — LLM service & provider registry
   The single surface server.js talks to. Routes never
   learn any provider's request/response details.
   Owns prompt building, long-transcript map→reduce
   summarization, per-provider queuing and retries.
   ============================================ */

const { LLM_ERROR, llmError, tagProvider, withRetry } = require('./contracts');
const {
  PROMPT_VERSION, languageName,
  buildSummaryPrompt, buildTitlePrompt, buildChunkPrompt, buildSynthesisPrompt
} = require('./prompts');
const { estimateTokens, inputBudget, chunkTranscript } = require('./transcript-budget');
const { createCodexAdapter } = require('./providers/codex');
const { createDeepSeekAdapter } = require('./providers/deepseek');
const { createGeminiAdapter } = require('./providers/gemini');

const DEFAULT_PROVIDER = 'codex';

// Keychain account + dev env var per API provider.
const SECRET_CONFIG = {
  deepseek: { account: 'deepseek-api-key', envKey: 'DEEPSEEK_API_KEY' },
  gemini: { account: 'gemini-api-key', envKey: 'GEMINI_API_KEY' }
};

// Long-transcript chunking guard rails.
const MAX_CHUNKS = 40;            // beyond this, reduce step won't fit — fail clearly
const MIN_CHUNK_TOKENS = 2000;    // floor so tiny budgets still make progress
const CHUNK_SCAFFOLD_TOKENS = 2000; // reserve for chunk prompt template + output

/**
 * @param {object} deps
 * @param {Function} deps.runProcess shared child-process runner
 * @param {Function} deps.resolveCodexBinary
 * @param {string} deps.summarySchemaFile
 * @param {string} deps.titleSchemaFile
 * @param {number} deps.apiTimeoutMs
 * @param {number} deps.codexTimeoutMs
 * @param {{read:Function, write:Function, remove:Function}} deps.secretStore Keychain access
 * @param {() => Promise<object>} deps.getSettings reads persisted settings.json
 */
function createLlmService(deps) {
  const {
    runProcess, resolveCodexBinary, summarySchemaFile, titleSchemaFile,
    apiTimeoutMs, codexTimeoutMs, secretStore, getSettings
  } = deps;

  // Resolve an API provider's key from env (dev) or Keychain.
  const makeGetKey = providerId => async () => {
    const config = SECRET_CONFIG[providerId];
    if (!config) return '';
    const fromEnv = (process.env[config.envKey] || '').trim();
    if (fromEnv) return fromEnv;
    return (await secretStore.read(config.account)) || '';
  };

  const adapters = {
    codex: createCodexAdapter({ runProcess, resolveCodexBinary, summarySchemaFile, titleSchemaFile, timeoutMs: codexTimeoutMs }),
    deepseek: createDeepSeekAdapter({ getKey: makeGetKey('deepseek'), timeoutMs: apiTimeoutMs }),
    gemini: createGeminiAdapter({ getKey: makeGetKey('gemini'), timeoutMs: apiTimeoutMs })
  };
  const ORDER = ['codex', 'deepseek', 'gemini'];

  // One serial queue per provider (concurrency 1) so we never run parallel
  // Codex processes or hammer an API provider from concurrent requests.
  const queues = {};
  function enqueue(providerId, task) {
    const prev = queues[providerId] || Promise.resolve();
    const job = prev.then(task, task);
    queues[providerId] = job.catch(() => {});
    return job;
  }

  // Retry transient failures for API providers only; CLI errors aren't transient.
  function callAdapter(adapter, thunk) {
    return adapter.kind === 'api' ? withRetry(thunk, { retries: 2 }) : thunk();
  }

  function getAdapter(providerId) {
    const adapter = adapters[providerId];
    if (!adapter) {
      throw llmError(LLM_ERROR.PROVIDER_NOT_FOUND, `Unknown provider "${providerId}".`, { provider: providerId });
    }
    return adapter;
  }

  // Validate a requested model against the provider allowlist; fall back to a
  // sensible default (settings value, else first allowlisted model).
  function resolveModel(adapter, requestedModel, settings) {
    const ids = adapter.listModels().map(model => model.id);
    if (requestedModel) {
      if (!ids.includes(requestedModel)) {
        throw llmError(LLM_ERROR.MODEL_NOT_SUPPORTED, `Model "${requestedModel}" is not supported for ${adapter.name}.`, { provider: adapter.id });
      }
      return requestedModel;
    }
    const preferred = settings?.llmModels?.[adapter.id];
    if (preferred && ids.includes(preferred)) return preferred;
    return ids[0];
  }

  async function resolveDefaultProvider(settings) {
    const candidate = settings?.llmProvider;
    return candidate && adapters[candidate] ? candidate : DEFAULT_PROVIDER;
  }

  function buildGeneration(providerId, model, usage) {
    return {
      provider: providerId,
      model,
      promptVersion: PROMPT_VERSION,
      generatedAt: new Date().toISOString(),
      inputTokens: Number(usage?.inputTokens) || 0,
      outputTokens: Number(usage?.outputTokens) || 0,
      estimatedCostUsd: null
    };
  }

  // Single-pass when the transcript fits the model budget, otherwise a
  // map→reduce over time-ordered chunks. Returns { data, usage, model }.
  // `outputLanguage` forces the summary language ('' = the meeting's language).
  async function summarizeMeeting(adapter, model, meeting, outputLanguage) {
    const budget = inputBudget(adapter.getModelSpec(model).contextWindow);
    const fullPrompt = buildSummaryPrompt(meeting, outputLanguage);
    if (!budget || estimateTokens(fullPrompt) <= budget) {
      return callAdapter(adapter, () => adapter.summarize({ prompt: fullPrompt, model }));
    }

    const maxChunkTokens = Math.max(MIN_CHUNK_TOKENS, budget - CHUNK_SCAFFOLD_TOKENS);
    const chunks = chunkTranscript(meeting.transcript, maxChunkTokens);
    if (chunks.length > MAX_CHUNKS) {
      throw llmError(LLM_ERROR.CONTEXT_TOO_LARGE, 'This transcript is too long for the selected model even after splitting. Choose a model with a larger context window.', { provider: adapter.id });
    }

    const usage = { inputTokens: 0, outputTokens: 0 };
    const addUsage = result => {
      usage.inputTokens += Number(result.usage?.inputTokens) || 0;
      usage.outputTokens += Number(result.usage?.outputTokens) || 0;
    };

    const partials = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const prompt = buildChunkPrompt(meeting, chunks[i], i + 1, chunks.length, outputLanguage);
      const result = await callAdapter(adapter, () => adapter.summarize({ prompt, model }));
      partials.push(result.data);
      addUsage(result);
    }

    const synthesisPrompt = buildSynthesisPrompt(meeting, partials, outputLanguage);
    if (estimateTokens(synthesisPrompt) > budget) {
      throw llmError(LLM_ERROR.CONTEXT_TOO_LARGE, 'The meeting produced too many notes to consolidate for this model. Choose a model with a larger context window.', { provider: adapter.id });
    }
    const finalResult = await callAdapter(adapter, () => adapter.summarize({ prompt: synthesisPrompt, model }));
    addUsage(finalResult);
    return { data: finalResult.data, usage, model };
  }

  async function titleMeeting(adapter, model, meeting) {
    const budget = inputBudget(adapter.getModelSpec(model).contextWindow);
    const prompt = buildTitlePrompt(meeting);
    if (budget && estimateTokens(prompt) > budget) {
      throw llmError(LLM_ERROR.CONTEXT_TOO_LARGE, 'This transcript is too long for the selected model. Choose a model with a larger context window.', { provider: adapter.id });
    }
    return callAdapter(adapter, () => adapter.title({ prompt, model }));
  }

  async function selection({ providerId, modelId }) {
    const settings = await getSettings();
    const resolvedProvider = providerId || await resolveDefaultProvider(settings);
    const adapter = getAdapter(resolvedProvider);
    const model = resolveModel(adapter, modelId, settings);
    return { adapter, model };
  }

  async function generateSummary({ providerId, modelId, meeting, language }) {
    const { adapter, model } = await selection({ providerId, modelId });
    const outputLanguage = languageName(language);
    const result = await enqueue(adapter.id, () =>
      summarizeMeeting(adapter, model, meeting, outputLanguage).catch(error => { throw tagProvider(error, adapter.id); }));
    const generation = buildGeneration(adapter.id, model, result.usage);
    generation.language = outputLanguage || 'auto';
    return { data: result.data, generation };
  }

  async function suggestTitle({ providerId, modelId, meeting }) {
    const { adapter, model } = await selection({ providerId, modelId });
    const result = await enqueue(adapter.id, () =>
      titleMeeting(adapter, model, meeting).catch(error => { throw tagProvider(error, adapter.id); }));
    return { data: result.data, generation: buildGeneration(adapter.id, model, result.usage) };
  }

  // Safe metadata for GET /api/llm/providers — never returns secrets.
  async function listProviders() {
    const settings = await getSettings();
    const defaultProvider = await resolveDefaultProvider(settings);
    const providers = await Promise.all(ORDER.map(async providerId => {
      const adapter = adapters[providerId];
      const status = await adapter.getStatus().catch(error => ({
        configured: false,
        available: false,
        state: 'unavailable',
        message: error.message || 'Status check failed.'
      }));
      return {
        id: adapter.id,
        name: adapter.name,
        kind: adapter.kind,
        needsKey: adapter.needsKey,
        configured: Boolean(status.configured),
        available: Boolean(status.available),
        state: status.state || (status.available ? 'ready' : 'setup_required'),
        message: status.message || '',
        method: status.method || '',
        models: adapter.listModels(),
        selectedModel: resolveModel(adapter, settings?.llmModels?.[adapter.id], settings)
      };
    }));
    return { defaultProvider, providers };
  }

  function requireApiProvider(providerId) {
    const config = SECRET_CONFIG[providerId];
    if (!adapters[providerId]) {
      throw llmError(LLM_ERROR.PROVIDER_NOT_FOUND, `Unknown provider "${providerId}".`, { provider: providerId });
    }
    if (!config) {
      throw llmError(LLM_ERROR.MODEL_NOT_SUPPORTED, `${providerId} does not use an API key.`, { provider: providerId });
    }
    return config;
  }

  async function saveKey(providerId, apiKey) {
    const config = requireApiProvider(providerId);
    await secretStore.write(config.account, apiKey);
  }

  async function removeKey(providerId) {
    const config = requireApiProvider(providerId);
    await secretStore.remove(config.account);
  }

  async function testConnection(providerId) {
    const adapter = getAdapter(providerId);
    try {
      return await adapter.testConnection();
    } catch (error) {
      throw tagProvider(error, providerId);
    }
  }

  return {
    listProviders,
    generateSummary,
    suggestTitle,
    saveKey,
    removeKey,
    testConnection
  };
}

module.exports = { createLlmService, DEFAULT_PROVIDER, SECRET_CONFIG };
