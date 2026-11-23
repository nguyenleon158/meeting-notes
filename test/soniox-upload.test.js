'use strict';

// Soniox file uploads: token grouping and the translation config (no network).

const { test } = require('node:test');
const assert = require('node:assert');

const { createSonioxAdapter, buildSegments } = require('../server/stt/providers/soniox');

test('untimed translated tokens take the spoken position and are capped by length', () => {
  const tokens = [
    { text: 'Hello everyone', start_ms: 4000, end_ms: 5000, speaker: '1', language: 'en' },
    ...Array.from({ length: 60 }, () => ({ text: 'chúng ta tiếp tục ', translation_status: 'translation', language: 'vi', source_language: 'en', speaker: '1' }))
  ];
  const captions = buildSegments(tokens, true);
  assert.ok(captions.length >= 2, 'a long caption without punctuation is split');
  assert.ok(captions.every(caption => caption.text.length <= 420));
  assert.strictEqual(captions[0].time, 4);
});

test('a translated sentence ending in a closing quote ends the segment', () => {
  const captions = buildSegments([
    { text: 'Bạn có chạy quảng cáo không?"', translation_status: 'translation', language: 'vi' },
    { text: ' Có.', translation_status: 'translation', language: 'vi' }
  ], true);
  assert.deepStrictEqual(captions.map(caption => caption.text), ['Bạn có chạy quảng cáo không?"', 'Có.']);
});

test('the Vietnamese ↔ English pair uploads with two-way translation', async () => {
  const bodies = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (init.method === 'POST' && path.endsWith('/transcriptions')) bodies.push(JSON.parse(init.body));
    const json = path.endsWith('/files') ? { id: 'file-1' }
      : path.endsWith('/transcript') ? { tokens: [] }
      : { id: 'tr-1', status: 'completed', audio_duration_ms: 1000 };
    return { ok: true, status: 200, json: async () => json };
  };
  try {
    const adapter = createSonioxAdapter({ getKey: async () => 'key' });
    await adapter.transcribe({ audio: { buffer: Buffer.from('x'), size: 1, mimeType: 'audio/webm' }, language: 'auto', translationLanguage: 'pair-vi-en' });
  } finally {
    global.fetch = originalFetch;
  }
  assert.deepStrictEqual(bodies[0].translation, { type: 'two_way', language_a: 'vi', language_b: 'en' });
  assert.deepStrictEqual(bodies[0].language_hints, ['vi', 'en']);
});
