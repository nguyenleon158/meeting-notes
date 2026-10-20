/* ============================================
   MeetNote AI — Google Speech-to-Text adapter (file upload)
   Uses longRunningRecognize with inline base64 audio and
   an API key. Inline payloads are capped (~10 MB): larger
   audio needs a GCS URI + service account, which the simple
   API-key path here does not cover — callers get a clear
   AUDIO_TOO_LARGE error instead of a silent failure.
   ============================================ */

const { STT_ERROR, sttError, groupWordsIntoSegments } = require('../contracts');
const { fetchWithTimeout, httpErrorFor } = require('./http');

const API_HOST = 'https://speech.googleapis.com/v1';
const MAX_INLINE_BYTES = 10 * 1024 * 1024;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

const MODELS = [
  { id: 'latest_long', label: 'Latest (long-form)' },
  { id: 'latest_short', label: 'Latest (short)' }
];

// Map the recorded container to a Google encoding, or null if unsupported.
function encodingForMime(mimeType) {
  const type = String(mimeType || '').toLowerCase();
  if (type.includes('webm')) return 'WEBM_OPUS';
  if (type.includes('ogg')) return 'OGG_OPUS';
  if (type.includes('mp3') || type.includes('mpeg')) return 'MP3';
  if (type.includes('wav') || type.includes('flac')) return type.includes('flac') ? 'FLAC' : 'LINEAR16';
  return null; // m4a/mp4/aac are not accepted by Google STT directly
}

function primaryLanguage(value) {
  if (value && value !== 'auto') return value.includes('-') ? value : `${value}-${value.toUpperCase()}`;
  return 'en-US';
}

/**
 * @param {object} deps
 * @param {() => Promise<string>} deps.getKey resolves the Google API key
 * @param {number} deps.timeoutMs per-HTTP-call timeout
 */
function createGoogleAdapter(deps) {
  const { getKey, timeoutMs } = deps;
  const id = 'google';

  function modelId(model) {
    return MODELS.some(m => m.id === model) ? model : MODELS[0].id;
  }

  async function requireKey() {
    const key = (await getKey()) || '';
    if (!key) throw sttError(STT_ERROR.AUTH_REQUIRED, 'Google API key is not configured.', { provider: id });
    return key;
  }

  async function getStatus() {
    const configured = Boolean(await getKey());
    return {
      configured,
      available: configured,
      state: configured ? 'ready' : 'setup_required',
      message: configured ? 'Google API key is configured.' : 'Add a Google API key to enable this provider.'
    };
  }

  function listModels() {
    return MODELS;
  }

  function authHeaders(key, json = true) {
    return { 'x-goog-api-key': key, ...(json ? { 'Content-Type': 'application/json' } : {}) };
  }

  async function testConnection() {
    const key = await requireKey();
    // An empty recognize request returns 400 for a valid key, 401/403 for a bad one.
    const response = await fetchWithTimeout(`${API_HOST}/speech:recognize`, {
      headers: authHeaders(key),
      body: JSON.stringify({ config: { languageCode: 'en-US' }, audio: { content: '' } }),
      timeoutMs,
      provider: id
    });
    if (response.status === 401 || response.status === 403) {
      throw sttError(STT_ERROR.AUTH_INVALID, 'Google rejected the API key.', { provider: id });
    }
    return { ok: true, message: 'Google connection succeeded.' };
  }

  async function transcribe({ audio, language, model }) {
    const key = await requireKey();
    if (audio.size > MAX_INLINE_BYTES) {
      throw sttError(STT_ERROR.AUDIO_TOO_LARGE, 'Google inline transcription supports files up to about 10 MB. Use a smaller recording or another provider.', { provider: id });
    }
    const encoding = encodingForMime(audio.mimeType);
    if (!encoding) {
      throw sttError(STT_ERROR.UNSUPPORTED_AUDIO, 'Google Speech-to-Text does not support this audio format. Use WebM/Opus, MP3, OGG, WAV or FLAC.', { provider: id });
    }

    const config = {
      encoding,
      languageCode: primaryLanguage(language),
      enableAutomaticPunctuation: true,
      enableWordTimeOffsets: true,
      diarizationConfig: { enableSpeakerDiarization: true },
      model: modelId(model)
    };

    const start = await fetchWithTimeout(`${API_HOST}/speech:longrunningrecognize`, {
      headers: authHeaders(key),
      body: JSON.stringify({ config, audio: { content: audio.buffer.toString('base64') } }),
      timeoutMs,
      provider: id
    });
    if (!start.ok) throw await httpErrorFor(start, id, body => body?.error?.message);
    const operation = await start.json().catch(() => ({}));
    const operationName = operation?.name;
    if (!operationName || typeof operationName !== 'string') {
      throw sttError(STT_ERROR.TRANSCRIBE_FAILED, 'Google did not start the transcription job.', { provider: id });
    }
    // Google returns a bare id or a full ".../operations/{id}" name; take the id
    // so the polling path is `/v1/operations/{id}`, not a doubled/encoded path.
    const operationId = operationName.split('/').pop();

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let job = operation;
    while (!job.done) {
      if (Date.now() >= deadline) throw sttError(STT_ERROR.TIMEOUT, 'Google transcription timed out.', { provider: id });
      await new Promise(resolve => setTimeout(resolve, 3000));
      const poll = await fetchWithTimeout(`${API_HOST}/operations/${encodeURIComponent(operationId)}`, {
        method: 'GET',
        headers: authHeaders(key, false),
        timeoutMs,
        provider: id
      });
      if (!poll.ok) throw await httpErrorFor(poll, id, body => body?.error?.message);
      job = await poll.json().catch(() => ({}));
    }
    if (job.error) {
      throw sttError(STT_ERROR.TRANSCRIBE_FAILED, job.error.message || 'Google could not transcribe this audio.', { provider: id });
    }

    // Diarized word tags land on the final result; fall back to per-result words.
    const results = job?.response?.results || [];
    const words = [];
    for (const result of results) {
      for (const word of result?.alternatives?.[0]?.words || []) {
        words.push({
          text: word.word || '',
          start: parseFloat(String(word.startTime || '0').replace('s', '')) || 0,
          speaker: word.speakerTag ? `Speaker ${word.speakerTag}` : '',
          language: config.languageCode
        });
      }
    }

    return {
      transcript: groupWordsIntoSegments(words, false),
      translations: [],
      duration: words.length ? Math.round(words[words.length - 1].start) : 0,
      model: modelId(model)
    };
  }

  return { id, name: 'Google Speech-to-Text', kind: 'api', needsKey: true, supportsTranslation: false, maxUploadBytes: MAX_INLINE_BYTES, getStatus, listModels, testConnection, transcribe };
}

module.exports = { createGoogleAdapter, MODELS };
