/* ============================================
   MeetNote AI — transcript token budget
   Provider-neutral size estimation, budget guard, and
   time-ordered chunking for transcripts that exceed a
   model's input budget (map → reduce summarization).
   ============================================ */

const { llmError, LLM_ERROR } = require('./contracts');

// Rough chars-per-token ratio. Deliberately conservative for mixed CJK/Latin.
const CHARS_PER_TOKEN = 3.5;

// Fraction of a model's context window reserved for prompt scaffolding + output.
const INPUT_BUDGET_RATIO = 0.7;

// Per-segment token overhead for the "[mm:ss] Speaker: " prefix.
const SEGMENT_OVERHEAD_TOKENS = 8;

/** Approximate token count from character length. */
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / CHARS_PER_TOKEN);
}

/** Approximate token cost of a single transcript segment. */
function segmentTokens(segment) {
  return estimateTokens(`${segment.speaker || ''}${segment.text || ''}`) + SEGMENT_OVERHEAD_TOKENS;
}

/** Input token budget for a model, or 0 when the context window is unknown. */
function inputBudget(contextWindow) {
  return contextWindow ? Math.floor(contextWindow * INPUT_BUDGET_RATIO) : 0;
}

/**
 * Guard a prompt against a model's input budget.
 * @param {string} prompt fully built prompt text
 * @param {number} contextWindow model context window in tokens (0 = unknown/skip)
 * @param {string} provider provider id for error tagging
 */
function assertWithinBudget(prompt, contextWindow, provider) {
  const budget = inputBudget(contextWindow);
  if (!budget) return estimateTokens(prompt);
  const tokens = estimateTokens(prompt);
  if (tokens > budget) {
    throw llmError(
      LLM_ERROR.CONTEXT_TOO_LARGE,
      'This transcript is too long for the selected model. Choose a model with a larger context window or shorten the transcript.',
      { provider }
    );
  }
  return tokens;
}

/**
 * Split a transcript into time-ordered chunks, each within maxTokens.
 * Segment order and speakers are preserved; segments are never split.
 * A single oversized segment becomes its own chunk (the caller's budget
 * check still catches a chunk that cannot fit at all).
 * @returns {Array<Array<object>>} array of segment groups
 */
function chunkTranscript(transcript, maxTokens) {
  const chunks = [];
  let current = [];
  let currentTokens = 0;

  for (const segment of transcript) {
    const tokens = segmentTokens(segment);
    if (current.length && currentTokens + tokens > maxTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(segment);
    currentTokens += tokens;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

module.exports = {
  CHARS_PER_TOKEN,
  INPUT_BUDGET_RATIO,
  estimateTokens,
  inputBudget,
  assertWithinBudget,
  chunkTranscript
};
