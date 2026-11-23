/* ============================================
   MeetNote AI — shared STT HTTP helpers
   fetch with timeout/AbortController and a common
   HTTP-status → typed-STT-error mapping.
   ============================================ */

const { STT_ERROR, sttError } = require('../contracts');

// Socket errors from a pooled keep-alive connection the far end already
// dropped (Azure resets idle ones after ~10-15 s). The request never reached
// the service, so an idempotent call can safely go out again.
const STALE_CONNECTION_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);

/**
 * fetch with an enforced timeout. `body` may be a Buffer, FormData or string.
 * Network/abort failures become typed TIMEOUT / PROVIDER_UNAVAILABLE errors.
 * `retryStaleConnection` resends once after a stale-connection reset; use it
 * only for idempotent calls (token issue, text translation).
 */
async function fetchWithTimeout(url, { method = 'POST', headers, body, timeoutMs, provider, retryStaleConnection = false }) {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { method, headers: headers || {}, body, signal: controller.signal });
    } catch (error) {
      if (error.name === 'AbortError') {
        throw sttError(STT_ERROR.TIMEOUT, 'The transcription request timed out.', { provider });
      }
      if (retryStaleConnection && attempt === 0 && STALE_CONNECTION_CODES.has(error.cause?.code)) continue;
      throw sttError(STT_ERROR.PROVIDER_UNAVAILABLE, 'Could not reach the provider.', { provider });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Map a non-OK HTTP response to a typed STT error. */
async function httpErrorFor(response, provider, extractMessage) {
  const body = await response.json().catch(() => ({}));
  const message = (extractMessage ? extractMessage(body) : '') || `The provider request failed (${response.status}).`;

  if (response.status === 401 || response.status === 403) {
    return sttError(STT_ERROR.AUTH_INVALID, 'The provider rejected the API key.', { provider });
  }
  if (response.status === 429) {
    return sttError(STT_ERROR.RATE_LIMITED, 'The provider rate limit was reached. Try again shortly.', { provider });
  }
  if (response.status === 413) {
    return sttError(STT_ERROR.AUDIO_TOO_LARGE, 'The audio file is too large for this provider.', { provider });
  }
  if (response.status === 415 || response.status === 422 || response.status === 400) {
    return sttError(STT_ERROR.UNSUPPORTED_AUDIO, message, { provider });
  }
  if (response.status >= 500) {
    return sttError(STT_ERROR.PROVIDER_UNAVAILABLE, message, { provider });
  }
  return sttError(STT_ERROR.TRANSCRIBE_FAILED, message, { provider });
}

module.exports = { fetchWithTimeout, httpErrorFor };
