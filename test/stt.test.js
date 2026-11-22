'use strict';

// Unit tests for STT provider logic that does not need a running server.

const { test } = require('node:test');
const assert = require('node:assert');

const { createGoogleAdapter } = require('../server/stt/providers/google');
const { createSttService } = require('../server/stt');
const { createAzureAdapter } = require('../server/stt/providers/azure');

test('Google operation polling uses the correct URL (not doubled/encoded)', async () => {
  const urls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).includes('longrunningrecognize')) {
      return { ok: true, status: 200, json: async () => ({ name: 'operations/test-operation' }) };
    }
    // operations.get poll → return a completed job
    return { ok: true, status: 200, json: async () => ({ done: true, response: { results: [] } }) };
  };
  try {
    const gg = createGoogleAdapter({ getKey: async () => 'k', timeoutMs: 5000 });
    // transcript will be empty → adapter returns empty; we only assert the poll URL.
    await gg.transcribe({ audio: { buffer: Buffer.from('x'), mimeType: 'audio/webm', size: 1 }, language: 'en', model: 'latest_long' }).catch(() => {});
    const pollUrl = urls.find(u => u.includes('/operations/'));
    assert.ok(pollUrl, 'a poll URL was requested');
    assert.ok(
      pollUrl.endsWith('/v1/operations/test-operation'),
      `expected canonical operations path, got ${pollUrl}`
    );
    assert.ok(!pollUrl.includes('operations%2F'), 'the resource name must not be percent-encoded with a slash');
    assert.ok(!pollUrl.includes('/operations/operations'), 'the path must not be doubled');
  } finally {
    global.fetch = originalFetch;
  }
});

async function withFetch(handler, run) {
  const originalFetch = global.fetch;
  global.fetch = handler;
  try { return await run(); } finally { global.fetch = originalFetch; }
}

const sampleAudio = { buffer: Buffer.from('x'), mimeType: 'audio/webm', filename: 'a.webm', size: 1 };

test('Azure posts to the regional fast-transcription host and maps phrases', async () => {
  const calls = [];
  const result = await withFetch(async (url, init) => {
    calls.push({ url: String(url), definition: JSON.parse(init.body.get('definition')), key: init.headers['Ocp-Apim-Subscription-Key'] });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        durationMilliseconds: 61500,
        phrases: [
          { offsetMilliseconds: 40, text: 'សួស្តី', speaker: 1, locale: 'km-KH' },
          { offsetMilliseconds: 2500, text: 'អរគុណ', speaker: 2, locale: 'km-KH' }
        ]
      })
    };
  }, () => createAzureAdapter({ getKey: async () => 'k', getRegion: async () => 'SouthEastAsia', timeoutMs: 5000 })
    .transcribe({ audio: sampleAudio, language: 'km-KH' }));

  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].url.startsWith('https://southeastasia.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version='));
  assert.strictEqual(calls[0].key, 'k');
  assert.deepStrictEqual(calls[0].definition.locales, ['km-KH']);
  assert.strictEqual(calls[0].definition.diarization.enabled, true);
  assert.deepStrictEqual(result.transcript, [
    { text: 'សួស្តី', time: 0.04, speaker: 'Speaker 1', language: 'km-KH' },
    { text: 'អរគុណ', time: 2.5, speaker: 'Speaker 2', language: 'km-KH' }
  ]);
  assert.strictEqual(result.duration, 61.5);
});

test('Azure retries without diarization when the request is rejected, and omits locales for auto', async () => {
  const definitions = [];
  const result = await withFetch(async (url, init) => {
    definitions.push(JSON.parse(init.body.get('definition')));
    if (definitions.length === 1) return { ok: false, status: 400, json: async () => ({ error: { message: 'Diarization not supported' } }) };
    return { ok: true, status: 200, json: async () => ({ durationMilliseconds: 1000, phrases: [{ offsetMilliseconds: 0, text: 'hello' }] }) };
  }, () => createAzureAdapter({ getKey: async () => 'k', getRegion: async () => 'eastus', timeoutMs: 5000 })
    .transcribe({ audio: sampleAudio, language: 'auto' }));

  assert.strictEqual(definitions.length, 2);
  assert.ok(definitions[0].diarization);
  assert.deepStrictEqual(definitions[1], {});
  assert.strictEqual(result.transcript[0].speaker, 'Speaker');
});

