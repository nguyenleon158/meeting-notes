/* ============================================
   MeetNote AI — STT shared contracts
   Typed errors + the single transcript shape every
   speech-to-text adapter must return, so the app never
   learns a provider's raw response format.
   ============================================ */

// Stable machine-readable error codes shared with the client.
const STT_ERROR = {
  PROVIDER_NOT_FOUND: 'STT_PROVIDER_NOT_FOUND',
  MODEL_NOT_SUPPORTED: 'STT_MODEL_NOT_SUPPORTED',
  AUTH_REQUIRED: 'STT_AUTH_REQUIRED',
  AUTH_INVALID: 'STT_AUTH_INVALID',
  RATE_LIMITED: 'STT_RATE_LIMITED',
  TIMEOUT: 'STT_TIMEOUT',
  AUDIO_TOO_LARGE: 'STT_AUDIO_TOO_LARGE',
  UNSUPPORTED_AUDIO: 'STT_UNSUPPORTED_AUDIO',
  TRANSCRIBE_FAILED: 'STT_TRANSCRIBE_FAILED',
  PROVIDER_UNAVAILABLE: 'STT_PROVIDER_UNAVAILABLE'
};

const STATUS_BY_CODE = {
  [STT_ERROR.PROVIDER_NOT_FOUND]: 404,
  [STT_ERROR.MODEL_NOT_SUPPORTED]: 400,
  [STT_ERROR.AUTH_REQUIRED]: 401,
  [STT_ERROR.AUTH_INVALID]: 401,
  [STT_ERROR.RATE_LIMITED]: 429,
  [STT_ERROR.TIMEOUT]: 504,
  [STT_ERROR.AUDIO_TOO_LARGE]: 413,
  [STT_ERROR.UNSUPPORTED_AUDIO]: 422,
  [STT_ERROR.TRANSCRIBE_FAILED]: 422,
  [STT_ERROR.PROVIDER_UNAVAILABLE]: 502
};

const RETRYABLE_CODES = new Set([
  STT_ERROR.RATE_LIMITED,
  STT_ERROR.TIMEOUT,
  STT_ERROR.PROVIDER_UNAVAILABLE
]);

/**
 * Build a typed STT error. `llmCode` is set (not a typo) so the server's
 * shared error envelope — {error:{code,message,provider,retryable}} — renders
 * it the same way it does LLM errors.
 */
function sttError(code, message, meta = {}) {
  const error = new Error(message);
  error.llmCode = code;
  error.provider = meta.provider || '';
  error.retryable = meta.retryable ?? RETRYABLE_CODES.has(code);
  error.statusCode = meta.statusCode || STATUS_BY_CODE[code] || 502;
  return error;
}

function tagProvider(error, provider) {
  if (error && error.llmCode && !error.provider) error.provider = provider;
  return error;
}

function cleanSegmentText(value) {
  return typeof value === 'string' ? value.trim().slice(0, 20000) : '';
}

function normalizeSegments(segments, fallbackSpeaker) {
  if (!Array.isArray(segments)) return [];
  return segments
    .map(segment => ({
      text: cleanSegmentText(segment?.text),
      time: Number.isFinite(Number(segment?.time)) ? Math.max(0, Number(segment.time)) : 0,
      speaker: typeof segment?.speaker === 'string' && segment.speaker ? segment.speaker.slice(0, 200) : fallbackSpeaker,
      language: typeof segment?.language === 'string' ? segment.language.slice(0, 20) : ''
    }))
    .filter(segment => segment.text);
}

/**
 * Coerce an adapter's raw output into the canonical transcript contract.
 * @returns {{transcript:Array,translations:Array,duration:number,model:string,provider:string}}
 */
function normalizeResult(raw, provider) {
  const transcript = normalizeSegments(raw?.transcript, 'Speaker');
  if (transcript.length === 0) {
    throw sttError(STT_ERROR.TRANSCRIBE_FAILED, 'The provider did not return any transcript for this audio.', { provider });
  }
  return {
    transcript,
    translations: normalizeSegments(raw?.translations, 'Translation'),
    duration: Number.isFinite(Number(raw?.duration)) ? Math.max(0, Math.round(Number(raw.duration))) : 0,
    model: typeof raw?.model === 'string' ? raw.model.slice(0, 100) : '',
    provider
  };
}

/**
 * Group word-level results ({ text, start, speaker, language }) into readable
 * segments, breaking on speaker change, sentence end, or a 20s span. Shared by
 * word-timestamp providers (Deepgram, Google diarization).
 */
function groupWordsIntoSegments(words, translation = false) {
  const segments = [];
  let current = null;
  const fallback = translation ? 'Translation' : 'Speaker';

  const flush = () => {
    const text = current?.text.trim();
    if (text) {
      segments.push({ text, time: current.start, speaker: current.speaker || fallback, language: current.language || '' });
    }
    current = null;
  };

  for (const word of words) {
    const token = String(word?.text || '').trim();
    if (!token) continue;
    const speaker = word.speaker ? String(word.speaker) : '';
    const start = Number.isFinite(Number(word.start)) ? Math.max(0, Number(word.start)) : 0;
    const language = word.language || '';

    if (current && speaker && current.speaker && speaker !== current.speaker) flush();
    if (!current) current = { text: '', start, speaker, language };
    current.text += (current.text ? ' ' : '') + token;
    if (/[.!?。！？]$/.test(token) || start - current.start >= 20) flush();
  }
  flush();
  return segments;
}

module.exports = {
  STT_ERROR,
  RETRYABLE_CODES,
  sttError,
  tagProvider,
  normalizeResult,
  groupWordsIntoSegments
};
