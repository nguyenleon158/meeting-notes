'use strict';

// Azure Speech live backend: js/transcriber.js runs in a sandbox with a fake
// Speech SDK, AudioContext and fetch, so routing, result mapping and drop
// handling are checked offline.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'js', 'transcriber.js'), 'utf8');

function createSandbox({ provider = 'soniox', tokenOk = true } = {}) {
  const recognizers = [];
  const written = [];
  const fetches = [];

  class FakeRecognizer {
    static FromConfig(config, autoDetect, audioConfig) {
      const recognizer = new FakeRecognizer(config, audioConfig);
      recognizer.autoDetect = autoDetect;
      return recognizer;
    }
    constructor(config, audioConfig) {
      this.config = config;
      this.audioConfig = audioConfig;
      this.closed = false;
      recognizers.push(this);
    }
    startContinuousRecognitionAsync(ok) { setTimeout(ok, 1); }
    stopContinuousRecognitionAsync(ok) {
      setTimeout(() => { this.sessionStopped?.(this, {}); ok(); }, 1);
    }
    close() { this.closed = true; }
  }

  const makeConfig = kind => ({
    fromAuthorizationToken(token, region) {
      return {
        kind, token, region, targets: [], properties: {},
        addTargetLanguage(code) { this.targets.push(code); },
        setProperty(id, value) { this.properties[id] = value; }
      };
    }
  });

  const SpeechSDK = {
    PropertyId: { SpeechServiceConnection_LanguageIdMode: 37 },
    LanguageIdMode: { AtStart: 0, Continuous: 1 },
    AutoDetectSourceLanguageConfig: { fromLanguages: languages => ({ languages, mode: 0 }) },
    ResultReason: { RecognizedSpeech: 3, TranslatedSpeech: 6 },
    CancellationReason: { Error: 1, EndOfStream: 0 },
    AudioStreamFormat: { getWaveFormatPCM: (rate, bits, channels) => ({ rate, bits, channels }) },
    AudioInputStream: {
      createPushStream: format => ({ format, write: buffer => written.push(buffer.byteLength), close() { this.closed = true; } })
    },
    AudioConfig: { fromStreamInput: stream => ({ stream }) },
    SpeechTranslationConfig: makeConfig('translation'),
    SpeechConfig: makeConfig('speech'),
    TranslationRecognizer: FakeRecognizer,
    SpeechRecognizer: FakeRecognizer
  };

  class FakeAudioContext {
    constructor(options = {}) { this.sampleRate = options.sampleRate || 48000; this.state = 'running'; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() {
      const processor = { connect() {}, disconnect() {}, onaudioprocess: null };
      this.processor = processor;
      return processor;
    }
    get destination() { return {}; }
    close() { return Promise.resolve(); }
  }

  const context = {
    console: { error() {}, warn() {}, log() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    WebSocket: class {},
    MediaRecorder: class {},
    AudioContext: FakeAudioContext,
    navigator: { mediaDevices: { getUserMedia() {} } },
    window: { SpeechSDK },
    document: { createElement() { return {}; }, head: { appendChild() {} } },
    fetch: async (url, init) => {
      fetches.push({ url, init });
      if (!tokenOk) return { ok: false, json: async () => ({ error: { message: 'Azure Speech key is not configured.' } }) };
      return { ok: true, json: async () => ({ token: 'short-lived-token', region: 'southeastasia', expiresInSeconds: 600 }) };
    },
    Storage: { getSettings: () => ({ sttProvider: provider }) }
  };
  vm.createContext(context);
  vm.runInContext(`${SOURCE}\n;globalThis.__exports = { Transcriber, AzureSpeechTranscriber, SonioxTranscriber, DeepgramTranscriber };`, context);
  return { ...context.__exports, recognizers, written, fetches };
}

const fakeStream = {};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('Khmer always goes live to Azure Speech; Azure provider does too', () => {
  const soniox = createSandbox({ provider: 'soniox' });
  assert.strictEqual(soniox.Transcriber._resolveBackend({ language: 'km-KH' }), soniox.AzureSpeechTranscriber);
  assert.strictEqual(soniox.Transcriber._resolveBackend({ language: 'vi-VN' }), soniox.SonioxTranscriber);
  assert.strictEqual(soniox.Transcriber.liveProviderLabel({ language: 'km-KH' }), 'Azure Speech');

  const azure = createSandbox({ provider: 'azure' });
  assert.strictEqual(azure.Transcriber._resolveBackend({ language: 'vi-VN' }), azure.AzureSpeechTranscriber);
  // Azure translates in the same pass, so no Translator round-trip.
  assert.strictEqual(azure.Transcriber._needsExternalTranslation(azure.AzureSpeechTranscriber, { language: 'km-KH', translationLanguage: 'vi' }), false);
});

test('language codes map to Azure locales and Translator targets', () => {
  const { AzureSpeechTranscriber: azure } = createSandbox();
  assert.strictEqual(azure.toRecognitionLocale('km-KH'), 'km-KH');
  assert.strictEqual(azure.toRecognitionLocale('auto'), '');
  assert.strictEqual(azure.toTargetLanguage('vi'), 'vi');
  assert.strictEqual(azure.toTargetLanguage('zh'), 'zh-Hans');
  assert.strictEqual(azure.toTargetLanguage('zh-TW'), 'zh-Hant');
});

test('48 kHz float audio becomes 16 kHz 16-bit PCM', () => {
  const { AzureSpeechTranscriber: azure } = createSandbox();
  const pcm = azure.toPcm16(new Float32Array([1, 1, 1, -1, -1, -1, 0, 0, 0]), 3);
  assert.deepStrictEqual(Array.from(pcm), [32767, -32768, 0]);
});

test('Khmer speech arrives as Khmer original plus Vietnamese translation', async () => {
  const sandbox = createSandbox();
  const { Transcriber, recognizers, written, fetches } = sandbox;
  const results = [];
  Transcriber.onResult = result => results.push(result);

  const started = await Transcriber.start({ language: 'km-KH', translationLanguage: 'vi', getAudioStream: () => fakeStream });
  assert.strictEqual(started, true);
  assert.match(fetches[0].url, /\/api\/stt\/providers\/azure\/temporary-key$/);

  const recognizer = recognizers[0];
  assert.strictEqual(recognizer.config.kind, 'translation');
  assert.strictEqual(recognizer.config.token, 'short-lived-token');
  assert.strictEqual(recognizer.config.speechRecognitionLanguage, 'km-KH');
  assert.deepStrictEqual(recognizer.config.targets, ['vi']);
  assert.strictEqual(recognizer.audioConfig.stream.format.rate, 16000);

  // Captured audio is pushed as PCM; paused audio is not.
  const processor = sandbox.AzureSpeechTranscriber._audioContext.processor;
  processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096) } });
  assert.strictEqual(written.length, 1);
  Transcriber.pause();
  processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096) } });
  assert.strictEqual(written.length, 1);
  Transcriber.resume();

  const translations = { get: code => (code === 'vi' ? 'Xin chào mọi người' : undefined) };
  recognizer.recognizing(recognizer, { result: { text: 'សួស្តី', offset: 0, translations } });
  recognizer.recognized(recognizer, { result: { reason: 6, text: 'សួស្តីអ្នកទាំងអស់គ្នា', offset: 25_000_000, translations } });

  const finals = results.filter(r => r.isFinal);
  assert.deepStrictEqual(finals.map(r => [r.channel, r.text, r.timestamp, r.language]), [
    ['original', 'សួស្តីអ្នកទាំងអស់គ្នា', 2.5, 'km'],
    ['translation', 'Xin chào mọi người', 2.5, 'vi']
  ]);
  assert.ok(results.some(r => !r.isFinal && r.channel === 'translation'));

  await Transcriber.stop();
  assert.strictEqual(recognizer.closed, true);
});

