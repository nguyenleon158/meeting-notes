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
