/* ============================================
   MeetNote AI — Deepgram STT adapter (file upload)
   Prerecorded REST: POST raw audio, get word-level
   results with speaker diarization + language detection.
   Endpoint host is a fixed constant.
   ============================================ */

const { STT_ERROR, sttError, groupWordsIntoSegments } = require('../contracts');
const { fetchWithTimeout, httpErrorFor } = require('./http');

const ENDPOINT = 'https://api.deepgram.com/v1/listen';
// Prerecorded audio is read fully into memory and posted as the request body;
// cap it to keep the Node process healthy (Deepgram itself allows more).
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB

// nova-3 first: it supports `language=multi` (reliable multilingual/code-switch),
// which we use for auto-detect. nova-2 only has per-utterance detect_language.
const MODELS = [
  { id: 'nova-3', label: 'Nova 3' },
  { id: 'nova-2', label: 'Nova 2' },
  { id: 'whisper-large', label: 'Whisper Large (Deepgram)' }
];

function toLangCode(value) {
  return value && value !== 'auto' ? String(value).split('-')[0].toLowerCase() : '';
}

/**
 * @param {object} deps
 * @param {() => Promise<string>} deps.getKey resolves the Deepgram API key
 * @param {number} deps.timeoutMs
 */
function createDeepgramAdapter(deps) {
  const { getKey, timeoutMs } = deps;
  const id = 'deepgram';

  function modelId(model) {
    return MODELS.some(m => m.id === model) ? model : MODELS[0].id;
  }

  async function requireKey() {
    const key = (await getKey()) || '';
    if (!key) throw sttError(STT_ERROR.AUTH_REQUIRED, 'Deepgram API key is not configured.', { provider: id });
    return key;
  }

  async function getStatus() {
    const configured = Boolean(await getKey());
    return {
      configured,
      available: configured,
      state: configured ? 'ready' : 'setup_required',
      message: configured ? 'Deepgram API key is configured.' : 'Add a Deepgram API key to enable this provider.'
    };
  }

  function listModels() {
    return MODELS;
  }

  async function testConnection() {
    const key = await requireKey();
    const response = await fetchWithTimeout('https://api.deepgram.com/v1/projects', {
      method: 'GET',
      headers: { Authorization: `Token ${key}` },
      timeoutMs,
      provider: id
    });
    if (!response.ok) throw await httpErrorFor(response, id, body => body?.err_msg || body?.reason);
    return { ok: true, message: 'Deepgram connection succeeded.' };
  }

  // Mint a short-lived token for the browser to open the live WebSocket with,
  // so the raw API key never reaches the client. The token is passed to
  // Deepgram as the wss `access_token` query param.
  async function grantTemporaryKey() {
    const key = await requireKey();
    const response = await fetchWithTimeout('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl_seconds: 60 }),
      timeoutMs,
      provider: id
    });
    if (!response.ok) {
      // A 403 here means the key is valid but lacks permission to mint tokens —
      // live streaming needs a Member-role key, not a usage-only key.
      if (response.status === 403) {
        throw sttError(STT_ERROR.AUTH_INVALID, 'This Deepgram key cannot create live-streaming tokens. Use a key with the Member role (Deepgram console → API Keys). Upload transcription still works with this key.', { provider: id, statusCode: 403 });
      }
      throw await httpErrorFor(response, id, body => body?.err_msg || body?.reason);
    }
    const body = await response.json().catch(() => ({}));
    if (!body.access_token) {
      throw sttError(STT_ERROR.PROVIDER_UNAVAILABLE, 'Deepgram did not return a temporary token.', { provider: id });
    }
    const ttl = Number(body.expires_in) || 60;
    return { apiKey: body.access_token, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }

  async function transcribe({ audio, language, model }) {
    const key = await requireKey();
    const resolvedModel = modelId(model);
    const params = new URLSearchParams({
      model: resolvedModel,
      smart_format: 'true',
      punctuate: 'true',
      diarize: 'true'
    });
    // Language handling: an explicit hint wins. For auto-detect, nova-3's
    // `language=multi` is far more reliable than nova-2's detect_language,
    // which frequently mis-detects and returns an empty transcript.
    const lang = toLangCode(language);
    if (lang) params.set('language', lang);
    else if (resolvedModel === 'nova-3') params.set('language', 'multi');
    else params.set('detect_language', 'true');

    const response = await fetchWithTimeout(`${ENDPOINT}?${params.toString()}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${key}`,
        'Content-Type': audio.mimeType || 'application/octet-stream'
      },
      body: audio.buffer,
      timeoutMs,
      provider: id
    });
    if (!response.ok) throw await httpErrorFor(response, id, body => body?.err_msg || body?.reason);

    const body = await response.json().catch(() => ({}));
    const alternative = body?.results?.channels?.[0]?.alternatives?.[0];
    const detectedLanguage = body?.results?.channels?.[0]?.detected_language || lang || '';
    const words = (alternative?.words || []).map(word => ({
      text: word.punctuated_word || word.word || '',
      start: Number(word.start) || 0,
      speaker: Number.isFinite(Number(word.speaker)) ? `Speaker ${Number(word.speaker) + 1}` : '',
      language: detectedLanguage
    }));

    return {
      transcript: groupWordsIntoSegments(words, false),
      translations: [],
      duration: Number(body?.metadata?.duration) || 0,
      model: modelId(model)
    };
  }

  return { id, name: 'Deepgram', kind: 'api', needsKey: true, supportsTranslation: false, supportsLive: true, maxUploadBytes: MAX_UPLOAD_BYTES, getStatus, listModels, testConnection, transcribe, grantTemporaryKey };
}

module.exports = { createDeepgramAdapter, MODELS };
