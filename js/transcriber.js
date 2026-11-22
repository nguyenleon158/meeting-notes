/* ============================================
   MeetNote AI — Realtime Transcribers
   SonioxTranscriber + DeepgramTranscriber implement the
   same live-streaming interface; the Transcriber facade
   at the bottom picks one based on the selected provider.
   ============================================ */

const SonioxTranscriber = {
  websocket: null,
  isListening: false,
  isPaused: false,
  onResult: null,       // callback({ channel, text, isFinal, timestamp, speaker, language })
  onError: null,        // callback({ error, message })
  onStatusChange: null, // callback('connecting' | 'listening' | 'paused' | 'stopped' | 'error')
  onDrop: null,         // callback({ code, reason }) when an open session closes without stop()
  _state: 'stopped',
  _audioQueue: [],
  _buffers: null,
  _keepaliveInterval: null,
  _stopPromise: null,
  _resolveStop: null,
  _stopRequested: false,
  _opened: false,
  _lastError: '',

  isSupported() {
    return typeof WebSocket !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== 'undefined';
  },

  getSupportedLanguages() {
    return [
      { code: 'vi-VN', sonioxCode: 'vi', name: 'Tiếng Việt' },
      { code: 'en-US', sonioxCode: 'en', name: 'English (US)' },
      { code: 'en-GB', sonioxCode: 'en', name: 'English (UK)' },
      { code: 'ja-JP', sonioxCode: 'ja', name: '日本語' },
      { code: 'ko-KR', sonioxCode: 'ko', name: '한국어' },
      { code: 'zh-CN', sonioxCode: 'zh', name: '中文 (简体)' },
      { code: 'zh-TW', sonioxCode: 'zh', name: '中文 (繁體)' },
      { code: 'fr-FR', sonioxCode: 'fr', name: 'Français' },
      { code: 'de-DE', sonioxCode: 'de', name: 'Deutsch' },
      { code: 'es-ES', sonioxCode: 'es', name: 'Español' },
      { code: 'pt-BR', sonioxCode: 'pt', name: 'Português' },
      { code: 'th-TH', sonioxCode: 'th', name: 'ไทย' },
      { code: 'id-ID', sonioxCode: 'id', name: 'Bahasa Indonesia' },
      // Soniox and Deepgram do not know Khmer: live Khmer goes to Azure Speech,
      // uploads to providers that know it (Azure, Google, Whisper).
      { code: 'km-KH', sonioxCode: 'km', name: 'ភាសាខ្មែរ (Khmer)', liveSupported: false },
      // A meeting that switches between these languages: Azure Speech detects
      // the language of every phrase (live and uploads); other providers auto-detect.
      { code: 'auto-km-vi-en', sonioxCode: 'auto', name: 'Tự nhận: Khmer / Tiếng Việt / English', liveSupported: false, candidates: ['km-KH', 'vi-VN', 'en-US'] }
    ];
  },

  // Translation targets. Languages Soniox cannot translate into (Khmer) are
  // still offered: the Transcriber facade routes them to Azure Translator.
  getTranslationLanguages() {
    const seen = new Set();
    return this.getSupportedLanguages().filter(language => {
      if (language.candidates || seen.has(language.sonioxCode)) return false;
      seen.add(language.sonioxCode);
      return true;
    });
  },

  // Two-way translation presets, offered next to the single targets. Speech
  // in `primary` is translated to `secondary`; every other language to
  // `primary`. Soniox translates only the pair itself (two_way): a third
  // language stays untranslated there. Azure paths translate it to `primary`.
  TRANSLATION_PAIRS: [
    { code: 'pair-vi-en', primary: 'vi', secondary: 'en', name: 'Tiếng Việt ↔ English', label: 'vi ↔ en' }
  ],

  getTranslationPairs() {
    return this.TRANSLATION_PAIRS.map(pair => ({ ...pair }));
  },

  parseTranslationPair(value) {
    return this.TRANSLATION_PAIRS.find(pair => pair.code === value) || null;
  },

  // Translation target for a phrase spoken in `sourceLanguage` under a pair.
  pairTargetFor(pair, sourceLanguage) {
    const source = String(sourceLanguage || '').split('-')[0].toLowerCase();
    return source === pair.primary ? pair.secondary : pair.primary;
  },

  // Short label of a stored translation setting for badges ('vi ↔ en', 'en').
  translationLabel(value) {
    return this.parseTranslationPair(value)?.label || String(value || '');
  },

  toSonioxLanguage(language) {
    const match = this.getSupportedLanguages().find(item =>
      item.code === language || item.sonioxCode === language
    );
    return match?.sonioxCode || String(language || 'vi').split('-')[0].toLowerCase();
  },

  // Language hint for a live session, or '' (auto-detect) when the language
  // is unset or one the live backends cannot recognise.
  toLiveLanguage(language) {
    if (!language || language === 'auto') return '';
    const match = this.getSupportedLanguages().find(item => item.code === language || item.sonioxCode === language);
    if (match?.liveSupported === false) return '';
    return this.toSonioxLanguage(language);
  },

  async start(options = {}) {
    if (!this.isSupported()) {
      this._emitError('not-supported', 'This browser cannot stream audio to Soniox.');
      return false;
    }

    if (this._state !== 'stopped') await this.stop();
    this._resetSession();
    this._state = 'connecting';
    this._emitStatus('connecting');

    try {
      const keyResponse = await fetch('/api/soniox/temporary-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meetingId: options.meetingId || '' })
      });
      const keyData = await keyResponse.json().catch(() => ({}));
      if (!keyResponse.ok || !keyData.apiKey) {
        throw new Error(keyData.error || 'Could not obtain a Soniox temporary key.');
      }

      const sourceLanguage = this.toLiveLanguage(options.language);
      const targetLanguage = this.toSonioxLanguage(options.translationLanguage);
      const pair = this.parseTranslationPair(options.translationLanguage);
      const config = {
        api_key: keyData.apiKey,
        model: 'stt-rt-v5',
        audio_format: 'auto',
        enable_language_identification: true,
        enable_speaker_diarization: true,
        context: this._buildContext(options)
      };

      // A language hint improves accuracy for an expected language, but Soniox may
      // still detect others. Auto mode omits hints for fully multilingual meetings.
      if (sourceLanguage) config.language_hints = [sourceLanguage];

      if (pair) {
        // Both pair languages are expected, so hint them alongside the meeting language.
        config.language_hints = [...new Set([sourceLanguage, pair.primary, pair.secondary].filter(Boolean))];
        config.translation = { type: 'two_way', language_a: pair.primary, language_b: pair.secondary };
      } else if (options.translationLanguage && (!sourceLanguage || targetLanguage !== sourceLanguage)) {
        config.translation = {
          type: 'one_way',
          target_language: targetLanguage
        };
      }

      return await new Promise(resolve => {
        const socket = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket');
        this.websocket = socket;
        socket.binaryType = 'arraybuffer';

        socket.onopen = () => {
          if (this.websocket !== socket) return;
          socket.send(JSON.stringify(config));
          this._opened = true;
          this._state = 'listening';
          this.isListening = true;
          this._emitStatus('listening');
          this._startKeepalive();
          for (const chunk of this._audioQueue) socket.send(chunk);
          this._audioQueue = [];
          if (this._stopRequested) socket.send('');
          resolve(true);
        };

        socket.onmessage = event => {
          if (this.websocket === socket) this._handleMessage(event.data);
        };
        socket.onerror = () => {
          // A socket replaced by a newer session must not touch its state.
          if (this.websocket !== socket) return;
          if (this._state === 'connecting') resolve(false);
          this._emitError('connection-error', 'The Soniox WebSocket connection failed.');
        };
        socket.onclose = event => {
          if (this.websocket !== socket) return;
          if (this._state === 'connecting') resolve(false);
          // An open session that closes without stop() was cut off (network
          // drop, server limit or Soniox error): report it so the facade can
          // reconnect instead of silently ending live transcription.
          const dropped = this._opened && !this._stopRequested;
          const reason = event?.reason || this._lastError;
          this._flushAll();
          this._finishStop();
          if (dropped) this.onDrop?.({ code: event?.code || 0, reason });
        };
      });
    } catch (error) {
      this._state = 'stopped';
      this.isListening = false;
      this._audioQueue = [];
      this._emitError('startup-error', error.message);
      return false;
    }
  },

  sendAudio(chunk) {
    if (!chunk || chunk.size === 0) return;
    if (this._state === 'connecting') {
      this._audioQueue.push(chunk);
      return;
    }
    if (this._state === 'listening' || this._state === 'paused') {
      if (this.websocket?.readyState === WebSocket.OPEN) this.websocket.send(chunk);
    }
  },

  pause() {
    if (this._state !== 'listening') return;
    this.isPaused = true;
    this._state = 'paused';
    this._emitStatus('paused');
  },

  resume() {
    if (this._state !== 'paused') return;
    this.isPaused = false;
    this._state = 'listening';
    this._emitStatus('listening');
  },

  stop() {
    if (this._stopPromise) return this._stopPromise;
    if (this._state === 'stopped') return Promise.resolve();

    this._stopRequested = true;
    this._stopPromise = new Promise(resolve => {
      this._resolveStop = resolve;
      const timeout = setTimeout(() => {
        if (this.websocket?.readyState === WebSocket.OPEN) this.websocket.close();
        this._flushAll();
        this._finishStop();
      }, 10_000);
      const originalResolve = this._resolveStop;
      this._resolveStop = () => {
        clearTimeout(timeout);
        originalResolve();
      };
    });

    if (this.websocket?.readyState === WebSocket.OPEN) {
      this.websocket.send('');
    } else if (this.websocket?.readyState !== WebSocket.CONNECTING) {
      this._finishStop();
    }
    return this._stopPromise;
  },

  _buildContext(options) {
    const general = [
      { key: 'domain', value: 'Business meeting' },
      { key: 'topic', value: String(options.title || 'Meeting').slice(0, 500) }
    ];
    const participants = Array.isArray(options.participants)
      ? options.participants.map(name => String(name).trim()).filter(Boolean).slice(0, 100)
      : [];
    if (participants.length) {
      general.push({ key: 'participants', value: participants.join(', ').slice(0, 2000) });
    }
    return {
      general,
      ...(participants.length ? { terms: participants } : {})
    };
  },

  _handleMessage(rawMessage) {
    let data;
    try {
      data = JSON.parse(rawMessage);
    } catch {
      this._emitError('invalid-response', 'Soniox returned an unreadable response.');
      return;
    }

    if (data.error_code) {
      this._emitError(data.error_type || 'soniox-error', data.error_message || 'Soniox transcription failed.');
      this.websocket?.close();
      return;
    }

    const tokens = Array.isArray(data.tokens) ? data.tokens : [];
    const nonFinal = { original: [], translation: [] };
    for (const token of tokens) {
      if (!token?.text) continue;
      const channel = token.translation_status === 'translation' ? 'translation' : 'original';
      if (token.is_final) this._appendFinalToken(channel, token);
      else nonFinal[channel].push(token);
    }

    for (const channel of ['original', 'translation']) {
      // An untimed (translated) caption with no punctuation must still commit
      // during silence, not only when the next final token arrives.
      if (this._reachedMaxDuration(this._buffers[channel])) this._flush(channel);
      const buffer = this._buffers[channel];
      const pending = nonFinal[channel];
      // Two-way translation: words in the other target language start their own
      // preview instead of being labelled with the buffer's language.
      const pendingLanguage = pending[0]?.language || '';
      const ownPreview = channel === 'translation' && buffer.text && buffer.language && pendingLanguage && pendingLanguage !== buffer.language;
      const head = ownPreview ? this._emptyBuffer() : buffer;
      const preview = `${head.text}${pending.map(token => token.text).join('')}`;
      if (preview.trim()) {
        this.onResult?.({
          channel,
          text: preview.trim(),
          isFinal: false,
          timestamp: head.startMs / 1000 || this._tokenStart(pending[0]) / 1000,
          speaker: head.speaker || pending[0]?.speaker || '',
          language: head.language || pending[0]?.language || '',
          sourceLanguage: head.sourceLanguage || pending[0]?.source_language || ''
        });
      }
    }

    if (data.finished) {
      this._flushAll();
      this.websocket?.close();
    }
  },

  MAX_SEGMENT_MS: 6_000,

  _appendFinalToken(channel, token) {
    let buffer = this._buffers[channel];
    const speaker = token.speaker || buffer.speaker || '';
    const language = token.language || token.source_language || '';
    // Translated tokens carry no timestamps; they are placed at the latest
    // spoken position so the caption lands next to its original speech.
    const timed = Boolean(Number(token.start_ms) || Number(token.end_ms));
    const startMs = timed ? this._tokenStart(token) : this._lastSpokenMs;
    const endMs = timed ? (Number(token.end_ms) || startMs) : startMs;
    if (timed && channel === 'original') this._lastSpokenMs = startMs;

    if (buffer.text && speaker && buffer.speaker && speaker !== buffer.speaker) {
      this._flush(channel);
    }
    // A two-way translation alternates target languages; keep each caption in one.
    if (channel === 'translation' && buffer.text && language && buffer.language && language !== buffer.language) {
      this._flush(channel);
    }
    // _flush() swaps in a fresh buffer; the token must go into that one, or it is lost.
    buffer = this._buffers[channel];

    if (!buffer.text) {
      buffer.startMs = startMs;
      buffer.speaker = speaker;
      buffer.language = language;
      buffer.sourceLanguage = token.source_language || '';
      buffer.openedAt = Date.now();
      buffer.untimed = !timed;
    }
    buffer.text += token.text;
    buffer.endMs = endMs;

    // A sentence end may be followed by a closing quote or bracket ('?"').
    const hasSentenceBoundary = /[.!?。！？…]["'”’»)\]]*\s*$/.test(buffer.text);
    // Commit a segment at least every 6s of continuous speech. Speakers without
    // clear sentence pauses (e.g. a fast foreign client) otherwise only surface
    // on screen in one lump when the cap is hit, making the live transcript feel
    // laggy. A shorter cap keeps committed text flowing while the growing buffer
    // still shows as a live interim line between commits. Untimed (translated)
    // text is capped by the clock instead, or it would never commit without
    // punctuation and the translation column would stall.
    if (hasSentenceBoundary || this._reachedMaxDuration(buffer)) this._flush(channel);
  },

  _reachedMaxDuration(buffer) {
    if (!buffer?.text) return false;
    return buffer.untimed
      ? Date.now() - buffer.openedAt >= this.MAX_SEGMENT_MS
      : buffer.startMs > 0 && buffer.endMs - buffer.startMs >= this.MAX_SEGMENT_MS;
  },

  _flush(channel) {
    const buffer = this._buffers[channel];
    const text = buffer.text.trim();
    if (text) {
      this.onResult?.({
        channel,
        text,
        isFinal: true,
        timestamp: buffer.startMs / 1000,
        speaker: buffer.speaker,
        language: buffer.language,
        sourceLanguage: buffer.sourceLanguage
      });
    }
    this._buffers[channel] = this._emptyBuffer();
  },

  _flushAll() {
    if (!this._buffers) return;
    this._flush('original');
    this._flush('translation');
  },

  _tokenStart(token) {
    return Number(token?.start_ms) || Number(token?.end_ms) || 0;
  },

  _emptyBuffer() {
    return { text: '', startMs: 0, endMs: 0, speaker: '', language: '', sourceLanguage: '', openedAt: 0, untimed: false };
  },

  _resetSession() {
    this.websocket = null;
    this.isListening = false;
    this.isPaused = false;
    this._audioQueue = [];
    this._buffers = {
      original: this._emptyBuffer(),
      translation: this._emptyBuffer()
    };
    this._lastSpokenMs = 0;
    this._stopPromise = null;
    this._resolveStop = null;
    this._stopRequested = false;
    this._opened = false;
    this._lastError = '';
    this._stopKeepalive();
  },

  _startKeepalive() {
    this._stopKeepalive();
    this._keepaliveInterval = setInterval(() => {
      if (this.websocket?.readyState === WebSocket.OPEN) {
        this.websocket.send(JSON.stringify({ type: 'keepalive' }));
      }
    }, 15_000);
  },

  _stopKeepalive() {
    if (this._keepaliveInterval) {
      clearInterval(this._keepaliveInterval);
      this._keepaliveInterval = null;
    }
  },

  _finishStop() {
    this._stopKeepalive();
    this._state = 'stopped';
    this.isListening = false;
    this.isPaused = false;
    this.websocket = null;
    this._audioQueue = [];
    this._emitStatus('stopped');
    const resolve = this._resolveStop;
    this._resolveStop = null;
    this._stopPromise = null;
    if (resolve) resolve();
  },

  _emitStatus(status) {
    this.onStatusChange?.(status);
  },

  _emitError(error, message) {
    console.error(`Transcriber ${error}:`, message);
    this._lastError = message;
    this._state = 'error';
    this.isListening = false;
    this.onError?.({ error, message });
    this._emitStatus('error');
  }
};

