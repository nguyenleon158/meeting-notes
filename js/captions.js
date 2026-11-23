/* ============================================
   MeetNote AI — caption screen
   Shows live captions over slides: the floating overlay
   window of the Mac app loads captions.html?overlay=1,
   a browser window loads captions.html. Each band shows
   one language (or the words as spoken); a phrase is
   shown as spoken when it is already in the band's
   language, otherwise as its translation.
   ============================================ */

const Captions = {
  SILENCE_FADE_MS: 12_000,   // fade stale captions so they do not sit over slides
  LINES_PER_BAND: { 1: 2, 2: 1 },

  config: { bands: ['original'], fontPx: 36, title: '' },
  finals: [],
  interim: { original: null, translation: null },
  _fadeTimer: null,

  /** Whether a caption belongs in a band ('original' or a language code). */
  accepts(band, caption) {
    if (band === 'original') return caption.channel === 'original';
    if (caption.language !== band) return false;
    // A "translation" from the band's own language repeats the original words.
    return caption.channel === 'original' || caption.sourceLanguage !== band;
  },

  /** Text a band shows: its latest finals plus the phrase still being heard. */
  bandLines(band) {
    const limit = this.LINES_PER_BAND[this.config.bands.length] || 2;
    const finals = this.finals.filter(caption => this.accepts(band, caption)).slice(-limit).map(caption => caption.text);
    const live = Object.values(this.interim).find(caption => caption && this.accepts(band, caption));
    return { finals, live: live?.text || '' };
  },

  receive(caption) {
    if (caption.isFinal) {
      this.interim[caption.channel] = null;
      this.finals = [...this.finals, caption].slice(-20);
    } else {
      this.interim[caption.channel] = caption;
    }
    this.render();
  },

  clear() {
    this.finals = [];
    this.interim = { original: null, translation: null };
    this.render();
  },

  // Called by the Mac app while the overlay can be moved and resized.
  setEditing(editing) {
    document.body.classList.toggle('editing', Boolean(editing));
  },

  render() {
    const root = document.getElementById('captions');
    if (!root) return;
    root.style.fontSize = `${Number(this.config.fontPx) || 36}px`;
    root.innerHTML = '';
    let hasText = false;
    for (const band of this.config.bands) {
      const { finals, live } = this.bandLines(band);
      const element = document.createElement('div');
      element.className = 'caption-band';
      element.lang = band === 'original' ? '' : band;
      for (const text of finals) {
        const line = document.createElement('p');
        line.className = 'caption-line';
        line.textContent = text;
        element.appendChild(line);
      }
      if (live) {
        const line = document.createElement('p');
        line.className = 'caption-line caption-live';
        line.textContent = live;
        element.appendChild(line);
      }
      hasText = hasText || finals.length > 0 || Boolean(live);
      root.appendChild(element);
    }
    root.classList.toggle('is-empty', !hasText);
    root.classList.remove('is-faded');
    clearTimeout(this._fadeTimer);
    if (hasText) this._fadeTimer = setTimeout(() => root.classList.add('is-faded'), this.SILENCE_FADE_MS);
  },

  connect() {
    const source = new EventSource('/api/captions/stream');
    source.addEventListener('config', event => {
      this.config = JSON.parse(event.data);
      this.render();
    });
    source.addEventListener('caption', event => this.receive(JSON.parse(event.data)));
    source.addEventListener('clear', () => this.clear());
    // EventSource reconnects by itself (the server asks for 1.5 s); the server
    // replays recent lines, so start clean to avoid showing them twice.
    source.addEventListener('open', () => {
      this.finals = [];
      this.interim = { original: null, translation: null };
    });
  },

  init() {
    const overlay = new URLSearchParams(location.search).get('overlay') === '1';
    document.documentElement.classList.toggle('overlay', overlay);
    this.render();
    this.connect();
  }
};

// A top-level const is not a window property; the Mac app calls window.Captions.
if (typeof window !== 'undefined') window.Captions = Captions;

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById?.('captions')) {
  Captions.init();
}
