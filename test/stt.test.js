'use strict';

// Unit tests for STT provider logic that does not need a running server.

const { test } = require('node:test');
const assert = require('node:assert');

const { createGoogleAdapter } = require('../server/stt/providers/google');
const { createSttService } = require('../server/stt');

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
