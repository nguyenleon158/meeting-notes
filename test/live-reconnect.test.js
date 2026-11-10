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
  return { Transcriber, sockets, failNextConnects: count => { connectFailuresLeft = count; } };
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
