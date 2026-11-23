/* ============================================
   MeetNote AI — Azure Speech STT adapter (file upload)
   Fast transcription REST: one synchronous multipart POST
   (audio + JSON definition) returns phrases with speaker
   diarization. Azure needs a key AND the resource region;
   the host is built only from a validated region id.
   ============================================ */

const { STT_ERROR, sttError, languageSetLocales } = require('../contracts');
const { fetchWithTimeout, httpErrorFor } = require('./http');

const API_VERSION = '2024-11-15';
// Fast transcription accepts audio under 2 hours and 250 MB.
const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
// One synchronous call covers the whole file, so allow far longer than the
// shared per-call timeout (a 2-hour recording can take several minutes).
const TRANSCRIBE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_SPEAKERS = 10;
// Speech authorization tokens from issueToken are valid for 10 minutes.
const TOKEN_LIFETIME_SECONDS = 600;

const MODELS = [{ id: 'fast', label: 'Fast transcription' }];

// Azure region ids are lowercase letters/digits (e.g. "southeastasia").
const REGION_PATTERN = /^[a-z0-9]{2,40}$/;

function normalizeRegion(value) {
  const region = String(value || '').trim().toLowerCase();
  return REGION_PATTERN.test(region) ? region : '';
}

// Azure expects a full BCP-47 locale ("km-KH"); "auto" means let Azure pick.
function toLocale(value) {
  if (!value || value === 'auto' || languageSetLocales(value).length) return '';
  const text = String(value);
  return text.includes('-') ? text : '';
}

function msToSeconds(value) {
  const ms = Number(value);
  return Number.isFinite(ms) ? Math.max(0, ms / 1000) : 0;
}

/**
 * @param {object} deps
 * @param {() => Promise<string>} deps.getKey resolves the Azure Speech key
 * @param {() => Promise<string>} deps.getRegion resolves the resource region id
 * @param {number} deps.timeoutMs per-HTTP-call timeout for short calls
 */
function createAzureAdapter(deps) {
  const { getKey, getRegion, timeoutMs } = deps;
  const id = 'azure';

  async function requireCredentials() {
    const key = (await getKey()) || '';
    if (!key) throw sttError(STT_ERROR.AUTH_REQUIRED, 'Azure Speech key is not configured.', { provider: id });
    const region = normalizeRegion(await getRegion());
    if (!region) {
      throw sttError(STT_ERROR.AUTH_REQUIRED, 'Azure Speech region is not configured (for example "southeastasia").', { provider: id });
    }
    return { key, region };
  }

  async function getStatus() {
    const hasKey = Boolean(await getKey());
    const hasRegion = Boolean(normalizeRegion(await getRegion()));
    const configured = hasKey && hasRegion;
    let message = 'Azure Speech key and region are configured.';
    if (!hasKey && !hasRegion) message = 'Add an Azure Speech key and region to enable this provider.';
    else if (!hasKey) message = 'Add an Azure Speech key to enable this provider.';
    else if (!hasRegion) message = 'Add the Azure Speech region (for example "southeastasia").';
    return { configured, available: configured, state: configured ? 'ready' : 'setup_required', message };
  }

  function listModels() {
    return MODELS;
  }

  // Exchanging the key for a short-lived token is the cheapest call that
  // proves both the key and the region are right; it bills no audio.
  async function testConnection() {
    const { key, region } = await requireCredentials();
    const response = await fetchWithTimeout(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Length': '0' },
      timeoutMs,
      provider: id,
      retryStaleConnection: true
    });
    if (!response.ok) throw await httpErrorFor(response, id, body => body?.error?.message);
    return { ok: true, message: `Azure Speech connection succeeded (${region}).` };
  }

  // Live recognition runs in the browser through the Speech SDK. It gets a
  // short-lived authorization token (valid 10 minutes), never the key itself;
  // the client refreshes it before it expires.
  async function grantTemporaryKey() {
    const { key, region } = await requireCredentials();
    const response = await fetchWithTimeout(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Length': '0' },
      timeoutMs,
      provider: id,
      retryStaleConnection: true
    });
    if (!response.ok) throw await httpErrorFor(response, id, body => body?.error?.message);
    const token = (await response.text()).trim();
    if (!token) throw sttError(STT_ERROR.PROVIDER_UNAVAILABLE, 'Azure Speech returned an empty token.', { provider: id });
    return { token, region, expiresInSeconds: TOKEN_LIFETIME_SECONDS };
  }

  async function postTranscription({ key, region, audio, definition }) {
    const form = new FormData();
    const blob = new Blob([audio.buffer], { type: audio.mimeType || 'application/octet-stream' });
    form.append('audio', blob, audio.filename || 'audio');
    form.append('definition', JSON.stringify(definition));
    return fetchWithTimeout(
      `https://${region}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=${API_VERSION}`,
      {
        method: 'POST',
        headers: { 'Ocp-Apim-Subscription-Key': key },
        body: form,
        timeoutMs: Math.max(timeoutMs, TRANSCRIBE_TIMEOUT_MS),
        provider: id
      }
    );
  }

  async function transcribe({ audio, language }) {
    const { key, region } = await requireCredentials();
    // One locale, or a language set's candidates (Azure picks per phrase).
    const locale = toLocale(language);
    const candidates = locale ? [locale] : languageSetLocales(language);
    const base = candidates.length ? { locales: candidates } : {};

    // Diarization is not offered for every locale; if Azure rejects the
    // request with it on, retry once without so the transcript still lands.
    let response = await postTranscription({
      key, region, audio,
      definition: { ...base, diarization: { enabled: true, maxSpeakers: MAX_SPEAKERS } }
    });
    if (response.status === 400 || response.status === 422) {
      response = await postTranscription({ key, region, audio, definition: base });
    }
    if (!response.ok) throw await httpErrorFor(response, id, body => body?.error?.message || body?.message);

    const body = await response.json().catch(() => ({}));
    const transcript = (Array.isArray(body?.phrases) ? body.phrases : []).map(phrase => ({
      text: String(phrase?.text || ''),
      time: msToSeconds(phrase?.offsetMilliseconds),
      speaker: Number.isFinite(Number(phrase?.speaker)) ? `Speaker ${Number(phrase.speaker)}` : 'Speaker',
      language: String(phrase?.locale || locale || '')
    }));

    return {
      transcript,
      translations: [],
      duration: msToSeconds(body?.durationMilliseconds),
      model: MODELS[0].id
    };
  }

  return {
    id,
    name: 'Azure Speech',
    kind: 'api',
    needsKey: true,
    needsRegion: true,
    supportsTranslation: false,
    supportsLive: true,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    getStatus,
    listModels,
    testConnection,
    transcribe,
    grantTemporaryKey
  };
}

module.exports = { createAzureAdapter, normalizeRegion, MODELS };
