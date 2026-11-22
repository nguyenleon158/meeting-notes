/* ============================================
   MeetNote AI — live caption relay
   The recording page (in the browser) posts caption
   events; caption screens (the floating overlay window,
   or a browser window) follow them over Server-Sent
   Events. One live meeting at a time, kept in memory.
   ============================================ */

const RECENT_FINALS = 12;           // finals replayed to a screen that (re)connects
const MAX_TEXT_CHARS = 2000;
const LANGUAGE_PATTERN = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
const DISPLAY_VALUES = new Set(['original']);
// Caption text size in pixels.
const FONT_PX_MIN = 5;
const FONT_PX_MAX = 120;
const FONT_PX_DEFAULT = 36;

function cleanFontPx(value) {
  const px = Math.round(Number(value));
  return Number.isFinite(px) && value !== '' && value !== null ? Math.min(FONT_PX_MAX, Math.max(FONT_PX_MIN, px)) : FONT_PX_DEFAULT;
}

function cleanLanguage(value) {
  const code = String(value || '').trim();
  return LANGUAGE_PATTERN.test(code) ? code.split('-')[0].toLowerCase() : '';
}

/** Validate a caption event from the recording page; null when malformed. */
function normalizeCaption(body) {
  const text = typeof body?.text === 'string' ? body.text.trim().slice(0, MAX_TEXT_CHARS) : '';
  const channel = body?.channel === 'translation' ? 'translation' : 'original';
  if (!text) return null;
  return {
    channel,
    text,
    isFinal: Boolean(body.isFinal),
    language: cleanLanguage(body.language),
    sourceLanguage: cleanLanguage(body.sourceLanguage),
    timestamp: Number.isFinite(Number(body.timestamp)) ? Number(body.timestamp) : 0,
    seq: Number.isFinite(Number(body.seq)) ? Number(body.seq) : 0
  };
}

/**
 * Screen settings chosen on the recording page: up to two display bands
 * (a language code, or 'original' for the words as spoken) and a text size in px.
 */
function normalizeConfig(body) {
  const bands = (Array.isArray(body?.bands) ? body.bands : [])
    .map(value => (DISPLAY_VALUES.has(value) ? value : cleanLanguage(value)))
    .filter(Boolean)
    .slice(0, 2);
  return {
    bands: bands.length ? [...new Set(bands)] : ['original'],
    fontPx: body?.fontPx === undefined ? FONT_PX_DEFAULT : cleanFontPx(body.fontPx),
    title: typeof body?.title === 'string' ? body.title.slice(0, 200) : ''
  };
}

function createCaptionRelay() {
  const clients = new Set();
  let config = normalizeConfig({});
  let finals = [];
  let interim = { original: null, translation: null };
  let lastSeq = { original: 0, translation: 0 };

  function send(client, event, data) {
    client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function broadcast(event, data) {
    for (const client of clients) send(client, event, data);
  }

  /** Attach an SSE response; replays the settings and recent lines first. */
  function subscribe(response) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    });
    response.write('retry: 1500\n\n');
    send(response, 'config', config);
    for (const caption of finals) send(response, 'caption', caption);
    for (const caption of Object.values(interim)) if (caption) send(response, 'caption', caption);
    clients.add(response);
    const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 20_000);
    response.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(response);
    });
  }

  function publishCaption(body) {
    const caption = normalizeCaption(body);
    if (!caption) return false;
    // An older post that arrived late (e.g. an interim after its final) is dropped.
    if (caption.seq && caption.seq <= lastSeq[caption.channel]) return true;
    if (caption.seq) lastSeq[caption.channel] = caption.seq;
    if (caption.isFinal) {
      interim[caption.channel] = null;
      finals = [...finals, caption].slice(-RECENT_FINALS);
    } else {
      interim[caption.channel] = caption;
    }
    broadcast('caption', caption);
    return true;
  }

  function setConfig(body) {
    config = normalizeConfig(body);
    broadcast('config', config);
    return config;
  }

  // A new meeting starts with an empty screen.
  function clear() {
    finals = [];
    interim = { original: null, translation: null };
    lastSeq = { original: 0, translation: 0 };
    broadcast('clear', {});
  }

  return { subscribe, publishCaption, setConfig, clear, clientCount: () => clients.size };
}

module.exports = { createCaptionRelay, normalizeCaption, normalizeConfig };
