'use strict';

// Live captions over slides: the server relay, the caption screen's choice of
// lines per language band, and the recording page's display choices.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const { createCaptionRelay, normalizeCaption, normalizeConfig } = require('../server/captions/caption-relay');

const ROOT = path.join(__dirname, '..');

class FakeResponse extends EventEmitter {
  constructor() { super(); this.chunks = []; this.headers = null; }
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(chunk) { this.chunks.push(chunk); }
  events() {
    return this.chunks.join('').split('\n\n')
      .map(block => {
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        return event ? { event, data: JSON.parse(data) } : null;
      })
      .filter(Boolean);
  }
}

test('caption events and screen settings are validated', () => {
  assert.strictEqual(normalizeCaption({ text: '   ' }), null);
  assert.deepStrictEqual(
    normalizeCaption({ channel: 'translation', text: ' Xin chào ', isFinal: 1, language: 'vi-VN', sourceLanguage: '<b>', timestamp: 'x' }),
    { channel: 'translation', text: 'Xin chào', isFinal: true, language: 'vi', sourceLanguage: '', timestamp: 0, seq: 0 }
  );
  assert.deepStrictEqual(normalizeConfig({ bands: ['vi', 'en', 'km'], fontPx: 'huge' }), { bands: ['vi', 'en'], fontPx: 36, title: '' });
  assert.strictEqual(normalizeConfig({ fontPx: 5 }).fontPx, 5);
  assert.strictEqual(normalizeConfig({ fontPx: '22.6' }).fontPx, 23);
  assert.strictEqual(normalizeConfig({ fontPx: 2 }).fontPx, 5);
  assert.strictEqual(normalizeConfig({ fontPx: 400 }).fontPx, 120);
  assert.strictEqual(normalizeConfig({}).fontPx, 36);
  assert.deepStrictEqual(normalizeConfig({ bands: ['javascript:'] }).bands, ['original']);
});

test('a screen that connects gets the settings, recent lines and the live phrase', () => {
  const relay = createCaptionRelay();
  relay.setConfig({ bands: ['vi'], fontPx: 48 });
  relay.publishCaption({ channel: 'original', text: 'Hello everyone.', isFinal: true, language: 'en' });
  relay.publishCaption({ channel: 'translation', text: 'Chào mọi', isFinal: false, language: 'vi', sourceLanguage: 'en' });

  const screen = new FakeResponse();
  relay.subscribe(screen);
  assert.strictEqual(screen.headers['Content-Type'], 'text/event-stream; charset=utf-8');
  const replay = screen.events();
  assert.deepStrictEqual(replay.map(item => item.event), ['config', 'caption', 'caption']);
  assert.strictEqual(replay[0].data.fontPx, 48);
  assert.strictEqual(replay[2].data.isFinal, false);

  relay.publishCaption({ channel: 'translation', text: 'Chào mọi người.', isFinal: true, language: 'vi', sourceLanguage: 'en' });
  relay.clear();
  assert.deepStrictEqual(screen.events().slice(-2).map(item => item.event), ['caption', 'clear']);
  assert.strictEqual(relay.clientCount(), 1);
  screen.emit('close');
  assert.strictEqual(relay.clientCount(), 0);

  const later = new FakeResponse();
  relay.subscribe(later);
  assert.deepStrictEqual(later.events().map(item => item.event), ['config'], 'a cleared meeting replays nothing');
  later.emit('close');
});

function loadCaptions() {
  const context = { console, setTimeout, clearTimeout, URLSearchParams };
  vm.createContext(context);
  vm.runInContext(`${fs.readFileSync(path.join(ROOT, 'js', 'captions.js'), 'utf8')}\n;globalThis.__captions = Captions;`, context);
  const captions = context.__captions;
  captions.render = () => {};
  return captions;
}

