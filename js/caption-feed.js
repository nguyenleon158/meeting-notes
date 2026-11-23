/* ============================================
   MeetNote AI — caption feed (recording page side)
   Sends the live transcript and translation to the
   local server, which relays them to the caption screen
   (the Mac app's floating overlay, or a browser window).
   ============================================ */

const CaptionFeed = {
  INTERIM_INTERVAL_MS: 150,   // interim words change many times a second; send at most this often
  FONT_PX: { min: 5, max: 120, default: 36 },   // caption text size on screen
  OVERLAY_URL: 'meetnote://captions/',

  _pending: {},
  _timer: null,
  _lastSeq: 0,
  _spokenLanguage: '',

  _base(code) {
    return String(code || '').split('-')[0].toLowerCase();
  },

  _languageName(code) {
    const match = Transcriber.getSupportedLanguages().find(language => language.sonioxCode === code && !language.candidates);
    // One English entry is enough on a caption screen: drop the (US)/(UK) variant.
    return (match?.name || code).replace(/ \((US|UK)\)$/, '');
  },

  // Languages heard in a meeting ([] for Auto-detect) and its translation targets.
  _meetingLanguages(meeting) {
    const language = Transcriber.getSupportedLanguages().find(item => item.code === meeting.language);
    const spoken = language?.candidates
      ? language.candidates.map(code => this._base(code))
      : (meeting.language && meeting.language !== 'auto' ? [this._base(meeting.language)] : []);
    const pair = Transcriber.getTranslationPairs().find(item => item.code === meeting.translationLanguage);
    const targets = pair ? [pair.primary, pair.secondary] : (meeting.translationLanguage ? [this._base(meeting.translationLanguage)] : []);
    return { spoken, targets };
  },

  /**
   * What the caption screen can show for a meeting: each language alone, the
   * first two together, or the words as spoken. The first choice is the default.
   */
  displayChoices(meeting) {
    const { spoken, targets } = this._meetingLanguages(meeting);
    const languages = [...new Set([...targets, ...spoken])];
    const choices = languages.map(code => ({ value: code, label: this._languageName(code), bands: [code] }));
    if (languages.length >= 2) {
      const [first, second] = languages;
      choices.push({ value: `${first}+${second}`, label: `${this._languageName(first)} + ${this._languageName(second)}`, bands: [first, second] });
    }
    choices.push({ value: 'original', label: 'As spoken (no translation)', bands: ['original'] });
    return choices;
  },

  // Increasing across meetings and page reloads (clock based).
  _nextSeq() {
    this._lastSeq = Math.max(Date.now(), this._lastSeq + 1);
    return this._lastSeq;
  },

  /** A new meeting: clear the screen and send its display settings. */
  start(meeting, display) {
    const { spoken } = this._meetingLanguages(meeting);
    // Providers that do not report a language (Deepgram) still need one for a
    // single-language meeting, or its words would match no band.
    this._spokenLanguage = spoken.length === 1 ? spoken[0] : '';
    this._pending = {};
    this._post('/api/captions/clear');
    this.configure(display);
  },

  configure({ bands, fontPx, title = '' }) {
    this._post('/api/captions/config', { bands, fontPx, title });
  },

  push(result) {
    if (!result?.text) return;
    const caption = {
      channel: result.channel === 'translation' ? 'translation' : 'original',
      text: result.text,
      isFinal: Boolean(result.isFinal),
      language: result.language || (result.channel === 'translation' ? '' : this._spokenLanguage),
      sourceLanguage: result.sourceLanguage || '',
      timestamp: result.timestamp || 0,
      // Posts can arrive out of order; the server keeps only the newest per channel.
      seq: this._nextSeq()
    };
    if (caption.isFinal) {
      delete this._pending[caption.channel];
      this._post('/api/captions', caption);
      return;
    }
    this._pending[caption.channel] = caption;
    if (!this._timer) {
      this._timer = setTimeout(() => {
        this._timer = null;
        const pending = Object.values(this._pending);
        this._pending = {};
        pending.forEach(item => this._post('/api/captions', item));
      }, this.INTERIM_INTERVAL_MS);
    }
  },

  // Ask the Mac app to show its floating overlay (a custom URL the app owns):
  // 'show', 'hide', 'edit' (move and resize it) or 'lock' (back to click-through).
  openOverlay(action = 'show') {
    const link = document.createElement('a');
    link.href = `${this.OVERLAY_URL}${action}`;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  },

  // A plain window, for a projector screen that is not showing full-screen slides.
  openWindow() {
    window.open('/captions.html', 'meetnote-captions', 'popup,width=1200,height=260');
  },

  _post(path, body) {
    fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).catch(() => { /* the caption screen is optional; recording goes on */ });
  }
};