test('same source and target recognizes without translating', async () => {
  const { Transcriber, recognizers } = createSandbox({ provider: 'azure' });
  await Transcriber.start({ language: 'vi-VN', translationLanguage: 'vi', getAudioStream: () => fakeStream });
  assert.strictEqual(recognizers[0].config.kind, 'speech');
  await Transcriber.stop();
});

test('a dropped Azure session reconnects on the recording timeline', async () => {
  const { Transcriber, recognizers } = createSandbox();
  Transcriber.RECONNECT_BASE_MS = 5;
  const statuses = [];
  const results = [];
  Transcriber.onStatusChange = status => statuses.push(status);
  Transcriber.onResult = result => results.push(result);

  await Transcriber.start({
    language: 'km-KH',
    translationLanguage: 'vi',
    getAudioStream: () => fakeStream,
    getElapsedSeconds: () => 120,
    restartAudioFeed: () => { throw new Error('Azure must not restart the MediaRecorder feed'); }
  });
  recognizers[0].canceled(recognizers[0], { reason: 1, errorDetails: 'Connection was closed by the remote host.' });
  assert.ok(statuses.includes('reconnecting'));

  await wait(40);
  assert.strictEqual(recognizers.length, 2);
  assert.ok(statuses.includes('reconnected'));
  const translations = { get: () => 'Câu sau khi nối lại' };
  recognizers[1].recognized(recognizers[1], { result: { reason: 6, text: 'ឃ្លា', offset: 10_000_000, translations } });
  assert.strictEqual(results.find(r => r.isFinal && r.channel === 'translation').timestamp, 121);
  await Transcriber.stop();
});

