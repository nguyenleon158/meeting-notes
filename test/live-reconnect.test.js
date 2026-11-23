'use strict';

// Live transcription reconnect: js/transcriber.js runs in a sandbox with a
// fake WebSocket/fetch so a dropped Soniox session can be simulated offline.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'js', 'transcriber.js'), 'utf8');

function createSandbox() {
  const sockets = [];
  let connectFailuresLeft = 0;

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      sockets.push(this);
      setTimeout(() => {
        if (connectFailuresLeft > 0) {
          connectFailuresLeft -= 1;
          this.readyState = FakeWebSocket.CLOSED;
          this.onerror?.();
          this.onclose?.({ code: 1006, reason: '' });
          return;
        }
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
      }, 1);
    }
    send(data) {
      this.sent.push(data);
      if (data === '') setTimeout(() => this.serverMessage({ tokens: [], finished: true }), 1);
    }
    close() {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      setTimeout(() => this.onclose?.({ code: 1000, reason: '' }), 1);
    }
    serverMessage(payload) { this.onmessage?.({ data: JSON.stringify(payload) }); }
    drop(code = 1006, reason = 'network lost') {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.({ code, reason });
    }
  }

  const context = {
    console: { error() {}, warn() {}, log() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    WebSocket: FakeWebSocket,
    MediaRecorder: class {},
    navigator: { mediaDevices: { getUserMedia() {} } },
    fetch: async () => ({ ok: true, json: async () => ({ apiKey: 'temp-key' }) }),
    Storage: { getSettings: () => ({ sttProvider: 'soniox' }) }
  };
  vm.createContext(context);
  vm.runInContext(`${SOURCE}\n;globalThis.__exports = { Transcriber, SonioxTranscriber };`, context);
  const { Transcriber } = context.__exports;
  Transcriber.RECONNECT_BASE_MS = 5;
  Transcriber.RECONNECT_MAX_MS = 20;
  return { Transcriber, SonioxTranscriber: context.__exports.SonioxTranscriber, sockets, failNextConnects: count => { connectFailuresLeft = count; } };
}

const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs = 1000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition');
    await tick(2);
  }
}

function finalToken(text, startMs) {
  return { text, start_ms: startMs, end_ms: startMs + 200, is_final: true, speaker: '1', language: 'vi' };
}

test('a dropped live session reconnects with a fresh audio feed and shifts timestamps', async () => {
  const { Transcriber, sockets } = createSandbox();
  const statuses = [];
  const results = [];
  const logs = [];
  let feedRestarts = 0;
  Transcriber.onStatusChange = status => statuses.push(status);
  Transcriber.onResult = result => { if (result.isFinal) results.push(result); };

  const ok = await Transcriber.start({
    language: 'vi-VN',
    restartAudioFeed: () => {
      feedRestarts += 1;
      // The fresh encoder's first chunk carries the container header.
      Transcriber.sendAudio({ size: 10, tag: 'header' });
      return 1260;
    },
    log: (level, event) => logs.push(`${level}:${event}`)
  });
  assert.strictEqual(ok, true);

  sockets[0].serverMessage({ tokens: [finalToken('Xin chào.', 1000)] });
  sockets[0].drop();

  await waitFor(() => statuses.includes('reconnected'));
  assert.strictEqual(sockets.length, 2, 'opens exactly one new socket');
  assert.strictEqual(feedRestarts, 1, 'restarts the live audio encoder once');
  assert.strictEqual(sockets[1].sent[1]?.tag, 'header', 'header chunk is queued and sent right after the config');
  assert.ok(statuses.indexOf('reconnecting') < statuses.indexOf('reconnected'));
  assert.ok(logs.includes('warn:live_transcription_dropped'));
  assert.ok(logs.includes('info:live_transcription_reconnected'));

  sockets[1].serverMessage({ tokens: [finalToken('Tiếp tục.', 2000)] });
  assert.strictEqual(results[0].timestamp, 1, 'first session keeps its own clock');
  assert.strictEqual(results[1].timestamp, 1262, 'reconnected session is shifted onto the recording timeline');

  await Transcriber.stop();
  await tick(10);
  assert.strictEqual(sockets.length, 2, 'stop() does not trigger another reconnect');
});

test('keeps retrying with backoff while the network is down', async () => {
  const { Transcriber, sockets, failNextConnects } = createSandbox();
  const statuses = [];
  const errors = [];
  Transcriber.onStatusChange = status => statuses.push(status);
  Transcriber.onError = error => errors.push(error);

  await Transcriber.start({ language: 'vi-VN', restartAudioFeed: () => 30 });
  // The next two connection attempts fail before the third succeeds.
  failNextConnects(2);
  sockets[0].drop();

  await waitFor(() => statuses.includes('reconnected'));
  assert.strictEqual(sockets.length, 4, 'one original socket, two failed retries, one success');
  assert.strictEqual(errors.length, 0, 'failed retries do not raise a toast each');
  await Transcriber.stop();
});

test('an explicit stop is not treated as a drop', async () => {
  const { Transcriber, sockets } = createSandbox();
  const statuses = [];
  Transcriber.onStatusChange = status => statuses.push(status);
  await Transcriber.start({ language: 'vi-VN', restartAudioFeed: () => 0 });
  await Transcriber.stop();
  await tick(20);
  assert.strictEqual(sockets.length, 1);
  assert.ok(!statuses.includes('reconnecting'));
});