test('Azure refuses a malformed region instead of building a host from it', async () => {
  let fetched = false;
  await withFetch(async () => { fetched = true; return { ok: true }; }, async () => {
    const azure = createAzureAdapter({ getKey: async () => 'k', getRegion: async () => 'evil.com/x', timeoutMs: 5000 });
    await assert.rejects(() => azure.testConnection(), err => err.llmCode === 'STT_AUTH_REQUIRED');
    const status = await azure.getStatus();
    assert.strictEqual(status.available, false);
  });
  assert.strictEqual(fetched, false);
});

test('STT service reads the Azure region from settings and reports needsRegion', async () => {
  const service = createSttService({
    timeoutMs: 5000,
    secretStore: { read: async account => (account === 'azure-speech-key' ? 'key' : ''), write: async () => {}, remove: async () => {} },
    getSettings: async () => ({ sttRegions: { azure: 'southeastasia' } })
  });
  const { providers } = await service.listProviders();
  const azure = providers.find(p => p.id === 'azure');
  assert.ok(azure, 'azure provider is registered');
  assert.strictEqual(azure.needsRegion, true);
  assert.strictEqual(azure.available, true);
});

test('oversized audio is rejected before the file is read', async () => {
  let loaded = false;
  const service = createSttService({
    timeoutMs: 5000,
    secretStore: { read: async () => 'key', write: async () => {}, remove: async () => {} },
    getSettings: async () => ({ sttProvider: 'whisper', sttModels: {} })
  });
  await assert.rejects(
    () => service.transcribe({
      providerId: 'whisper',
      audioMeta: { size: 30 * 1024 * 1024, mimeType: 'audio/webm', filename: 'big.webm' }, // 30MB > 25MB
      loadAudio: async () => { loaded = true; return Buffer.alloc(0); },
      language: 'en'
    }),
    (err) => err.llmCode === 'STT_AUDIO_TOO_LARGE'
  );
  assert.strictEqual(loaded, false, 'loadAudio must not run for an oversized file');
});

test('Khmer / Vietnamese / English set: Azure gets the candidate locales, other providers auto-detect', async () => {
  const definitions = [];
  await withFetch(async (url, init) => {
    definitions.push(JSON.parse(init.body.get('definition')));
    return { ok: true, status: 200, json: async () => ({ durationMilliseconds: 1000, phrases: [{ offsetMilliseconds: 0, text: 'xin chào', locale: 'vi-VN' }] }) };
  }, () => createAzureAdapter({ getKey: async () => 'k', getRegion: async () => 'southeastasia', timeoutMs: 5000 })
    .transcribe({ audio: sampleAudio, language: 'auto-km-vi-en' }));
  assert.deepStrictEqual(definitions[0].locales, ['km-KH', 'vi-VN', 'en-US']);

  // Deepgram has no candidate-language detection: the set becomes plain auto-detect.
  const { createSttService } = require('../server/stt');
  const service = createSttService({
    timeoutMs: 5000,
    secretStore: { read: async () => 'key', write: async () => {}, remove: async () => {} },
    getSettings: async () => ({})
  });
  const urls = [];
  await withFetch(async url => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ metadata: { duration: 1 }, results: { channels: [{ alternatives: [{ transcript: 'hi', words: [] }] }] } }) };
  }, () => service.transcribe({ providerId: 'deepgram', audioMeta: { size: 1, mimeType: 'audio/webm' }, loadAudio: async () => Buffer.from('x'), language: 'auto-km-vi-en' })
    .catch(() => {})); // only the request matters here
  assert.strictEqual(urls.length, 1);
  assert.ok(!/language=auto/.test(urls[0]), urls[0]);
});