test('missing Azure key or Auto-detect language fails to start with a clear error', async () => {
  const noKey = createSandbox({ tokenOk: false });
  const errors = [];
  noKey.Transcriber.onError = error => errors.push(error.message);
  assert.strictEqual(await noKey.Transcriber.start({ language: 'km-KH', getAudioStream: () => fakeStream }), false);
  assert.match(errors[0], /not configured/);

  // Azure Speech itself refuses Auto-detect with a clear message…
  const auto = createSandbox({ provider: 'azure' });
  const autoErrors = [];
  auto.AzureSpeechTranscriber.onError = error => autoErrors.push(error.message);
  assert.strictEqual(await auto.AzureSpeechTranscriber.start({ language: 'auto', getAudioStream: () => fakeStream }), false);
  assert.match(autoErrors[0], /spoken language/);
  // …so an Auto-detect meeting (the Multi-language tab) records with Soniox
  // even when Azure is the provider in Settings.
  assert.strictEqual(auto.Transcriber._resolveBackend({ language: 'auto', translationLanguage: 'pair-vi-en' }), auto.SonioxTranscriber);
  assert.strictEqual(auto.Transcriber._resolveBackend({ language: 'auto-km-vi-en' }), auto.AzureSpeechTranscriber);
});

test('Khmer / Vietnamese / English set detects the language of every phrase', async () => {
  const { Transcriber, SonioxTranscriber, recognizers } = createSandbox();
  // Offered as a spoken language, not as a translation target.
  assert.ok(SonioxTranscriber.getSupportedLanguages().some(item => item.code === 'auto-km-vi-en'));
  assert.ok(!SonioxTranscriber.getTranslationLanguages().some(item => item.code === 'auto-km-vi-en'));
  assert.strictEqual(Transcriber.liveProviderLabel({ language: 'auto-km-vi-en' }), 'Azure Speech');

  const results = [];
  Transcriber.onResult = result => results.push(result);
  assert.strictEqual(await Transcriber.start({ language: 'auto-km-vi-en', translationLanguage: 'vi', getAudioStream: () => fakeStream }), true);
  const recognizer = recognizers[0];
  assert.deepStrictEqual(Array.from(recognizer.autoDetect.languages), ['km-KH', 'vi-VN', 'en-US']);
  assert.strictEqual(recognizer.autoDetect.mode, 1);
  assert.strictEqual(recognizer.config.properties[37], 'Continuous');
  assert.strictEqual(recognizer.config.speechRecognitionLanguage, undefined);
  assert.deepStrictEqual(recognizer.config.targets, ['vi']);

  const translations = text => ({ get: () => text });
  recognizer.recognized(recognizer, { result: { reason: 6, text: 'សួស្តី', language: 'km-KH', offset: 0, translations: translations('Xin chào') } });
  recognizer.recognized(recognizer, { result: { reason: 6, text: 'Good morning', language: 'en-US', offset: 20_000_000, translations: translations('Chào buổi sáng') } });
  const originals = results.filter(r => r.isFinal && r.channel === 'original').map(r => [r.text, r.language]);
  assert.deepStrictEqual(originals, [['សួស្តី', 'km'], ['Good morning', 'en']]);
  assert.deepStrictEqual(results.filter(r => r.isFinal && r.channel === 'translation').map(r => r.text), ['Xin chào', 'Chào buổi sáng']);
  await Transcriber.stop();
});

