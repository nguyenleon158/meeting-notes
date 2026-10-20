/* ============================================
   MeetNote AI — Local File Audio Storage
   ============================================ */

const AudioStorage = {
  _url(meetingId) {
    return `/api/audio/${encodeURIComponent(meetingId)}`;
  },

  async _assertSuccess(response, fallbackMessage) {
    if (response.ok) return response;
    let message = fallbackMessage;
    try {
      const data = await response.json();
      if (data.error) message = data.error;
    } catch {
      // Use the fallback message.
    }
    throw new Error(message);
  },

  async save(meetingId, blob) {
    if (!meetingId || !(blob instanceof Blob)) {
      throw new Error('Invalid audio recording');
    }

    const response = await fetch(this._url(meetingId), {
      method: 'PUT',
      headers: {
        'Content-Type': blob.type || 'application/octet-stream',
        ...(blob.name ? { 'X-Audio-Filename': encodeURIComponent(blob.name) } : {})
      },
      body: blob
    });
    await this._assertSuccess(response, 'Could not save audio recording');
    return meetingId;
  },

  /* ──────────────────────────────────────────
     Incremental recording session
     Streams live-recording chunks to disk so the browser never buffers a
     whole multi-hour recording in memory. Chunks are coalesced into ~512 KB
     flushes; each flush is a sequential `append` request; `finish` promotes
     the on-disk part file to the final recording.
     ────────────────────────────────────────── */
  _FLUSH_BYTES: 512 * 1024,
  _session: null,

  beginRecording(meetingId, mimeType) {
    this._session = {
      meetingId,
      mimeType: mimeType || 'application/octet-stream',
      buffer: [],
      bufferedBytes: 0,
      firstFlush: true,
      chain: Promise.resolve(),
      error: null
    };
  },

  appendChunk(blob) {
    const session = this._session;
    if (!session || !blob || blob.size === 0) return;
    session.buffer.push(blob);
    session.bufferedBytes += blob.size;
    if (session.bufferedBytes >= this._FLUSH_BYTES) this._flushBuffer(session);
  },

  _flushBuffer(session) {
    if (session.buffer.length === 0) return session.chain;
    const parts = session.buffer;
    const reset = session.firstFlush;
    session.buffer = [];
    session.bufferedBytes = 0;
    session.firstFlush = false;

    const body = new Blob(parts, { type: session.mimeType });
    session.chain = session.chain.then(async () => {
      if (session.error) return; // stop appending after a failed write
      const response = await fetch(`${this._url(session.meetingId)}/append`, {
        method: 'PUT',
        headers: {
          'Content-Type': session.mimeType,
          ...(reset ? { 'X-Audio-Reset': '1' } : {})
        },
        body
      });
      await this._assertSuccess(response, 'Could not save audio recording');
    }).catch(error => {
      session.error = error;
      console.error('Audio chunk append failed:', error);
      window.dispatchEvent(new CustomEvent('meetnote-storage-error', {
        detail: { message: error.message }
      }));
    });
    return session.chain;
  },

  async finishRecording() {
    const session = this._session;
    if (!session) return { ok: true, size: 0 };
    this._session = null;

    this._flushBuffer(session);
    await session.chain;
    if (session.error) return { ok: false, size: 0, error: session.error };

    const response = await fetch(`${this._url(session.meetingId)}/finalize`, {
      method: 'POST',
      headers: { 'X-Audio-Content-Type': session.mimeType }
    });
    await this._assertSuccess(response, 'Could not finalize audio recording');
    const data = await response.json().catch(() => ({}));
    return { ok: true, size: Number(data.size) || 0 };
  },

  abortRecording() {
    this._session = null;
  },

  async get(meetingId) {
    const response = await fetch(this._url(meetingId), { cache: 'no-store' });
    if (response.status === 404) return null;
    await this._assertSuccess(response, 'Could not load audio recording');
    return response.blob();
  },

  async delete(meetingId) {
    if (!meetingId) return;
    const response = await fetch(this._url(meetingId), { method: 'DELETE' });
    await this._assertSuccess(response, 'Could not delete audio recording');
  },

  async clear() {
    const response = await fetch('/api/audio', { method: 'DELETE' });
    await this._assertSuccess(response, 'Could not clear audio recordings');
  }
};
