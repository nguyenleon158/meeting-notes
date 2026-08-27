/* ============================================
   MeetNote AI — Summary Module
   Talks to the provider-neutral /api endpoints. The
   selected provider/model is chosen by the caller; this
   module never assumes a specific service.
   ============================================ */

const Summary = {
  _payload(meeting, options = {}) {
    return {
      provider: options.provider || undefined,
      model: options.model || undefined,
      language: options.language || undefined,
      meeting: {
        id: meeting.id,
        title: meeting.title,
        date: meeting.date,
        duration: meeting.duration,
        participants: meeting.participants,
        transcript: meeting.transcript
      }
    };
  },

  // Pull a readable message out of the standard error envelope or legacy string.
  _errorMessage(content, fallback) {
    if (content && typeof content.error === 'object') return content.error.message || fallback;
    if (content && typeof content.error === 'string') return content.error;
    return fallback;
  },

  async suggestTitle(meeting, options = {}) {
    const response = await fetch('/api/title-suggestion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this._payload(meeting, options))
    });
    const content = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(this._errorMessage(content, 'Could not suggest a meeting title.'));
    }
    const title = String(content.title || '').trim();
    if (!title) throw new Error('The provider returned an empty meeting title.');
    return title;
  },

  async generate(meeting, options = {}) {
    const response = await fetch('/api/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this._payload(meeting, options))
    });
    const content = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(this._errorMessage(content, 'Could not generate the meeting summary.'));
    }

    const { summaryGeneration, ...details } = content;
    return {
      summary: this.format(content),
      details,
      generation: summaryGeneration || null,
      actionItems: (content.actionItems || []).map(item => ({
        id: Utils.uuid(),
        text: item.text,
        assignee: item.assignee || '',
        dueDate: item.dueDate || '',
        done: false,
        createdAt: new Date().toISOString()
      }))
    };
  },

  format(content) {
    const sections = [String(content.summary || '').trim()];
    this._appendList(sections, 'Key points', content.keyPoints);
    this._appendList(sections, 'Decisions', content.decisions);
    this._appendList(sections, 'Open questions', content.openQuestions);
    return sections.filter(Boolean).join('\n\n');
  },

  _appendList(sections, title, items) {
    const values = Array.isArray(items) ? items.map(String).filter(Boolean) : [];
    if (values.length) sections.push(`${title}\n${values.map(item => `• ${item}`).join('\n')}`);
  }
};
