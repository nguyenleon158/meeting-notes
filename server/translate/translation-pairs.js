/* ============================================
   MeetNote AI — two-way translation presets
   A pair setting ("pair-vi-en") translates speech in the
   primary language into the secondary one, and every
   other language into the primary one. Mirrors
   SonioxTranscriber.TRANSLATION_PAIRS in js/transcriber.js.
   ============================================ */

const TRANSLATION_PAIRS = {
  'pair-vi-en': { primary: 'vi', secondary: 'en' }
};

function parseTranslationPair(value) {
  const key = String(value || '');
  return Object.hasOwn(TRANSLATION_PAIRS, key) ? TRANSLATION_PAIRS[key] : null;
}

/** Target for text spoken in `sourceLanguage` ('' when unknown → primary). */
function pairTargetFor(pair, sourceLanguage) {
  const source = String(sourceLanguage || '').split('-')[0].toLowerCase();
  return source === pair.primary ? pair.secondary : pair.primary;
}

module.exports = { TRANSLATION_PAIRS, parseTranslationPair, pairTargetFor };
