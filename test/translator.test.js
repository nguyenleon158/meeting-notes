'use strict';

// Unit tests for the Azure Translator client (no network).

const { test } = require('node:test');
const assert = require('node:assert');

const { createAzureTranslator, toTranslatorCode, batchTexts } = require('../server/translate/azure-translator');

async function withFetch(handler, run) {
  const originalFetch = global.fetch;
  global.fetch = handler;
  try { return await run(); } finally { global.fetch = originalFetch; }
}

const echoTranslation = async (url, init) => {
  const items = JSON.parse(init.body);
  const to = new URL(url).searchParams.get('to');
  return { ok: true, status: 200, json: async () => items.map(item => ({ translations: [{ text: `[${to}] ${item.Text}`, to }] })) };
};

test('maps app language codes to Translator codes', () => {
  assert.strictEqual(toTranslatorCode('km'), 'km');
  assert.strictEqual(toTranslatorCode('km-KH'), 'km');
  assert.strictEqual(toTranslatorCode('zh'), 'zh-Hans');
  assert.strictEqual(toTranslatorCode('vi'), 'vi');
  assert.strictEqual(toTranslatorCode(''), '');
});

test('translates Vietnamese text into Khmer with key and region headers, keeping order and blanks', async () => {
  const calls = [];
  const result = await withFetch(async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    return echoTranslation(url, init);
  }, () => createAzureTranslator({ getKey: async () => 'k', getRegion: async () => 'SouthEastAsia', timeoutMs: 5000 })
    .translate(['Xin chào', '  ', 'Cảm ơn'], 'km'));

  assert.deepStrictEqual(result, ['[km] Xin chào', '', '[km] Cảm ơn']);
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].url.startsWith('https://api.cognitive.microsofttranslator.com/translate?api-version=3.0'));
  assert.strictEqual(calls[0].headers['Ocp-Apim-Subscription-Key'], 'k');
  assert.strictEqual(calls[0].headers['Ocp-Apim-Subscription-Region'], 'southeastasia');
});

test('a global resource sends no region header', async () => {
  let headers = null;
  await withFetch(async (url, init) => { headers = init.headers; return echoTranslation(url, init); },
    () => createAzureTranslator({ getKey: async () => 'k', getRegion: async () => '', timeoutMs: 5000 }).translate(['hi'], 'vi'));
  assert.strictEqual(headers['Ocp-Apim-Subscription-Region'], undefined);
});

test('splits large inputs into requests within the service limits', async () => {
  const texts = Array.from({ length: 2500 }, (_, i) => `line ${i}`);
  let requests = 0;
  const result = await withFetch(async (url, init) => { requests += 1; return echoTranslation(url, init); },
    () => createAzureTranslator({ getKey: async () => 'k', getRegion: async () => '', timeoutMs: 5000 }).translate(texts, 'km'));
  assert.strictEqual(requests, 3);
  assert.strictEqual(result[2499], '[km] line 2499');

  const byChars = batchTexts(['a'.repeat(30000), 'b'.repeat(30000)]);
  assert.strictEqual(byChars.length, 2);
});

test('missing key and exhausted quota become typed errors', async () => {
  await assert.rejects(
    () => createAzureTranslator({ getKey: async () => '', getRegion: async () => '', timeoutMs: 5000 }).translate(['hi'], 'km'),
    err => err.llmCode === 'STT_AUTH_REQUIRED'
  );
  await withFetch(async () => ({ ok: false, status: 403, json: async () => ({}) }), async () => {
    await assert.rejects(
      () => createAzureTranslator({ getKey: async () => 'k', getRegion: async () => '', timeoutMs: 5000 }).translate(['hi'], 'km'),
      err => err.llmCode === 'STT_RATE_LIMITED' && /quota/.test(err.message)
    );
  });
});

test('a 401 without a region points at the empty region, not the key', async () => {
  await withFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }), async () => {
    await assert.rejects(
      () => createAzureTranslator({ getKey: async () => 'k', getRegion: async () => '', timeoutMs: 5000 }).translate(['hi'], 'km'),
      err => err.llmCode === 'STT_AUTH_INVALID' && /Region is empty/.test(err.message)
    );
    await assert.rejects(
      () => createAzureTranslator({ getKey: async () => 'k', getRegion: async () => 'southeastasia', timeoutMs: 5000 }).translate(['hi'], 'km'),
      err => err.llmCode === 'STT_AUTH_INVALID' && !/Region is empty/.test(err.message)
    );
  });
});