test('a Vietnamese band shows Vietnamese speech as spoken and other speech translated', () => {
  const captions = loadCaptions();
  captions.config = { bands: ['vi'], fontPx: 36 };
  // Two-way meeting: English speech → Vietnamese caption; Vietnamese speech → English caption.
  captions.receive({ channel: 'original', text: 'Hello everyone.', isFinal: true, language: 'en' });
  captions.receive({ channel: 'translation', text: 'Chào mọi người.', isFinal: true, language: 'vi', sourceLanguage: 'en' });
  captions.receive({ channel: 'original', text: 'Cảm ơn anh.', isFinal: true, language: 'vi' });
  captions.receive({ channel: 'translation', text: 'Thank you.', isFinal: true, language: 'en', sourceLanguage: 'vi' });
  // One-way translation into Vietnamese repeats Vietnamese speech: not shown twice.
  captions.receive({ channel: 'translation', text: 'Cảm ơn anh.', isFinal: true, language: 'vi', sourceLanguage: 'vi' });
  captions.receive({ channel: 'translation', text: 'Ngân sách', isFinal: false, language: 'vi', sourceLanguage: 'en' });

  const vi = captions.bandLines('vi');
  assert.deepStrictEqual(Array.from(vi.finals), ['Chào mọi người.', 'Cảm ơn anh.']);
  assert.strictEqual(vi.live, 'Ngân sách');

  captions.config = { bands: ['vi', 'en'], fontPx: 36 };
  assert.deepStrictEqual(Array.from(captions.bandLines('vi').finals), ['Cảm ơn anh.'], 'two bands keep one line each');
  assert.deepStrictEqual(Array.from(captions.bandLines('en').finals), ['Thank you.']);
  assert.deepStrictEqual(Array.from(captions.bandLines('original').finals), ['Cảm ơn anh.']);
});

test('the recording page offers each meeting language, both together, and as spoken', () => {
  const context = { console };
  vm.createContext(context);
  const source = ['transcriber.js', 'caption-feed.js'].map(file => fs.readFileSync(path.join(ROOT, 'js', file), 'utf8')).join('\n;');
  vm.runInContext(`${source}\n;globalThis.__feed = CaptionFeed;`, context);
  const feed = context.__feed;
  const values = meeting => Array.from(feed.displayChoices(meeting), choice => choice.value);

  assert.deepStrictEqual(values({ language: 'auto', translationLanguage: 'pair-vi-en' }), ['vi', 'en', 'vi+en', 'original']);
  assert.deepStrictEqual(values({ language: 'km-KH', translationLanguage: 'vi' }), ['vi', 'km', 'vi+km', 'original']);
  assert.deepStrictEqual(values({ language: 'vi-VN', translationLanguage: '' }), ['vi', 'original']);
  const khmerMeeting = { language: 'auto-km-vi-en', translationLanguage: 'pair-vi-en' };
  assert.deepStrictEqual(values(khmerMeeting), ['vi', 'en', 'km', 'vi+en', 'original']);
  assert.deepStrictEqual(Array.from(feed.displayChoices(khmerMeeting).find(choice => choice.value === 'vi+en').bands), ['vi', 'en']);
});

test('the Mac app can reach the caption screen through window.Captions', () => {
  const context = { console, setTimeout, clearTimeout, URLSearchParams };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'captions.js'), 'utf8'), context);
  assert.strictEqual(typeof context.window.Captions?.setEditing, 'function');
});

test('a late interim that arrives after its final does not come back as a stale live line', () => {
  const relay = createCaptionRelay();
  relay.publishCaption({ channel: 'translation', text: 'Chào mọi người.', isFinal: true, language: 'vi', seq: 20 });
  relay.publishCaption({ channel: 'translation', text: 'Chào mọi', isFinal: false, language: 'vi', seq: 10 });
  const screen = new FakeResponse();
  relay.subscribe(screen);
  const captions = screen.events().filter(item => item.event === 'caption').map(item => item.data);
  assert.deepStrictEqual(captions.map(caption => [caption.text, caption.isFinal]), [['Chào mọi người.', true]]);
  screen.emit('close');
});
