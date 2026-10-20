/* ============================================
   MeetNote AI — OpenAI Whisper STT adapter (file upload)
   POST multipart audio to the transcriptions endpoint.
   whisper-1 returns verbose_json with per-segment
   timestamps; gpt-4o-* return plain text (one segment).
   No live streaming — Whisper is upload-only.
   ============================================ */

const { STT_ERROR, sttError } = require('../contracts');
const { fetchWithTimeout, httpErrorFor } = require('./http');

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // OpenAI hard limit

const MODELS = [
  { id: 'whisper-1', label: 'Whisper v1 (timestamps)', verbose: true },
  { id: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe', verbose: false },
  { id: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini Transcribe', verbose: false }
];

function toLangCode(value) {
  return value && value !== 'auto' ? String(value).split('-')[0].toLowerCase() : '';
}

/**
 * @param {object} deps
 * @param {() => Promise<string>} deps.getKey resolves the OpenAI API key
 * @param {number} deps.timeoutMs
 */
function createWhisperAdapter(deps) {
  const { getKey, timeoutMs } = deps;
  const id = 'whisper';

  function modelSpec(model) {
    return MODELS.find(m => m.id === model) || MODELS[0];
  }

  async function requireKey() {
    const key = (await getKey()) || '';
    if (!key) throw sttError(STT_ERROR.AUTH_REQUIRED, 'OpenAI API key is not configured.', { provider: id });
    return key;
  }

  async function getStatus() {
    const configured = Boolean(await getKey());
    return {
      configured,
      available: configured,
      state: configured ? 'ready' : 'setup_required',
      message: configured ? 'OpenAI API key is configured.' : 'Add an OpenAI API key to enable Whisper.'
    };
  }

  function listModels() {
    return MODELS.map(({ id: mid, label }) => ({ id: mid, label }));
  }

  async function testConnection() {
    const key = await requireKey();
    const response = await fetchWithTimeout('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      timeoutMs,
      provider: id
    });
    if (!response.ok) throw await httpErrorFor(response, id, body => body?.error?.message);
    return { ok: true, message: 'OpenAI connection succeeded.' };
  }

  async function transcribe({ audio, language, model }) {
    const key = await requireKey();
    if (audio.size > MAX_UPLOAD_BYTES) {
      throw sttError(STT_ERROR.AUDIO_TOO_LARGE, 'OpenAI Whisper accepts files up to 25 MB. Use a smaller recording or another provider.', { provider: id });
    }
    const spec = modelSpec(model);
    const lang = toLangCode(language);

    const form = new FormData();
    form.append('file', new File([audio.buffer], audio.filename || 'audio', { type: audio.mimeType || 'application/octet-stream' }));
    form.append('model', spec.id);
    if (lang) form.append('language', lang);
    if (spec.verbose) {
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'segment');
    } else {
      form.append('response_format', 'json');
    }

    const response = await fetchWithTimeout(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      timeoutMs,
      provider: id
    });
    if (!response.ok) throw await httpErrorFor(response, id, body => body?.error?.message);

    const body = await response.json().catch(() => ({}));
    const detected = body?.language || lang || '';

    let transcript;
    if (spec.verbose && Array.isArray(body?.segments)) {
      transcript = body.segments
        .map(segment => ({
          text: String(segment?.text || '').trim(),
          time: Number(segment?.start) || 0,
          speaker: 'Speaker',
          language: detected
        }))
        .filter(segment => segment.text);
    } else {
      // gpt-4o-* return plain text with no timestamps — one segment.
      const text = String(body?.text || '').trim();
      transcript = text ? [{ text, time: 0, speaker: 'Speaker', language: detected }] : [];
    }

    return {
      transcript,
      translations: [],
      duration: Number(body?.duration) || 0,
      model: spec.id
    };
  }

  return { id, name: 'OpenAI Whisper', kind: 'api', needsKey: true, supportsTranslation: false, maxUploadBytes: MAX_UPLOAD_BYTES, getStatus, listModels, testConnection, transcribe };
}

module.exports = { createWhisperAdapter, MODELS };
