/* ============================================
   MeetNote AI — Soniox STT adapter (file upload)
   Async transcription: upload file → poll → fetch tokens.
   Ported from the original server.js Soniox path; the
   live websocket path stays in the browser transcriber.
   ============================================ */

const { STT_ERROR, sttError } = require('../contracts');

const API_BASE = 'https://api.soniox.com/v1';
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

const MODELS = [{ id: 'stt-async-v5', label: 'Soniox Async v5' }];

async function sonioxJson(apiKey, pathname, options = {}) {
  const response = await fetch(`${API_BASE}${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${apiKey}`, ...(options.headers || {}) }
  });
  const content = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = content.message || content.error_message || `Soniox request failed (${response.status})`;
    if (response.status === 401 || response.status === 403) {
      throw sttError(STT_ERROR.AUTH_INVALID, 'Soniox rejected the API key.', { provider: 'soniox' });
    }
    throw sttError(response.status >= 500 ? STT_ERROR.PROVIDER_UNAVAILABLE : STT_ERROR.TRANSCRIBE_FAILED, message, { provider: 'soniox' });
  }
  return content;
}

// Group Soniox tokens (streamed characters with speaker/language) into segments.
function buildSegments(tokens, translation = false) {
  const segments = [];
  let current = null;
  const flush = () => {
    const text = current?.text.trim();
    if (text) {
      segments.push({
        text,
        time: (current.startMs || 0) / 1000,
        speaker: current.speaker ? `Speaker ${current.speaker}` : (translation ? 'Translation' : 'Speaker'),
        language: current.language || ''
      });
    }
    current = null;
  };

  for (const token of tokens) {
    const isTranslation = token?.translation_status === 'translation';
    if (isTranslation !== translation || !token?.text) continue;
    const speaker = token.speaker || '';
    const language = token.language || token.source_language || '';
    const startMs = Number(token.start_ms) || Number(token.end_ms) || 0;
    const endMs = Number(token.end_ms) || startMs;
    if (current && ((speaker && current.speaker && speaker !== current.speaker) ||
      (language && current.language && language !== current.language))) flush();
    if (!current) current = { text: '', startMs, endMs, speaker, language };
    current.text += token.text;
    current.endMs = endMs;
    if (/[.!?。！？]\s*$/.test(current.text) || current.endMs - current.startMs >= 20_000) flush();
  }
  flush();
  return segments;
}

function toLangCode(value) {
  return value && value !== 'auto' ? String(value).split('-')[0].toLowerCase() : '';
}

/**
 * @param {object} deps
 * @param {() => Promise<string>} deps.getKey resolves the Soniox API key
 */
function createSonioxAdapter(deps) {
  const { getKey } = deps;
  const id = 'soniox';

  async function requireKey() {
    const key = (await getKey()) || '';
    if (!key) throw sttError(STT_ERROR.AUTH_REQUIRED, 'Soniox API key is not configured.', { provider: id });
    return key;
  }

  async function getStatus() {
    const configured = Boolean(await getKey());
    return {
      configured,
      available: configured,
      state: configured ? 'ready' : 'setup_required',
      message: configured ? 'Soniox API key is configured.' : 'Add a Soniox API key to enable this provider.'
    };
  }

  function listModels() {
    return MODELS;
  }

  async function testConnection() {
    const key = await requireKey();
    // Any authenticated call validates the key; list transcriptions is cheap.
    await sonioxJson(key, '/transcriptions?limit=1').catch(error => {
      if (error.llmCode === STT_ERROR.AUTH_INVALID) throw error;
      // Endpoint shape differences shouldn't fail a valid key.
    });
    return { ok: true, message: 'Soniox connection succeeded.' };
  }

  async function transcribe({ audio, language, translationLanguage }) {
    const apiKey = await requireKey();
    if (audio.size > MAX_UPLOAD_BYTES) {
      throw sttError(STT_ERROR.AUDIO_TOO_LARGE, 'Audio upload must be smaller than 500 MB.', { provider: id });
    }

    const filename = audio.filename || `audio.${audio.mimeType?.includes('webm') ? 'webm' : 'audio'}`;
    const form = new FormData();
    form.append('file', new File([audio.buffer], filename, { type: audio.mimeType || 'application/octet-stream' }));

    let fileId = '';
    let transcriptionId = '';
    try {
      const uploaded = await sonioxJson(apiKey, '/files', { method: 'POST', body: form });
      fileId = uploaded.id;

      const sourceLanguage = toLangCode(language);
      const targetLanguage = toLangCode(translationLanguage);
      const config = {
        model: 'stt-async-v5',
        file_id: fileId,
        enable_language_identification: true,
        enable_speaker_diarization: true,
        ...(sourceLanguage ? { language_hints: [sourceLanguage] } : {}),
        ...(targetLanguage && targetLanguage !== sourceLanguage
          ? { translation: { type: 'one_way', target_language: targetLanguage } }
          : {})
      };
      const created = await sonioxJson(apiKey, '/transcriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      transcriptionId = created.id;

      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let job = created;
      while (!['completed', 'error'].includes(job.status)) {
        if (Date.now() >= deadline) throw sttError(STT_ERROR.TIMEOUT, 'Soniox transcription timed out.', { provider: id });
        await new Promise(resolve => setTimeout(resolve, 2000));
        job = await sonioxJson(apiKey, `/transcriptions/${encodeURIComponent(transcriptionId)}`);
      }
      if (job.status === 'error') {
        throw sttError(STT_ERROR.TRANSCRIBE_FAILED, job.error_message || 'Soniox could not transcribe this audio file.', { provider: id });
      }

      const result = await sonioxJson(apiKey, `/transcriptions/${encodeURIComponent(transcriptionId)}/transcript`);
      const tokens = Array.isArray(result.tokens) ? result.tokens : [];
      return {
        transcript: buildSegments(tokens, false),
        translations: buildSegments(tokens, true),
        duration: Math.max(0, Math.round((Number(job.audio_duration_ms) || 0) / 1000)),
        model: job.model || 'stt-async-v5'
      };
    } finally {
      if (transcriptionId) {
        await sonioxJson(apiKey, `/transcriptions/${encodeURIComponent(transcriptionId)}`, { method: 'DELETE' }).catch(() => {});
      }
      if (fileId) {
        await sonioxJson(apiKey, `/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' }).catch(() => {});
      }
    }
  }

  return { id, name: 'Soniox', kind: 'api', needsKey: true, supportsTranslation: true, supportsLive: true, maxUploadBytes: MAX_UPLOAD_BYTES, getStatus, listModels, testConnection, transcribe };
}

module.exports = { createSonioxAdapter };
