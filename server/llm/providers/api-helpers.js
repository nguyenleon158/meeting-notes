/* ============================================
   MeetNote AI — shared API adapter helpers
   fetch with timeout/AbortController and a common
   HTTP-status → typed-LLM-error mapping.
   ============================================ */

const { LLM_ERROR, llmError } = require('../contracts');

/**
 * POST JSON with an enforced timeout. Network/abort failures become typed
 * TIMEOUT / PROVIDER_UNAVAILABLE errors so callers never leak raw fetch errors.
 */
async function postJson(url, { headers, body, timeoutMs, provider }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw llmError(LLM_ERROR.TIMEOUT, 'The request to the provider timed out.', { provider });
    }
    throw llmError(LLM_ERROR.PROVIDER_UNAVAILABLE, 'Could not reach the provider.', { provider });
  } finally {
    clearTimeout(timer);
  }
  return response;
}

/**
 * Map a non-OK HTTP response to a typed error. Reads the body for a message.
 * @param {Response} response
 * @param {string} provider
 * @param {(body:object)=>string} [extractMessage] provider-specific message reader
 */
async function httpErrorFor(response, provider, extractMessage) {
  const body = await response.json().catch(() => ({}));
  const message = (extractMessage ? extractMessage(body) : '') ||
    `The provider request failed (${response.status}).`;

  if (response.status === 401 || response.status === 403) {
    return llmError(LLM_ERROR.AUTH_INVALID, 'The provider rejected the API key.', { provider });
  }
  if (response.status === 429) {
    return llmError(LLM_ERROR.RATE_LIMITED, 'The provider rate limit was reached. Try again shortly.', { provider });
  }
  if (response.status === 408 || response.status === 504) {
    return llmError(LLM_ERROR.TIMEOUT, 'The provider timed out.', { provider });
  }
  if (response.status >= 500) {
    return llmError(LLM_ERROR.PROVIDER_UNAVAILABLE, message, { provider });
  }
  return llmError(LLM_ERROR.PROVIDER_UNAVAILABLE, message, { provider, statusCode: 502 });
}

module.exports = { postJson, httpErrorFor };