/* ============================================
   Deepgram Realtime Transcriber
   Streams MediaRecorder WebM/Opus chunks to Deepgram's
   live WebSocket. Auth uses a short-lived token minted by
   the server (never the raw API key), passed as the
   `access_token` query param. Emits the same onResult
   shape as SonioxTranscriber. No live translation.
   ============================================ */

const DeepgramTranscriber = {
  websocket: null,
  isListening: false,
  isPaused: false,
  onResult: null,
  onError: null,
  onStatusChange: null,
  onDrop: null,
  _state: 'stopped',
  _audioQueue: [],
  _keepaliveInterval: null,
  _stopPromise: null,
  _resolveStop: null,
  _stopRequested: false,
  _opened: false,
  _lastError: '',

  isSupported() {
    return typeof WebSocket !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== 'undefined';
  },

  // Deepgram accepts 2-letter language codes; reuse the shared language table.
  toDeepgramLanguage(language) {
    return SonioxTranscriber.toLiveLanguage(language);
  },

  async start(options = {}) {
    if (!this.isSupported()) {
      this._emitError('not-supported', 'This browser cannot stream audio to Deepgram.');
      return false;
    }
    if (this._state !== 'stopped') await this.stop();
    this._resetSession();
    this._state = 'connecting';
    this._emitStatus('connecting');

    try {
      const keyResponse = await fetch('/api/stt/providers/deepgram/temporary-key', { method: 'POST' });
      const keyData = await keyResponse.json().catch(() => ({}));
      if (!keyResponse.ok || !keyData.apiKey) {
        throw new Error(keyData.error?.message || keyData.error || 'Could not obtain a Deepgram temporary token.');
      }

      const params = new URLSearchParams({
        model: 'nova-3',
        smart_format: 'true',
        punctuate: 'true',
        interim_results: 'true',
        diarize: 'true'
      });
      // nova-3 `multi` auto-detects/code-switches; an explicit hint overrides it.
      const language = this.toDeepgramLanguage(options.language);
      params.set('language', language || 'multi');

      return await new Promise(resolve => {
        // Auth via the WebSocket subprotocol (browser-safe): the grant token is
        // the short-lived JWT minted by the server, never the raw API key.
        const socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, ['bearer', keyData.apiKey]);
        this.websocket = socket;
        socket.binaryType = 'arraybuffer';

        socket.onopen = () => {
          if (this.websocket !== socket) return;
          this._opened = true;
          this._state = 'listening';
          this.isListening = true;
          this._emitStatus('listening');
          this._startKeepalive();
          for (const chunk of this._audioQueue) socket.send(chunk);
          this._audioQueue = [];
          if (this._stopRequested) socket.send(JSON.stringify({ type: 'CloseStream' }));
          resolve(true);
        };
        socket.onmessage = event => {
          if (this.websocket === socket) this._handleMessage(event.data);
        };
        socket.onerror = () => {
          if (this.websocket !== socket) return;
          if (this._state === 'connecting') resolve(false);
          this._emitError('connection-error', 'The Deepgram WebSocket connection failed.');
        };
        socket.onclose = event => {
          if (this.websocket !== socket) return;
          if (this._state === 'connecting') resolve(false);
          const dropped = this._opened && !this._stopRequested;
          const reason = event?.reason || this._lastError;
          this._finishStop();
          if (dropped) this.onDrop?.({ code: event?.code || 0, reason });
        };
      });
    } catch (error) {
      this._state = 'stopped';
      this.isListening = false;
      this._audioQueue = [];
      this._emitError('startup-error', error.message);
      return false;
    }
  },

  sendAudio(chunk) {
    if (!chunk || chunk.size === 0) return;
    if (this._state === 'connecting') {
      this._audioQueue.push(chunk);
      return;
    }
    if ((this._state === 'listening' || this._state === 'paused') && this.websocket?.readyState === WebSocket.OPEN) {
      this.websocket.send(chunk);
    }
  },

  pause() {
    if (this._state !== 'listening') return;
    this.isPaused = true;
    this._state = 'paused';
    this._emitStatus('paused');
  },

  resume() {
    if (this._state !== 'paused') return;
    this.isPaused = false;
    this._state = 'listening';
    this._emitStatus('listening');
  },

  stop() {
    if (this._stopPromise) return this._stopPromise;
    if (this._state === 'stopped') return Promise.resolve();

    this._stopRequested = true;
    this._stopPromise = new Promise(resolve => {
      this._resolveStop = resolve;
      const timeout = setTimeout(() => {
        if (this.websocket?.readyState === WebSocket.OPEN) this.websocket.close();
        this._finishStop();
      }, 10_000);
      const originalResolve = this._resolveStop;
      this._resolveStop = () => { clearTimeout(timeout); originalResolve(); };
    });

    if (this.websocket?.readyState === WebSocket.OPEN) {
      // Ask Deepgram to flush the final transcript, then close the stream.
      this.websocket.send(JSON.stringify({ type: 'CloseStream' }));
    } else if (this.websocket?.readyState !== WebSocket.CONNECTING) {
      this._finishStop();
    }
    return this._stopPromise;
  },

  _handleMessage(rawMessage) {
    let data;
    try {
      data = JSON.parse(rawMessage);
    } catch {
      return; // ignore non-JSON frames
    }

    if (data.type === 'Error' || data.error) {
      this._emitError(data.type || 'deepgram-error', data.description || data.message || 'Deepgram transcription failed.');
      this.websocket?.close();
      return;
    }
    if (data.type && data.type !== 'Results') return; // Metadata / SpeechStarted etc.

    const alternative = data.channel?.alternatives?.[0];
    const text = String(alternative?.transcript || '').trim();
    if (!text) return;

    const firstWord = (alternative.words || [])[0] || {};
    const speaker = Number.isFinite(Number(firstWord.speaker)) ? `Speaker ${Number(firstWord.speaker) + 1}` : '';
    this.onResult?.({
      channel: 'original',
      text,
      isFinal: Boolean(data.is_final),
      timestamp: Number(data.start) || Number(firstWord.start) || 0,
      speaker,
      language: ''
    });
  },

  _resetSession() {
    this.websocket = null;
    this.isListening = false;
    this.isPaused = false;
    this._audioQueue = [];
    this._stopPromise = null;
    this._resolveStop = null;
    this._stopRequested = false;
    this._opened = false;
    this._lastError = '';
    this._stopKeepalive();
  },

  _startKeepalive() {
    this._stopKeepalive();
    this._keepaliveInterval = setInterval(() => {
      if (this.websocket?.readyState === WebSocket.OPEN) {
        this.websocket.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, 8_000);
  },

  _stopKeepalive() {
    if (this._keepaliveInterval) {
      clearInterval(this._keepaliveInterval);
      this._keepaliveInterval = null;
    }
  },

  _finishStop() {
    this._stopKeepalive();
    this._state = 'stopped';
    this.isListening = false;
    this.isPaused = false;
    this.websocket = null;
    this._audioQueue = [];
    this._emitStatus('stopped');
    const resolve = this._resolveStop;
    this._resolveStop = null;
    this._stopPromise = null;
    if (resolve) resolve();
  },

  _emitStatus(status) {
    this.onStatusChange?.(status);
  },

  _emitError(error, message) {
    console.error(`Deepgram ${error}:`, message);
    this._lastError = message;
    this._state = 'error';
    this.isListening = false;
    this.onError?.({ error, message });
    this._emitStatus('error');
  }
};

/* ============================================
   Azure Speech live transcriber
   Streams the recording's audio (mic, or mic + system audio)
   to Azure Speech through the Speech SDK, which recognizes
   and translates in one pass: the spoken text arrives on the
   'original' channel and its translation on 'translation'.
   Used for languages the other live backends cannot hear
   (Khmer) and whenever Azure Speech is the selected provider.
   Auth is a 10-minute token minted by the server (never the
   key), refreshed before it expires. The SDK loads on first use.
   ============================================ */

const AzureSpeechTranscriber = {
  SDK_URL: 'js/third-party/azure-speech-sdk/speech-sdk.min.js',
  SAMPLE_RATE: 16000,              // Azure push streams take 16 kHz, 16-bit, mono PCM
  TOKEN_REFRESH_MS: 8 * 60 * 1000, // tokens live 10 minutes
  TOKEN_RETRY_MS: 30 * 1000,
  consumesAudioChunks: false,      // reads the MediaStream itself, not MediaRecorder chunks
  isListening: false,
  isPaused: false,
  onResult: null,
  onError: null,
  onStatusChange: null,
  onDrop: null,
  _state: 'stopped',
  _session: 0,
  _sdkPromise: null,
  _recognizer: null,
  _pushStream: null,
  _audioContext: null,
  _source: null,
  _processor: null,
  _tokenTimer: null,
  _targets: [],
  _pair: null,
  _stopPromise: null,
  _resolveStop: null,
  _stopRequested: false,
  _opened: false,
  _lastError: '',

  isSupported() {
    return typeof AudioContext !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  },

  // Recognition needs a full locale ('km-KH'); plain Auto-detect is not supported here.
  toRecognitionLocale(language) {
    if (!language || language === 'auto') return '';
    const match = SonioxTranscriber.getSupportedLanguages().find(item => item.code === language);
    if (match) return match.candidates ? '' : match.code;
    return /^[a-z]{2,3}-[A-Z]{2}$/.test(language) ? language : '';
  },

  // Candidate locales for a language set (e.g. Khmer / Vietnamese / English),
  // detected phrase by phrase; [] for a single language.
  toCandidateLocales(language) {
    const match = SonioxTranscriber.getSupportedLanguages().find(item => item.code === language);
    return match?.candidates ? [...match.candidates] : [];
  },

  // Translation targets use Translator codes ('vi', 'zh-Hans').
  toTargetLanguage(language) {
    const code = String(language || '').trim().toLowerCase();
    if (!code) return '';
    if (code === 'zh' || code === 'zh-cn' || code === 'zh-hans') return 'zh-Hans';
    if (code === 'zh-tw' || code === 'zh-hant') return 'zh-Hant';
    return code.split('-')[0];
  },

  _loadSdk() {
    if (window.SpeechSDK) return Promise.resolve(window.SpeechSDK);
    if (!this._sdkPromise) {
      this._sdkPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = this.SDK_URL;
        script.onload = () => (window.SpeechSDK ? resolve(window.SpeechSDK) : reject(new Error('The Azure Speech SDK did not load.')));
        script.onerror = () => reject(new Error('Could not load the Azure Speech SDK.'));
        document.head.appendChild(script);
      }).catch(error => {
        this._sdkPromise = null;
        throw error;
      });
    }
    return this._sdkPromise;
  },

  async _fetchToken() {
    const response = await fetch('/api/stt/providers/azure/temporary-key', { method: 'POST' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.token) {
      throw new Error(data.error?.message || data.error || 'Could not obtain an Azure Speech token.');
    }
    return data;
  },

  /**
   * @param {Object} options
   * @param {string} options.language - Spoken locale, e.g. 'km-KH'.
   * @param {string} [options.translationLanguage] - Target code, e.g. 'vi'.
   * @param {() => MediaStream} options.getAudioStream - The stream being recorded.
   */
  async start(options = {}) {
    if (!this.isSupported()) {
      this._emitError('not-supported', 'This browser cannot stream audio to Azure Speech.');
      return false;
    }
    if (this._state !== 'stopped') await this.stop();
    const session = ++this._session;
    this._resetSession();
    this._state = 'connecting';
    this._emitStatus('connecting');

    try {
      const locale = this.toRecognitionLocale(options.language);
      const candidates = locale ? [] : this.toCandidateLocales(options.language);
      if (!locale && !candidates.length) throw new Error('Azure Speech live needs a spoken language: choose one (for example Khmer, or Khmer / Tiếng Việt / English) instead of Auto-detect.');
      const stream = options.getAudioStream?.();
      if (!stream) throw new Error('No audio stream is available for Azure Speech.');

      const [SDK, auth] = await Promise.all([this._loadSdk(), this._fetchToken()]);
      if (session !== this._session) return false; // stopped while connecting

      const sourceBase = locale ? locale.split('-')[0].toLowerCase() : '';
      const pair = SonioxTranscriber.parseTranslationPair(options.translationLanguage);
      this._pair = pair;
      if (pair) {
        // One spoken language needs only its own target; a language set needs
        // both, and each phrase keeps the one its detected language maps to.
        this._targets = sourceBase ? [SonioxTranscriber.pairTargetFor(pair, sourceBase)] : [pair.primary, pair.secondary];
      } else {
        const target = this.toTargetLanguage(options.translationLanguage);
        // A single source language equal to the target needs no translation;
        // with a language set, phrases in the other languages still do.
        this._targets = target && target.toLowerCase() !== sourceBase ? [target] : [];
      }
      const translating = this._targets.length > 0;

      this._pushStream = SDK.AudioInputStream.createPushStream(
        SDK.AudioStreamFormat.getWaveFormatPCM(this.SAMPLE_RATE, 16, 1)
      );
      const audioConfig = SDK.AudioConfig.fromStreamInput(this._pushStream);
      const config = translating
        ? SDK.SpeechTranslationConfig.fromAuthorizationToken(auth.token, auth.region)
        : SDK.SpeechConfig.fromAuthorizationToken(auth.token, auth.region);
      for (const target of this._targets) config.addTargetLanguage(target);
      if (locale) {
        config.speechRecognitionLanguage = locale;
        this._recognizer = translating
          ? new SDK.TranslationRecognizer(config, audioConfig)
          : new SDK.SpeechRecognizer(config, audioConfig);
      } else {
        // Continuous language identification: every phrase is matched to one
        // of the candidates, so speakers can switch language mid-meeting.
        config.setProperty(SDK.PropertyId.SpeechServiceConnection_LanguageIdMode, 'Continuous');
        const autoDetect = SDK.AutoDetectSourceLanguageConfig.fromLanguages(candidates);
        autoDetect.mode = SDK.LanguageIdMode.Continuous;
        this._recognizer = translating
          ? SDK.TranslationRecognizer.FromConfig(config, autoDetect, audioConfig)
          : SDK.SpeechRecognizer.FromConfig(config, autoDetect, audioConfig);
      }
      this._bindRecognizer(SDK, this._recognizer, session, sourceBase);
      await this._startCapture(stream, session);

      const recognizer = this._recognizer;
      await new Promise((resolve, reject) => {
        recognizer.startContinuousRecognitionAsync(resolve, error => reject(new Error(String(error || 'Azure Speech could not start.'))));
      });
      if (session !== this._session) return false;

      this._opened = true;
      this._state = 'listening';
      this.isListening = true;
      this._emitStatus('listening');
      this._scheduleTokenRefresh(session, this.TOKEN_REFRESH_MS);
      return true;
    } catch (error) {
      if (session !== this._session) return false;
      this._teardown();
      this._state = 'stopped';
      this.isListening = false;
      this._emitError('startup-error', error.message);
      return false;
    }
  },

  // Target to show for a phrase in `language`: a pair maps it per phrase.
  _targetFor(language) {
    if (!this._pair) return this._targets[0] || '';
    const target = SonioxTranscriber.pairTargetFor(this._pair, language);
    return this._targets.includes(target) ? target : '';
  },

  _bindRecognizer(SDK, recognizer, session, sourceLanguage) {
    const current = () => session === this._session;
    const emit = (result, isFinal) => {
      // Offsets are in 100-nanosecond ticks from the start of this session's audio.
      const timestamp = Number(result.offset || 0) / 1e7;
      const text = String(result.text || '').trim();
      // With a language set, each phrase reports the locale it was detected as.
      const language = sourceLanguage || String(result.language || '').split('-')[0].toLowerCase();
      if (text) this.onResult?.({ channel: 'original', text, isFinal, timestamp, speaker: '', language });
      const target = this._targetFor(language);
      const translated = target ? String(result.translations?.get(target) || '').trim() : '';
      if (translated) this.onResult?.({ channel: 'translation', text: translated, isFinal, timestamp, speaker: '', language: target, sourceLanguage: language });
    };

    recognizer.recognizing = (_sender, event) => {
      if (current() && !this.isPaused) emit(event.result, false);
    };
    recognizer.recognized = (_sender, event) => {
      if (!current()) return;
      const reason = event.result?.reason;
      if (reason === SDK.ResultReason.TranslatedSpeech || reason === SDK.ResultReason.RecognizedSpeech) emit(event.result, true);
    };
    recognizer.canceled = (_sender, event) => {
      if (!current()) return;
      if (event.reason === SDK.CancellationReason.Error && !this._stopRequested) {
        this._emitError('azure-error', event.errorDetails || 'Azure Speech stopped recognizing.');
      }
      this._handleClosed();
    };
    recognizer.sessionStopped = () => {
      if (current()) this._handleClosed();
    };
  },

  // Feed the recorded stream to the push stream as 16 kHz 16-bit PCM. Paused
  // audio is not sent, so it is neither transcribed nor billed.
  async _startCapture(stream, session = this._session) {
    let context;
    try {
      context = new AudioContext({ sampleRate: this.SAMPLE_RATE });
    } catch {
      context = new AudioContext(); // resampled below
    }
    if (context.state === 'suspended') await context.resume().catch(() => {});
    // Stopped while the context was resuming: nothing will tear this one down.
    if (session !== this._session) {
      context.close().catch(() => {});
      return;
    }
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const ratio = context.sampleRate / this.SAMPLE_RATE;
    processor.onaudioprocess = event => {
      if (this.isPaused || !this._pushStream) return;
      const pcm = this.toPcm16(event.inputBuffer.getChannelData(0), ratio);
      if (pcm.length) this._pushStream.write(pcm.buffer);
    };
    source.connect(processor);
    // A ScriptProcessor only runs while connected to an output; it writes silence.
    processor.connect(context.destination);
    this._audioContext = context;
    this._source = source;
    this._processor = processor;
  },

  // Float samples → 16-bit PCM, averaging blocks when the context runs faster than 16 kHz.
  toPcm16(input, ratio = 1) {
    const length = ratio > 1 ? Math.floor(input.length / ratio) : input.length;
    const pcm = new Int16Array(length);
    for (let i = 0; i < length; i++) {
      let sample;
      if (ratio > 1) {
        const start = Math.floor(i * ratio);
        const end = Math.min(input.length, Math.floor((i + 1) * ratio));
        let sum = 0;
        for (let j = start; j < end; j++) sum += input[j];
        sample = end > start ? sum / (end - start) : 0;
      } else {
        sample = input[i];
      }
      const clamped = Math.max(-1, Math.min(1, sample));
      pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    return pcm;
  },

  _stopCapture() {
    if (this._processor) this._processor.onaudioprocess = null;
    try { this._source?.disconnect(); } catch { /* already disconnected */ }
    try { this._processor?.disconnect(); } catch { /* already disconnected */ }
    this._audioContext?.close().catch(() => {});
    this._audioContext = null;
    this._source = null;
    this._processor = null;
  },

  _scheduleTokenRefresh(session, delay) {
    clearTimeout(this._tokenTimer);
    this._tokenTimer = setTimeout(async () => {
      if (session !== this._session || !this._recognizer) return;
      let next = this.TOKEN_REFRESH_MS;
      try {
        const auth = await this._fetchToken();
        if (session === this._session && this._recognizer) this._recognizer.authorizationToken = auth.token;
      } catch (error) {
        console.warn('Azure Speech token refresh failed:', error.message);
        next = this.TOKEN_RETRY_MS;
      }
      this._scheduleTokenRefresh(session, next);
    }, delay);
  },

  sendAudio() { /* audio comes from the MediaStream, not MediaRecorder chunks */ },

  pause() {
    if (this._state !== 'listening') return;
    this.isPaused = true;
    this._state = 'paused';
    this._emitStatus('paused');
  },

  resume() {
    if (this._state !== 'paused') return;
    this.isPaused = false;
    this._state = 'listening';
    this._emitStatus('listening');
  },

  stop() {
    if (this._stopPromise) return this._stopPromise;
    if (this._state === 'stopped') return Promise.resolve();
    this._stopRequested = true;
    const recognizer = this._recognizer;
    this._stopPromise = new Promise(resolve => {
      this._resolveStop = resolve;
      if (!recognizer || !this._opened) {
        this._finishStop();
        return;
      }
      // Stop feeding audio and close the stream so the last phrase is
      // finalized, then stop recognition.
      this._stopCapture();
      try { this._pushStream?.close(); } catch { /* already closed */ }
      // The SDK callback can still fire after the timeout; finishing twice would
      // tear down a session that a reconnect has started since.
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this._finishStop();
      };
      const timeout = setTimeout(done, 10_000);
      recognizer.stopContinuousRecognitionAsync(done, done);
    });
    return this._stopPromise;
  },

  // The service ended the session (error, network loss, or our own stop).
  _handleClosed() {
    if (this._state === 'stopped' || this._stopRequested) return;
    const dropped = this._opened;
    const reason = this._lastError;
    this._finishStop();
    if (dropped) this.onDrop?.({ code: 0, reason });
  },

  _teardown() {
    this._stopCapture();
    clearTimeout(this._tokenTimer);
    this._tokenTimer = null;
    try { this._pushStream?.close(); } catch { /* already closed */ }
    this._pushStream = null;
    const recognizer = this._recognizer;
    this._recognizer = null;
    if (recognizer) {
      try { recognizer.close(); } catch { /* already closed */ }
    }
  },

  _resetSession() {
    this._teardown();
    this.isListening = false;
    this.isPaused = false;
    this._targets = [];
    this._pair = null;
    this._stopPromise = null;
    this._resolveStop = null;
    this._stopRequested = false;
    this._opened = false;
    this._lastError = '';
  },

  _finishStop() {
    this._session += 1; // late SDK callbacks from this session are ignored
    this._teardown();
    this._state = 'stopped';
    this.isListening = false;
    this.isPaused = false;
    this._emitStatus('stopped');
    const resolve = this._resolveStop;
    this._resolveStop = null;
    this._stopPromise = null;
    if (resolve) resolve();
  },

  _emitStatus(status) {
    this.onStatusChange?.(status);
  },

  _emitError(error, message) {
    console.error(`Azure Speech ${error}:`, message);
    this._lastError = message;
    if (this._state !== 'stopped') this._state = 'error';
    this.isListening = false;
    this.onError?.({ error, message });
    this._emitStatus('error');
  }
};