test('a drop while paused reconnects but keeps the meeting paused', async () => {
  const { Transcriber, sockets } = createSandbox();
  const statuses = [];
  Transcriber.onStatusChange = status => statuses.push(status);
  await Transcriber.start({ language: 'vi-VN', restartAudioFeed: () => 90 });
  Transcriber.pause();
  sockets[0].drop();
  await waitFor(() => sockets.length === 2 && statuses.includes('paused') && statuses.lastIndexOf('paused') > statuses.indexOf('reconnecting'));
  assert.ok(!statuses.includes('reconnected'), 'paused meeting is not reported as live');
  assert.strictEqual(Transcriber.isPaused, true);
  await Transcriber.stop();
});

// Soniox translated tokens carry no timestamps (only text and languages).
function translatedToken(text, language = 'vi', sourceLanguage = 'en') {
  return { text, is_final: true, translation_status: 'translation', language, source_language: sourceLanguage, speaker: '1' };
}

test('the Vietnamese ↔ English pair asks Soniox for two-way translation', async () => {
  const { Transcriber, sockets } = createSandbox();
  assert.ok(Transcriber.getTranslationPairs().some(pair => pair.code === 'pair-vi-en'));
  assert.strictEqual(Transcriber.translationLabel('pair-vi-en'), 'vi ↔ en');
  await Transcriber.start({ language: 'auto', translationLanguage: 'pair-vi-en' });
  const config = JSON.parse(sockets[0].sent[0]);
  assert.deepStrictEqual(config.translation, { type: 'two_way', language_a: 'vi', language_b: 'en' });
  assert.deepStrictEqual(Array.from(config.language_hints), ['vi', 'en']);
  await Transcriber.stop();
});

test('untimed translation without punctuation still commits after the segment cap', async () => {
  const { Transcriber, SonioxTranscriber, sockets } = createSandbox();
  SonioxTranscriber.MAX_SEGMENT_MS = 30;
  const finals = [];
  Transcriber.onResult = result => { if (result.isFinal) finals.push(result); };
  await Transcriber.start({ language: 'auto', translationLanguage: 'vi' });

  sockets[0].serverMessage({ tokens: [{ ...finalToken('so we spend', 5000), language: 'en' }, translatedToken('vậy chúng ta chi')] });
  await tick(40);
  sockets[0].serverMessage({ tokens: [translatedToken(' cho quảng cáo')] });
  const captions = finals.filter(result => result.channel === 'translation');
  assert.strictEqual(captions.length, 1, 'translation commits on the clock, not only on punctuation');
  assert.strictEqual(captions[0].text, 'vậy chúng ta chi cho quảng cáo');
  assert.strictEqual(captions[0].timestamp, 5, 'caption takes the position of the latest spoken token');
  await Transcriber.stop();
});

test('two-way captions split when the target language changes; quotes end sentences', async () => {
  const { Transcriber, sockets } = createSandbox();
  const captions = [];
  Transcriber.onResult = result => { if (result.isFinal && result.channel === 'translation') captions.push(result); };
  await Transcriber.start({ language: 'auto', translationLanguage: 'pair-vi-en' });

  sockets[0].serverMessage({ tokens: [translatedToken('Xin chào mọi người', 'vi', 'en'), translatedToken('Let us begin', 'en', 'vi')] });
  sockets[0].serverMessage({ tokens: [translatedToken(' "Do you run ads?"', 'en', 'vi')] });
  assert.deepStrictEqual(captions.map(caption => [caption.text, caption.language]), [
    ['Xin chào mọi người', 'vi'],
    ['Let us begin "Do you run ads?"', 'en']
  ]);
  await Transcriber.stop();
});

test('a token that starts a new speaker is kept, not dropped with the old segment', async () => {
  const { Transcriber, sockets } = createSandbox();
  const finals = [];
  Transcriber.onResult = result => { if (result.isFinal) finals.push(result); };
  await Transcriber.start({ language: 'vi-VN' });
  sockets[0].serverMessage({ tokens: [finalToken('Chào anh', 1000), { ...finalToken('Chào em.', 1500), speaker: '2' }] });
  assert.deepStrictEqual(finals.map(result => [result.text, result.speaker]), [['Chào anh', '1'], ['Chào em.', '2']]);
  await Transcriber.stop();
});

test('an untimed caption commits during silence, without waiting for the next token', async () => {
  const { Transcriber, SonioxTranscriber, sockets } = createSandbox();
  SonioxTranscriber.MAX_SEGMENT_MS = 30;
  const finals = [];
  Transcriber.onResult = result => { if (result.isFinal) finals.push(result); };
  await Transcriber.start({ language: 'auto', translationLanguage: 'vi' });
  sockets[0].serverMessage({ tokens: [translatedToken('vậy chúng ta chi cho quảng cáo')] });
  await tick(40);
  sockets[0].serverMessage({ tokens: [] }); // Soniox keeps sending empty messages in silence
  assert.deepStrictEqual(finals.filter(result => result.channel === 'translation').map(result => result.text), ['vậy chúng ta chi cho quảng cáo']);
  await Transcriber.stop();
});

test('a two-way preview in the other language is not labelled with the unfinished one', async () => {
  const { Transcriber, sockets } = createSandbox();
  const previews = [];
  Transcriber.onResult = result => { if (!result.isFinal && result.channel === 'translation') previews.push(result); };
  await Transcriber.start({ language: 'auto', translationLanguage: 'pair-vi-en' });
  sockets[0].serverMessage({ tokens: [
    translatedToken('Let us begin', 'en', 'vi'),
    { ...translatedToken('Xin chào', 'vi', 'en'), is_final: false }
  ] });
  const last = previews[previews.length - 1];
  assert.deepStrictEqual([last.text, last.language], ['Xin chào', 'vi']);
  await Transcriber.stop();
});
