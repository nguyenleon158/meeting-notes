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
      // Neither live backend (Soniox, Deepgram) knows Khmer; it is transcribed
      // from uploaded recordings by providers that do (Azure, Google, Whisper).
      { code: 'km-KH', sonioxCode: 'km', name: 'ភាសាខ្មែរ (Khmer)', liveSupported: false }
    ];
  },

  // Translation targets. Languages Soniox cannot translate into (Khmer) are
  // still offered: the Transcriber facade routes them to Azure Translator.
  getTranslationLanguages() {
    const seen = new Set();
    return this.getSupportedLanguages().filter(language => {
      if (seen.has(language.sonioxCode)) return false;
      seen.add(language.sonioxCode);
      return true;
    });
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

      if (options.translationLanguage && (!sourceLanguage || targetLanguage !== sourceLanguage)) {
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
      const buffer = this._buffers[channel];
      const preview = `${buffer.text}${nonFinal[channel].map(token => token.text).join('')}`;
      if (preview.trim()) {
        this.onResult?.({
          channel,
          text: preview.trim(),
          isFinal: false,
          timestamp: buffer.startMs / 1000 || this._tokenStart(nonFinal[channel][0]) / 1000,
          speaker: buffer.speaker || nonFinal[channel][0]?.speaker || '',
          language: buffer.language || nonFinal[channel][0]?.language || ''
        });
      }
    }

    if (data.finished) {
      this._flushAll();
      this.websocket?.close();
    }
  },

  _appendFinalToken(channel, token) {
    const buffer = this._buffers[channel];
    const speaker = token.speaker || buffer.speaker || '';
    const startMs = this._tokenStart(token);
    const endMs = Number(token.end_ms) || startMs;

    if (buffer.text && speaker && buffer.speaker && speaker !== buffer.speaker) {
      this._flush(channel);
    }

    if (!buffer.text) {
      buffer.startMs = startMs;
      buffer.speaker = speaker;
      buffer.language = token.language || token.source_language || '';
    }
    buffer.text += token.text;
    buffer.endMs = endMs;

    const hasSentenceBoundary = /[.!?。！？]\s*$/.test(buffer.text);
    // Commit a segment at least every 6s of continuous speech. Speakers without
    // clear sentence pauses (e.g. a fast foreign client) otherwise only surface
    // on screen in one lump when the cap is hit, making the live transcript feel
    // laggy. A shorter cap keeps committed text flowing while the growing buffer
    // still shows as a live interim line between commits.
    const reachedMaxDuration = buffer.startMs > 0 && buffer.endMs - buffer.startMs >= 6_000;
    if (hasSentenceBoundary || reachedMaxDuration) this._flush(channel);
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
        language: buffer.language
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
    return { text: '', startMs: 0, endMs: 0, speaker: '', language: '' };
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
   Transcriber facade
   Provider-agnostic entry point used by the app. Shared,
   provider-independent methods (language lists, support
   check) delegate to Soniox; a live session is routed to
   the backend matching the selected STT provider. Only
   Soniox and Deepgram stream live; other providers fall
   back to Soniox for live recording.
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

  get isListening() { return this._active?.isListening || false; },
  get isPaused() { return this._active?.isPaused || false; },

  // Pick the live backend from the selected STT provider. Only providers that
  // can stream are eligible; anything else records live through Soniox.
  _resolveBackend() {
    const provider = (typeof Storage !== 'undefined' && Storage.getSettings?.().sttProvider) || 'soniox';
    return provider === 'deepgram' ? DeepgramTranscriber : SonioxTranscriber;
  },

  // Soniox translates natively into the languages it knows; every other
  // backend/target pair (Deepgram, or a Khmer target) uses Azure Translator.
  _needsExternalTranslation(backend, options) {
    const target = options.translationLanguage || '';
    if (!target) return false;
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
          body: JSON.stringify({ texts: [result.text], to: target })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error?.message || data.error || 'Translation failed');
        const text = String(data.translations?.[0] || '').trim();
        if (text) {
          this.onResult?.({ channel: 'translation', text, isFinal: true, timestamp: result.timestamp, speaker: result.speaker, language: target });
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
    const backend = this._resolveBackend();
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
    const offset = this._options?.restartAudioFeed?.();
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
