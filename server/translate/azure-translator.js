/* ============================================
   MeetNote AI — Azure Translator (text) client
   Translates transcript text into a target language
   for providers that cannot translate themselves, and
   for live captions into languages Soniox lacks (e.g.
   Vietnamese speech → Khmer text). Translate API v3.
   ============================================ */

const { STT_ERROR, sttError } = require('../stt/contracts');
const { fetchWithTimeout, httpErrorFor } = require('../stt/providers/http');

const ENDPOINT = 'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0';
const PROVIDER = 'azure-translator';
// Service limits per request: 1,000 array items and 50,000 characters.
const MAX_ITEMS_PER_REQUEST = 1000;
const MAX_CHARS_PER_REQUEST = 50000;
// Azure resource regions are lowercase letters/digits; "global" is valid too.
const REGION_PATTERN = /^[a-z0-9]{2,40}$/;

// App language codes that Translator spells differently.
const TRANSLATOR_CODES = { zh: 'zh-Hans', 'zh-cn': 'zh-Hans', 'zh-tw': 'zh-Hant' };
const TARGET_PATTERN = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

function toTranslatorCode(value) {
  const code = String(value || '').trim();
  if (!code) return '';
  const mapped = TRANSLATOR_CODES[code.toLowerCase()];
  if (mapped) return mapped;
  // Region-specific app locales ("km-KH") translate with the base language.
  const base = code.split('-')[0].toLowerCase();
  return TARGET_PATTERN.test(base) ? base : '';
}

function normalizeRegion(value) {
  const region = String(value || '').trim().toLowerCase();
  return REGION_PATTERN.test(region) ? region : '';
}

/** Split texts into request-sized batches of { start, items }. */
function batchTexts(texts) {
  const batches = [];
  let current = { start: 0, items: [] };
  let chars = 0;
  texts.forEach((text, index) => {
    const size = text.length;
    if (current.items.length && (current.items.length >= MAX_ITEMS_PER_REQUEST || chars + size > MAX_CHARS_PER_REQUEST)) {
      batches.push(current);
      current = { start: index, items: [] };
      chars = 0;
    }
    current.items.push(text);
    chars += size;
  });
  if (current.items.length) batches.push(current);
  return batches;
}

/**
 * @param {object} deps
 * @param {() => Promise<string>} deps.getKey Translator resource key
 * @param {() => Promise<string>} deps.getRegion resource region; '' for a global resource
 * @param {number} deps.timeoutMs per-request timeout
 */
function createAzureTranslator(deps) {
  const { getKey, getRegion, timeoutMs } = deps;

  async function getStatus() {
    const configured = Boolean(await getKey());
    const region = normalizeRegion(await getRegion());
    return {
      configured,
      region,
      message: configured
        ? `Azure Translator key is configured${region ? ` (${region})` : ''}.`
        : 'Add an Azure Translator key to translate into languages the speech provider cannot (for example Khmer).'
    };
  }

  async function requestBatch(key, region, items, to) {
    const headers = { 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/json; charset=UTF-8' };
    // Regional resources need their region header; a global resource omits it.
    if (region && region !== 'global') headers['Ocp-Apim-Subscription-Region'] = region;
    const response = await fetchWithTimeout(`${ENDPOINT}&to=${encodeURIComponent(to)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(items.map(text => ({ Text: text }))),
      timeoutMs,
      provider: PROVIDER
    });
    if (response.status === 403) {
      // Translator answers 403 when the free monthly quota is used up.
      throw sttError(STT_ERROR.RATE_LIMITED, 'Azure Translator refused the request (403). The free monthly quota may be used up.', { provider: PROVIDER, statusCode: 403, retryable: false });
    }
    if (response.status === 401 && !headers['Ocp-Apim-Subscription-Region']) {
      // A regional resource's valid key is rejected when the region header is
      // missing, which reads like a bad key; point at the region instead.
      throw sttError(STT_ERROR.AUTH_INVALID, 'Azure Translator rejected the key. The Translator Region is empty: enter the region shown next to the keys in the Azure portal (for example "southeastasia").', { provider: PROVIDER, statusCode: 401, retryable: false });
    }
    if (!response.ok) throw await httpErrorFor(response, PROVIDER, body => body?.error?.message);
    const body = await response.json().catch(() => null);
    if (!Array.isArray(body) || body.length !== items.length) {
      throw sttError(STT_ERROR.PROVIDER_UNAVAILABLE, 'Azure Translator returned an unexpected response.', { provider: PROVIDER });
    }
    return body.map(entry => String(entry?.translations?.[0]?.text || ''));
  }

  /**
   * Translate texts into `to`. Output keeps input order and length; blank
   * inputs stay blank without being sent.
   * @returns {Promise<string[]>}
   */
  async function translate(texts, to) {
    const target = toTranslatorCode(to);
    if (!target) throw sttError(STT_ERROR.MODEL_NOT_SUPPORTED, `Unsupported translation language "${to}".`, { provider: PROVIDER });
    const key = (await getKey()) || '';
    if (!key) throw sttError(STT_ERROR.AUTH_REQUIRED, 'Azure Translator key is not configured. Add it in Settings → Speech & Translation.', { provider: PROVIDER });
    const rawRegion = String((await getRegion()) || '').trim();
    const region = normalizeRegion(rawRegion);
    if (rawRegion && !region) {
      throw sttError(STT_ERROR.AUTH_REQUIRED, 'Azure Translator region is not valid (for example "southeastasia").', { provider: PROVIDER });
    }

    const output = texts.map(() => '');
    const pending = [];
    texts.forEach((text, index) => {
      const clean = typeof text === 'string' ? text.trim() : '';
      if (clean) pending.push({ index, text: clean });
    });
    for (const batch of batchTexts(pending.map(item => item.text))) {
      const translated = await requestBatch(key, region, batch.items, target);
      translated.forEach((text, offset) => { output[pending[batch.start + offset].index] = text; });
    }
    return output;
  }

  async function testConnection() {
    const [sample] = await translate(['Hello'], 'vi');
    if (!sample) throw sttError(STT_ERROR.PROVIDER_UNAVAILABLE, 'Azure Translator returned an empty translation.', { provider: PROVIDER });
    return { ok: true, message: 'Azure Translator connection succeeded.' };
  }

  return { getStatus, translate, testConnection };
}

module.exports = { createAzureTranslator, toTranslatorCode, normalizeRegion, batchTexts, MAX_CHARS_PER_REQUEST, MAX_ITEMS_PER_REQUEST };