test('the Vietnamese ↔ English pair: Khmer → Vietnamese, Vietnamese → English, per phrase', async () => {
  const { Transcriber, recognizers } = createSandbox();
  const results = [];
  Transcriber.onResult = result => results.push(result);
  assert.strictEqual(await Transcriber.start({ language: 'auto-km-vi-en', translationLanguage: 'pair-vi-en', getAudioStream: () => fakeStream }), true);
  const recognizer = recognizers[0];
  assert.strictEqual(recognizer.config.kind, 'translation');
  assert.deepStrictEqual(recognizer.config.targets, ['vi', 'en']);

  const both = (vi, en) => ({ get: code => ({ vi, en })[code] });
  recognizer.recognized(recognizer, { result: { reason: 6, text: 'សួស្តី', language: 'km-KH', offset: 0, translations: both('Xin chào', 'Hello') } });
  recognizer.recognized(recognizer, { result: { reason: 6, text: 'Cảm ơn anh', language: 'vi-VN', offset: 10_000_000, translations: both('Cảm ơn anh', 'Thank you') } });
  recognizer.recognized(recognizer, { result: { reason: 6, text: 'Good morning', language: 'en-US', offset: 20_000_000, translations: both('Chào buổi sáng', 'Good morning') } });
  const captions = results.filter(r => r.isFinal && r.channel === 'translation').map(r => [r.text, r.language]);
  assert.deepStrictEqual(captions, [['Xin chào', 'vi'], ['Thank you', 'en'], ['Chào buổi sáng', 'vi']]);
  await Transcriber.stop();
});

test('a single spoken language under the pair asks Azure for one target only', async () => {
  const { Transcriber, recognizers } = createSandbox();
  await Transcriber.start({ language: 'km-KH', translationLanguage: 'pair-vi-en', getAudioStream: () => fakeStream });
  assert.deepStrictEqual(recognizers[0].config.targets, ['vi']);
  await Transcriber.stop();
});

test('the pair is native on Soniox and Azure; Deepgram goes through Translator', () => {
  const { Transcriber, SonioxTranscriber, AzureSpeechTranscriber, DeepgramTranscriber } = createSandbox();
  const options = { language: 'auto', translationLanguage: 'pair-vi-en' };
  assert.strictEqual(Transcriber._needsExternalTranslation(SonioxTranscriber, options), false);
  assert.strictEqual(Transcriber._needsExternalTranslation(AzureSpeechTranscriber, options), false);
  assert.strictEqual(Transcriber._needsExternalTranslation(DeepgramTranscriber, options), true);
});

test('a meeting that pins Azure Speech records with it whatever the Settings provider', () => {
  const { Transcriber, AzureSpeechTranscriber, SonioxTranscriber } = createSandbox({ provider: 'soniox' });
  assert.strictEqual(Transcriber._resolveBackend({ language: 'vi-VN', provider: 'azure' }), AzureSpeechTranscriber);
  assert.strictEqual(Transcriber._resolveBackend({ language: 'vi-VN' }), SonioxTranscriber);
  assert.strictEqual(Transcriber.liveProviderLabel({ language: 'vi-VN', translationLanguage: 'km', provider: 'azure' }), 'Azure Speech');
});