/* ============================================
   Transcriber facade
   Provider-agnostic entry point used by the app. Shared,
   provider-independent methods (language lists, support
   check) delegate to Soniox; a live session is routed to
   the backend matching the selected STT provider. Soniox,
   Deepgram and Azure Speech stream live; other providers
   fall back to Soniox. A spoken language Soniox/Deepgram
   cannot hear (Khmer) always goes to Azure Speech.
   ============================================ */

const Transcriber = {
  _active: null,
  onResult: null,
  onError: null,
  onStatusChange: null, // backend statuses plus 'reconnecting' / 'reconnected' after a drop
  _options: null,
  _backendOptions: null,
  _stopping: false,
  _paused: false,
  _offsetSeconds: 0,
  _reconnecting: false,
  _reconnectAttempt: 0,
  _reconnectTimer: null,

  isSupported() { return SonioxTranscriber.isSupported(); },
  getSupportedLanguages() { return SonioxTranscriber.getSupportedLanguages(); },
  getTranslationLanguages() { return SonioxTranscriber.getTranslationLanguages(); },
  getTranslationPairs() { return SonioxTranscriber.getTranslationPairs(); },
  translationLabel(value) { return SonioxTranscriber.translationLabel(value); },

  get isListening() { return this._active?.isListening || false; },
  get isPaused() { return this._active?.isPaused || false; },

  // Pick the live backend from the selected STT provider. Only providers that
  // can stream are eligible; anything else records live through Soniox. A
  // language marked liveSupported:false (Khmer) is heard only by Azure Speech.
  // A meeting may pin its own provider (the Khmer mode pins Azure Speech).
  _resolveBackend(options = {}) {
    const provider = options.provider || (typeof Storage !== 'undefined' && Storage.getSettings?.().sttProvider) || 'soniox';
    const language = SonioxTranscriber.getSupportedLanguages().find(item => item.code === options.language);
    if (language?.liveSupported === false) return AzureSpeechTranscriber;
    // Azure Speech needs a spoken language (or a language set); an Auto-detect
    // meeting records with Soniox even when Azure is the selected provider.
    const azureCanHear = Boolean(AzureSpeechTranscriber.toRecognitionLocale(options.language) ||
      AzureSpeechTranscriber.toCandidateLocales(options.language).length);
    if (provider === 'azure' && azureCanHear) return AzureSpeechTranscriber;
    return provider === 'deepgram' ? DeepgramTranscriber : SonioxTranscriber;
  },

  // Short name of the live backend for status badges.
  liveProviderLabel(options) {
    const backend = options ? this._resolveBackend(options) : (this._active || this._resolveBackend());
    if (backend === AzureSpeechTranscriber) return 'Azure Speech';
    return backend === DeepgramTranscriber ? 'Deepgram' : 'Soniox';
  },

  // Soniox translates natively into the languages it knows; every other
  // backend/target pair (Deepgram, or a Khmer target) uses Azure Translator.
  _needsExternalTranslation(backend, options) {
    const target = options.translationLanguage || '';
    if (!target || backend === AzureSpeechTranscriber) return false; // Azure translates in the same pass
    // Soniox runs a pair as two_way translation; other backends use Translator.
    if (SonioxTranscriber.parseTranslationPair(target)) return backend !== SonioxTranscriber;
    const source = SonioxTranscriber.toLiveLanguage(options.language);
    if (source && source === SonioxTranscriber.toSonioxLanguage(target)) return false;
    return backend !== SonioxTranscriber || !SonioxTranscriber.toLiveLanguage(target);
  },

  // Translate one finalized original segment and emit it on the translation
  // channel. Calls are chained so captions keep the speaking order.
  _queueTranslation(result, target) {
    this._translationChain = this._translationChain.then(async () => {
      try {
        const response = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // `from` lets the server pick a pair's target; '' makes it detect the language.
          body: JSON.stringify({ texts: [result.text], to: target, from: [result.language || ''] })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error?.message || data.error || 'Translation failed');
        const text = String(data.translations?.[0] || '').trim();
        if (text) {
          const language = data.targets?.[0] || target;
          this.onResult?.({ channel: 'translation', text, isFinal: true, timestamp: result.timestamp, speaker: result.speaker, language, sourceLanguage: result.language || '' });
        }
      } catch (error) {
        // Report once per session; the transcript keeps going without captions.
        if (!this._translationErrorShown) {
          this._translationErrorShown = true;
          this.onError?.({ error: 'translation', message: `Live translation stopped: ${error.message}` });
        }
      }
    });
  },

  // Reconnect backoff after a live session drops: 1s, 2s, 4s … capped at 30s,
  // retried for as long as the recording runs.
  RECONNECT_BASE_MS: 1_000,
  RECONNECT_MAX_MS: 30_000,

  /**
   * Start a live session.
   * @param {Object} options
   * @param {() => number} [options.restartAudioFeed] - Starts a fresh audio
   *   encoder for the live stream (a new socket needs a new container header)
   *   and returns the recording position, in seconds, where it begins.
   * @param {(level, event, message, context) => void} [options.log] - Persist a diagnostic event.
   */
  async start(options = {}) {
    const backend = this._resolveBackend(options);
    if (this._active && this._active !== backend) {
      try { await this._active.stop(); } catch { /* ignore */ }
    }
    this._clearReconnect();
    this._active = backend;
    this._options = options;
    this._stopping = false;
    this._paused = false;
    this._offsetSeconds = 0;
    this._translationChain = Promise.resolve();
    this._translationErrorShown = false;
    const external = this._needsExternalTranslation(backend, options);
    const target = options.translationLanguage;
    backend.onResult = rawResult => {
      // Each reconnected session restarts its clock at 0; shift it onto the
      // recording timeline so segments keep their real position.
      const result = this._offsetSeconds
        ? { ...rawResult, timestamp: (Number(rawResult.timestamp) || 0) + this._offsetSeconds }
        : rawResult;
      this.onResult?.(result);
      if (external && result.isFinal && result.channel !== 'translation' && result.text?.trim()) {
        this._queueTranslation(result, target);
      }
    };
    backend.onError = error => {
      this._log('error', 'live_transcription_error', error.message, { provider: this._providerName(), error: error.error });
      // Failed attempts while reconnecting show as the reconnecting status, not a toast each.
      if (!this._reconnecting) this.onError?.(error);
    };
    backend.onStatusChange = status => {
      // While reconnecting, the facade alone reports progress ('reconnecting',
      // then 'reconnected'); a paused meeting keeps its paused badge.
      if (this._reconnecting) return;
      if (status === 'listening' && this._paused) return;
      this.onStatusChange?.(status);
    };
    backend.onDrop = info => this._handleDrop(info);
    this._backendOptions = external ? { ...options, translationLanguage: '' } : options;
    return backend.start(this._backendOptions);
  },

  _handleDrop(info = {}) {
    if (this._stopping) return;
    this._log('warn', 'live_transcription_dropped', info.reason || 'Live transcription connection closed', {
      provider: this._providerName(),
      code: info.code || 0
    });
    this._reconnecting = true;
    this._reconnectAttempt = 0;
    this.onStatusChange?.('reconnecting');
    this._scheduleReconnect();
  },

  _scheduleReconnect() {
    if (this._stopping) return;
    const delay = Math.min(this.RECONNECT_MAX_MS, this.RECONNECT_BASE_MS * 2 ** this._reconnectAttempt);
    this._reconnectAttempt += 1;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._reconnect().catch(error => {
        this._log('error', 'live_transcription_reconnect_failed', error.message, { provider: this._providerName() });
        this._scheduleReconnect();
      });
    }, delay);
  },

  async _reconnect() {
    const backend = this._active;
    if (this._stopping || !backend) return;
    // Settle any half-closed session first so start() sets 'connecting'
    // synchronously and queues the fresh feed's header chunk.
    if (backend._state !== 'stopped') await backend.stop();
    if (this._stopping) return;

    const attempt = this._reconnectAttempt;
    const started = backend.start(this._backendOptions);
    // A backend that reads the MediaStream itself needs no new encoder feed,
    // only the recording position its fresh session clock starts from.
    const offset = backend.consumesAudioChunks === false
      ? this._options?.getElapsedSeconds?.()
      : this._options?.restartAudioFeed?.();
    if (Number.isFinite(offset)) this._offsetSeconds = offset;
    const ok = await started;

    if (this._stopping) {
      if (ok) await backend.stop();
      return;
    }
    if (!ok) {
      this._scheduleReconnect();
      return;
    }
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    if (this._paused) backend.pause();
    this._log('info', 'live_transcription_reconnected', 'Live transcription reconnected', {
      provider: this._providerName(),
      attempt,
      offsetSeconds: this._offsetSeconds
    });
    this.onStatusChange?.(this._paused ? 'paused' : 'reconnected');
  },

  _clearReconnect() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
  },

  _providerName() {
    if (this._active === AzureSpeechTranscriber) return 'azure';
    return this._active === DeepgramTranscriber ? 'deepgram' : 'soniox';
  },

  _log(level, event, message, context = {}) {
    try { this._options?.log?.(level, event, String(message || ''), context); } catch { /* logging is best effort */ }
  },

  sendAudio(chunk) { this._active?.sendAudio(chunk); },
  pause() {
    this._paused = true;
    this._active?.pause();
  },
  resume() {
    this._paused = false;
    this._active?.resume();
  },
  // Let in-flight caption translations land before the meeting is saved.
  async stop() {
    this._stopping = true;
    this._clearReconnect();
    if (this._active) await this._active.stop();
    await (this._translationChain || Promise.resolve());
  }
};
