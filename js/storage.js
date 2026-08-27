/* ============================================
   MeetNote AI — Storage Layer
   ============================================ */

const Storage = {
  KEYS: {
    MEETINGS: 'meetnote_meetings',
    SETTINGS: 'meetnote_settings'
  },

  DEFAULT_SETTINGS: {
    language: 'auto',
    translationLanguage: 'en',
    theme: 'dark',
    uiLanguage: 'en',
    autoSave: true,
    showTimestamps: true,
    llmProvider: 'codex',
    llmModels: {},
    sttProvider: 'soniox',
    sttModels: {}
  },
  _meetings: [],
  _settings: {},
  _pendingWrite: Promise.resolve(),
  _fileStorageAvailable: false,

  async init() {
    const response = await fetch('/api/data', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('Local storage server is unavailable. Start the app with "npm start".');
    }

    const data = await response.json();
    this._meetings = Array.isArray(data.meetings) ? data.meetings : [];
    this._settings = data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings)
      ? data.settings
      : {};
    this._fileStorageAvailable = true;

    // One-time migration from the previous browser-storage version.
    const legacyMeetings = this._readLegacyMeetings();
    const legacySettings = this._readLegacySettings();
    if (this._meetings.length === 0 && legacyMeetings.length > 0) {
      this._meetings = legacyMeetings;
      this._saveMeetings(this._meetings);
    }
    if (Object.keys(this._settings).length === 0 && Object.keys(legacySettings).length > 0) {
      const { apiKey, ...safeLegacySettings } = legacySettings;
      this._settings = safeLegacySettings;
      this._persistSettings();
    }
    sessionStorage.removeItem('meetnote_api_key');

    // Neither a live recording nor a browser-owned upload transcription can
    // survive a page reload / app restart. Any meeting still marked recording or
    // processing at startup was interrupted; recover it so it never hangs.
    this._recoverInterruptedRecordings();

    await this.flush();
  },

  _recoverInterruptedRecordings() {
    const interruptedAt = new Date().toISOString();
    let recovered = false;

    const meetings = this._meetings.map(meeting => {
      if (meeting.status === 'recording') {
        recovered = true;
        return {
          ...meeting,
          status: 'interrupted',
          interruptedAt,
          updatedAt: interruptedAt,
          sonioxUsage: meeting.sonioxUsage
            ? { ...meeting.sonioxUsage, endedAt: meeting.sonioxUsage.endedAt || interruptedAt }
            : meeting.sonioxUsage
        };
      }
      // `processing` meetings are owned by the server job lifecycle. The server
      // marks them failed on restart (recoverInterruptedJobs). The client must
      // NOT flip them here or it will fight the server.
      return meeting;
    });

    if (recovered) this._saveMeetings(meetings);
  },

  _readLegacyMeetings() {
    try {
      const data = localStorage.getItem(this.KEYS.MEETINGS);
      const meetings = data ? JSON.parse(data) : [];
      return Array.isArray(meetings) ? meetings : [];
    } catch {
      return [];
    }
  },

  _readLegacySettings() {
    try {
      const data = localStorage.getItem(this.KEYS.SETTINGS);
      const settings = data ? JSON.parse(data) : {};
      return settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
    } catch {
      return {};
    }
  },

  _queueWrite(path, value) {
    this._pendingWrite = this._pendingWrite
      .catch(() => {})
      .then(async () => {
        const response = await fetch(path, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(value)
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || `Could not write ${path}`);
        }
      });
    this._pendingWrite.catch(error => {
      console.error('Local file storage write failed:', error);
      window.dispatchEvent(new CustomEvent('meetnote-storage-error', {
        detail: { message: error.message }
      }));
    });
    return this._pendingWrite;
  },

  flush() {
    return this._pendingWrite;
  },

  /* ── Meetings ── */

  getAllMeetings() {
    return this._meetings.map(meeting => ({ ...meeting }));
  },

  getMeeting(id) {
    const meetings = this.getAllMeetings();
    return meetings.find(m => m.id === id) || null;
  },

  saveMeeting(meeting) {
    const meetings = this.getAllMeetings();
    const index = meetings.findIndex(m => m.id === meeting.id);

    if (index >= 0) {
      meetings[index] = { ...meetings[index], ...meeting, updatedAt: new Date().toISOString() };
    } else {
      meetings.unshift({
        id: Utils.uuid(),
        title: 'Untitled Meeting',
        date: new Date().toISOString(),
        duration: 0,
        participants: [],
        status: 'draft',
        transcript: [],
        translations: [],
        sonioxUsage: null,
        summary: '',
        summaryDetails: null,
        actionItems: [],
        notes: '',
        audioBlob: null,
        language: this.getSettings().language,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...meeting
      });
    }

    this._saveMeetings(meetings);
    return meetings[index >= 0 ? index : 0];
  },

  deleteMeeting(id) {
    const meetings = this.getAllMeetings().filter(m => m.id !== id);
    this._saveMeetings(meetings);
  },

  deleteMultipleMeetings(ids) {
    const idSet = new Set(ids);
    const meetings = this.getAllMeetings().filter(m => !idSet.has(m.id));
    this._saveMeetings(meetings);
  },

  _saveMeetings(meetings) {
    this._meetings = meetings;
    this._queueWrite('/api/meetings', meetings);
  },

  /* ── Action Items ── */

  addActionItem(meetingId, actionItem) {
    const meeting = this.getMeeting(meetingId);
    if (!meeting) return;
    meeting.actionItems.push({
      id: Utils.uuid(),
      text: '',
      assignee: '',
      done: false,
      createdAt: new Date().toISOString(),
      ...actionItem
    });
    this.saveMeeting(meeting);
    return meeting;
  },

  toggleActionItem(meetingId, actionItemId) {
    const meeting = this.getMeeting(meetingId);
    if (!meeting) return;
    const item = meeting.actionItems.find(a => a.id === actionItemId);
    if (item) item.done = !item.done;
    this.saveMeeting(meeting);
    return meeting;
  },

  removeActionItem(meetingId, actionItemId) {
    const meeting = this.getMeeting(meetingId);
    if (!meeting) return;
    meeting.actionItems = meeting.actionItems.filter(a => a.id !== actionItemId);
    this.saveMeeting(meeting);
    return meeting;
  },

  /* ── Settings ── */

  getSettings() {
    return {
      ...this.DEFAULT_SETTINGS,
      ...this._settings
    };
  },

  saveSettings(settings) {
    const current = this.getSettings();
    const updated = { ...current, ...settings };
    this._settings = updated;
    this._persistSettings();
    return updated;
  },

  _persistSettings() {
    return this._queueWrite('/api/settings', this._settings);
  },

  /* ── Analytics ── */

  getStats() {
    const meetings = this.getAllMeetings();
    const now = new Date();

    const totalMeetings = meetings.length;
    const totalDuration = meetings.reduce((sum, m) => sum + (m.duration || 0), 0);
    const thisWeek = meetings.filter(m => Utils.isThisWeek(m.date)).length;

    const allActions = meetings.flatMap(m => m.actionItems || []);
    const pendingActions = allActions.filter(a => !a.done).length;

    return {
      totalMeetings,
      totalDuration,
      totalHours: (totalDuration / 3600).toFixed(1),
      thisWeek,
      pendingActions,
      completedActions: allActions.length - pendingActions,
      totalActions: allActions.length
    };
  },

  /* ── Search ── */

  searchMeetings(query) {
    if (!query || !query.trim()) return [];
    const lq = query.toLowerCase().trim();
    const meetings = this.getAllMeetings();

    return meetings
      .map(m => {
        let score = 0;
        let snippets = [];

        // Search in title
        if (m.title.toLowerCase().includes(lq)) {
          score += 10;
          snippets.push({ field: 'title', text: m.title });
        }

        // Search in transcript
        (m.transcript || []).forEach(seg => {
          if (seg.text.toLowerCase().includes(lq)) {
            score += 5;
            snippets.push({ field: 'transcript', text: seg.text, time: seg.time, speaker: seg.speaker });
          }
        });

        // Search in notes
        if (m.notes && m.notes.toLowerCase().includes(lq)) {
          score += 3;
          snippets.push({ field: 'notes', text: m.notes.substring(0, 200) });
        }

        // Search in summary
        if (m.summary && m.summary.toLowerCase().includes(lq)) {
          score += 3;
          snippets.push({ field: 'summary', text: m.summary.substring(0, 200) });
        }

        // Search in action items
        (m.actionItems || []).forEach(a => {
          if (a.text.toLowerCase().includes(lq)) {
            score += 4;
            snippets.push({ field: 'action', text: a.text });
          }
        });

        return { meeting: m, score, snippets: snippets.slice(0, 3) };
      })
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score);
  },

  /* ── Export / Import ── */

  exportAll() {
    const meetings = this.getAllMeetings().map(({ audioBlob, ...meeting }) => meeting);
    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      meetings,
      settings: this.getSettings()
    };
    return JSON.stringify(data, null, 2);
  },

  importData(jsonString) {
    try {
      const data = JSON.parse(jsonString);
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Backup root must be an object');
      }
      if (data.version !== 1) {
        throw new Error('Unsupported backup version');
      }
      if (!Array.isArray(data.meetings) || data.meetings.length > 1000) {
        throw new Error('Backup meetings must be an array with at most 1000 entries');
      }

      const meetings = data.meetings.map((meeting, index) =>
        this._sanitizeImportedMeeting(meeting, index)
      );
      const settings = this._sanitizeImportedSettings(data.settings);

      this._saveMeetings(meetings);
      this.saveSettings(settings);
      return { success: true, count: meetings.length };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  _sanitizeImportedMeeting(meeting, index) {
    if (!meeting || typeof meeting !== 'object' || Array.isArray(meeting)) {
      throw new Error(`Meeting ${index + 1} is invalid`);
    }

    const string = (value, fallback = '', maxLength = 10000) =>
      typeof value === 'string' ? value.slice(0, maxLength) : fallback;
    const date = new Date(meeting.date);
    const transcript = Array.isArray(meeting.transcript)
      ? meeting.transcript.slice(0, 50000).map(segment => ({
          text: string(segment?.text, '', 20000),
          speaker: string(segment?.speaker, 'Speaker', 200),
          time: Number.isFinite(Number(segment?.time)) ? Math.max(0, Number(segment.time)) : 0
        }))
      : [];
    const translations = Array.isArray(meeting.translations)
      ? meeting.translations.slice(0, 50000).map(segment => ({
          text: string(segment?.text, '', 20000),
          speaker: string(segment?.speaker, '', 200),
          language: string(segment?.language, '', 20),
          time: Number.isFinite(Number(segment?.time)) ? Math.max(0, Number(segment.time)) : 0
        }))
      : [];
    const actionItems = Array.isArray(meeting.actionItems)
      ? meeting.actionItems.slice(0, 5000).map(item => ({
          id: string(item?.id, Utils.uuid(), 128),
          text: string(item?.text, '', 5000),
          assignee: string(item?.assignee, '', 200),
          dueDate: string(item?.dueDate, '', 200),
          done: Boolean(item?.done),
          createdAt: string(item?.createdAt, new Date().toISOString(), 64)
        }))
      : [];

    return {
      id: string(meeting.id, Utils.uuid(), 128),
      title: string(meeting.title, 'Untitled Meeting', 500),
      date: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
      duration: Number.isFinite(Number(meeting.duration)) ? Math.max(0, Number(meeting.duration)) : 0,
      participants: Array.isArray(meeting.participants)
        ? meeting.participants.slice(0, 200).map(value => string(value, '', 200)).filter(Boolean)
        : [],
      status: ['draft', 'recording', 'interrupted', 'processing', 'failed', 'completed'].includes(meeting.status) ? meeting.status : 'draft',
      transcript,
      translations,
      sonioxUsage: meeting.sonioxUsage && typeof meeting.sonioxUsage === 'object'
        ? {
            provider: ['soniox', 'deepgram', 'whisper', 'google'].includes(meeting.sonioxUsage.provider)
              ? meeting.sonioxUsage.provider
              : 'soniox',
            model: string(meeting.sonioxUsage.model, 'stt-rt-v5', 100),
            startedAt: string(meeting.sonioxUsage.startedAt, '', 64),
            endedAt: string(meeting.sonioxUsage.endedAt, '', 64),
            pricingUsdPerHour: typeof meeting.sonioxUsage.pricingUsdPerHour === 'number' && Number.isFinite(meeting.sonioxUsage.pricingUsdPerHour)
              ? Math.max(0, meeting.sonioxUsage.pricingUsdPerHour)
              : null,
            billableDurationSeconds: Number.isFinite(Number(meeting.sonioxUsage.billableDurationSeconds))
              ? Math.max(0, Number(meeting.sonioxUsage.billableDurationSeconds))
              : 0,
            estimatedCostUsd: typeof meeting.sonioxUsage.estimatedCostUsd === 'number' && Number.isFinite(meeting.sonioxUsage.estimatedCostUsd)
              ? Math.max(0, meeting.sonioxUsage.estimatedCostUsd)
              : null,
            translationEnabled: Boolean(meeting.sonioxUsage.translationEnabled)
          }
        : null,
      summary: string(meeting.summary, '', 200000),
      summaryDetails: meeting.summaryDetails && typeof meeting.summaryDetails === 'object'
        ? meeting.summaryDetails
        : null,
      // Provenance metadata travels with backups; it holds no secrets.
      summaryGeneration: meeting.summaryGeneration && typeof meeting.summaryGeneration === 'object' && !Array.isArray(meeting.summaryGeneration)
        ? meeting.summaryGeneration
        : null,
      actionItems,
      notes: string(meeting.notes, '', 200000),
      audioId: null,
      audioBlob: null,
      language: string(meeting.language, this.DEFAULT_SETTINGS.language, 20),
      translationLanguage: string(meeting.translationLanguage, '', 20),
      createdAt: string(meeting.createdAt, new Date().toISOString(), 64),
      updatedAt: string(meeting.updatedAt, new Date().toISOString(), 64)
    };
  },

  _sanitizeImportedSettings(settings) {
    if (settings !== undefined && (!settings || typeof settings !== 'object' || Array.isArray(settings))) {
      throw new Error('Backup settings are invalid');
    }

    const source = settings || {};
    const language = typeof source.language === 'string'
      ? source.language.slice(0, 20)
      : this.DEFAULT_SETTINGS.language;
    return {
      ...this.DEFAULT_SETTINGS,
      language,
      translationLanguage: typeof source.translationLanguage === 'string'
        ? source.translationLanguage.slice(0, 20)
        : this.DEFAULT_SETTINGS.translationLanguage,
      theme: ['dark', 'light', 'system'].includes(source.theme)
        ? source.theme
        : this.DEFAULT_SETTINGS.theme,
      uiLanguage: source.uiLanguage === 'vi' ? 'vi' : 'en',
      autoSave: source.autoSave !== false,
      showTimestamps: source.showTimestamps !== false,
      // Provider selection travels with backups; API keys never do.
      llmProvider: ['codex', 'deepseek', 'gemini'].includes(source.llmProvider)
        ? source.llmProvider
        : this.DEFAULT_SETTINGS.llmProvider,
      llmModels: source.llmModels && typeof source.llmModels === 'object' && !Array.isArray(source.llmModels)
        ? source.llmModels
        : {},
      sttProvider: ['soniox', 'deepgram', 'whisper', 'google'].includes(source.sttProvider)
        ? source.sttProvider
        : this.DEFAULT_SETTINGS.sttProvider,
      sttModels: source.sttModels && typeof source.sttModels === 'object' && !Array.isArray(source.sttModels)
        ? source.sttModels
        : {}
    };
  },

  async clearAll() {
    await this.flush();
    const response = await fetch('/api/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'CLEAR_ALL_DATA' })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Could not clear local data');
    }
    this._meetings = [];
    this._settings = {};
    sessionStorage.removeItem('meetnote_api_key');
    localStorage.removeItem(this.KEYS.MEETINGS);
    localStorage.removeItem(this.KEYS.SETTINGS);
  }
};
