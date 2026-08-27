/* ============================================
   MeetNote AI — Main Application Controller
   ============================================ */

const App = {
  currentRoute: 'dashboard',
  currentMeetingId: null,
  _activeRecordingMeetingId: null,
  _interimText: '',
  _transcriptSegments: [],
  _translationSegments: [],
  _recordingSaveInProgress: false,
  _backgroundAudioTasks: new Map(),
  _activePollers: new Map(),
  _selectedMeetingIds: new Set(),
  _themeMedia: null,
  _pendingAutoStartMeetingId: null,
  SONIOX_REALTIME_USD_PER_HOUR: 0.12,
  SONIOX_ASYNC_USD_PER_HOUR: 0.10,
  SONIOX_ASYNC_TRANSLATION_USD_PER_HOUR: 0.16,

  /* ──────────────────────────────────────────
     Initialization
     ────────────────────────────────────────── */

  init() {
    this._installDiagnostics();
    this._applyTheme(Storage.getSettings().theme);
    this._bindNavigation();
    this._bindMobileMenu();
    this._bindThemeToggle();
    this._updateMeetingsCount();

    // Route from hash
    const hash = location.hash.slice(1) || 'dashboard';
    this.navigate(hash);
    this._migrateLegacyAudio();
    this._resumeProcessingJobs();

    // Listen for hash changes
    window.addEventListener('hashchange', () => {
      const h = location.hash.slice(1) || 'dashboard';
      this.navigate(h);
    });

    window.addEventListener('beforeunload', (event) => {
      if (this._activeRecordingMeetingId) {
        event.preventDefault();
        event.returnValue = '';
      }
    });

    window.addEventListener('meetnote-storage-error', (event) => {
      this.toast(`Could not write to the storage folder: ${event.detail.message}`, 'error');
      this._logClientEvent('error', 'storage_error', event.detail.message);
    });
  },

  _installDiagnostics() {
    window.addEventListener('error', event => {
      this._logClientEvent('error', 'uncaught_error', event.message || 'Unknown browser error', {
        source: event.filename || '',
        line: event.lineno || 0,
        column: event.colno || 0,
        stack: event.error?.stack || ''
      });
    });
    window.addEventListener('unhandledrejection', event => {
      const reason = event.reason;
      this._logClientEvent('error', 'unhandled_rejection', reason?.message || String(reason || 'Unknown rejection'), {
        stack: reason?.stack || ''
      });
    });
    this._logClientEvent('info', 'app_initialized', 'MeetNote UI initialized', {
      route: location.hash.slice(1) || 'dashboard',
      userAgent: navigator.userAgent
    });
  },

  _logClientEvent(level, event, message, context = {}) {
    fetch('/api/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, event, message, context }),
      keepalive: true
    }).catch(() => {});
  },

  _applyTheme(preference) {
    const theme = ['dark', 'light', 'system'].includes(preference) ? preference : 'dark';
    const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    const resolved = theme === 'system' ? (prefersLight ? 'light' : 'dark') : theme;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;

    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = resolved === 'light' ? '#fbfaf7' : '#002d31';

    const toggle = document.getElementById('theme-toggle');
    if (toggle) {
      const switchTo = resolved === 'light' ? 'dark' : 'light';
      toggle.textContent = resolved === 'light' ? '🌙' : '☀️';
      toggle.title = `Switch to ${switchTo} mode`;
      toggle.setAttribute('aria-label', `Switch to ${switchTo} mode`);
    }
    const themeSelect = document.getElementById('setting-theme');
    if (themeSelect && themeSelect.value !== theme) themeSelect.value = theme;
  },

  _bindThemeToggle() {
    this._themeMedia = window.matchMedia('(prefers-color-scheme: light)');
    this._themeMedia.addEventListener?.('change', () => {
      if (Storage.getSettings().theme === 'system') this._applyTheme('system');
    });

    document.getElementById('theme-toggle')?.addEventListener('click', async () => {
      const nextTheme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      Storage.saveSettings({ theme: nextTheme });
      this._applyTheme(nextTheme);
      try {
        await Storage.flush();
      } catch (error) {
        this.toast(`Could not save theme: ${error.message}`, 'error');
      }
    });
  },

  /* ──────────────────────────────────────────
     Router
     ────────────────────────────────────────── */

  navigate(route, options = {}) {
    if (
      this._recordingSaveInProgress &&
      this.currentRoute === 'recording' &&
      route !== `recording/${this.currentMeetingId}` &&
      !options.force
    ) {
      this.toast('Please wait while the recording is being saved.', 'info');
      history.replaceState(null, '', `#recording/${this.currentMeetingId}`);
      return;
    }

    const leavingActiveRecording =
      this._activeRecordingMeetingId &&
      this.currentRoute === 'recording' &&
      route !== `recording/${this.currentMeetingId}`;

    if (leavingActiveRecording && !options.force) {
      this._confirmLeaveRecording(route);
      return;
    }

    // Parse route: "meeting/abc-123" → { page: 'meeting', id: 'abc-123' }
    const parts = route.split('/');
    const page = parts[0];
    const id = parts[1] || null;

    this.currentRoute = page;
    this.currentMeetingId = id;

    // Update nav active state
    document.querySelectorAll('.nav-item[data-route]').forEach(el => {
      el.classList.toggle('active', el.dataset.route === page);
    });

    // Update hash without triggering hashchange
    if (location.hash.slice(1) !== route) {
      history.replaceState(null, '', `#${route}`);
    }

    // Close mobile sidebar
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('open');

    // Render page
    const content = document.getElementById('main-content');
    const title = document.getElementById('page-title');
    const headerActions = document.getElementById('header-actions');
    headerActions.innerHTML = '';

    switch (page) {
      case 'dashboard':
        title.textContent = 'Dashboard';
        content.innerHTML = this._renderDashboard();
        this._bindDashboard();
        break;
      case 'new':
        title.textContent = 'New Meeting';
        content.innerHTML = this._renderNewMeeting();
        this._bindNewMeeting();
        break;
      case 'recording':
        title.textContent = 'Recording';
        content.innerHTML = this._renderRecording(id);
        this._bindRecording(id);
        break;
      case 'meeting':
        title.textContent = 'Meeting Details';
        content.innerHTML = this._renderMeetingDetail(id);
        this._bindMeetingDetail(id);
        break;
      case 'meetings':
        title.textContent = 'All Meetings';
        content.innerHTML = this._renderAllMeetings();
        this._bindAllMeetings();
        break;
      case 'usage':
        title.textContent = 'Usage Log';
        content.innerHTML = this._renderUsageLog();
        this._bindMeetingItemClicks();
        break;
      case 'search':
        title.textContent = 'Search';
        content.innerHTML = this._renderSearch();
        this._bindSearch();
        break;
      case 'settings':
        title.textContent = 'Settings';
        content.innerHTML = this._renderSettings();
        this._bindSettings();
        break;
      case 'report-bug':
        title.textContent = 'Report a Bug';
        content.innerHTML = this._renderBugReport();
        this._bindBugReport();
        break;
      default:
        title.textContent = 'Not Found';
        content.innerHTML = this._renderNotFound();
    }
    this._renderBackgroundTaskIndicator();
  },

  _renderBackgroundTaskIndicator() {
    const container = document.getElementById('header-actions');
    if (!container) return;
    const count = this._backgroundAudioTasks.size;
    if (!count) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = `
      <button class="btn btn-secondary btn-sm" id="background-audio-status" type="button" title="View processing audio files">
        <span class="spinner"></span>
        ${count} audio ${count === 1 ? 'task' : 'tasks'}
      </button>
    `;
    document.getElementById('background-audio-status')?.addEventListener('click', () => this.navigate('meetings'));
  },

  _refreshMeetingView(meetingId) {
    if (['dashboard', 'meetings', 'usage'].includes(this.currentRoute)) {
      this.navigate(this.currentRoute, { force: true });
    } else if (this.currentRoute === 'meeting' && this.currentMeetingId === meetingId) {
      this.navigate(`meeting/${meetingId}`, { force: true });
    } else {
      this._renderBackgroundTaskIndicator();
    }
  },

  _confirmLeaveRecording(route) {
    if (document.getElementById('confirm-save-leave')) return;

    this.showModal(`
      <div class="modal-header">
        <h3>Recording in progress</h3>
        <button class="btn btn-ghost btn-icon" id="cancel-leave-recording">✕</button>
      </div>
      <p class="text-sm text-secondary">Save or discard the current recording before leaving this page.</p>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="stay-on-recording">Stay</button>
        <button class="btn btn-danger" id="discard-and-leave">Discard & Leave</button>
        <button class="btn btn-primary" id="confirm-save-leave">Save & Leave</button>
      </div>
    `);

    const stay = () => {
      history.replaceState(null, '', `#recording/${this.currentMeetingId}`);
      this.closeModal();
    };
    document.getElementById('modal-backdrop').onclick = stay;
    document.getElementById('cancel-leave-recording').addEventListener('click', stay);
    document.getElementById('stay-on-recording').addEventListener('click', stay);
    document.getElementById('confirm-save-leave').addEventListener('click', async () => {
      this._setRecordingModalBusy(true);
      const saved = await this._saveActiveRecording(this.currentMeetingId);
      if (saved) {
        this.closeModal();
        this.navigate(route, { force: true });
      } else {
        this._setRecordingModalBusy(false);
      }
    });
    document.getElementById('discard-and-leave').addEventListener('click', async () => {
      this._setRecordingModalBusy(true);
      await this._discardActiveRecording(this.currentMeetingId);
      this.closeModal();
      this.navigate(route, { force: true });
    });
  },

  _setRecordingModalBusy(isBusy) {
    ['stay-on-recording', 'discard-and-leave', 'confirm-save-leave', 'cancel-leave-recording']
      .forEach(id => {
        const element = document.getElementById(id);
        if (element) element.disabled = isBusy;
      });
    const saveButton = document.getElementById('confirm-save-leave');
    if (saveButton) saveButton.textContent = isBusy ? 'Saving…' : 'Save & Leave';
  },

  async _migrateLegacyAudio() {
    const meetings = Storage.getAllMeetings().filter(meeting => meeting.audioBlob);
    let migrationSucceeded = true;
    for (const meeting of meetings) {
      try {
        const blob = Recorder.base64ToBlob(meeting.audioBlob);
        await AudioStorage.save(meeting.id, blob);
        meeting.audioId = meeting.id;
        meeting.audioBlob = null;
        Storage.saveMeeting(meeting);
      } catch (error) {
        migrationSucceeded = false;
        console.warn(`Could not migrate audio for meeting ${meeting.id}:`, error);
      }
    }
    if (migrationSucceeded) {
      await Storage.flush();
      localStorage.removeItem(Storage.KEYS.MEETINGS);
      localStorage.removeItem(Storage.KEYS.SETTINGS);
    }
  },

  _cleanupRecordingCallbacks() {
    Recorder.onTick = null;
    Recorder.onWaveform = null;
    Recorder.onStop = null;
    Recorder.onChunk = null;
    Recorder.onSystemAudioLost = null;
    Transcriber.onResult = null;
    Transcriber.onError = null;
    Transcriber.onStatusChange = null;
    this._activeRecordingMeetingId = null;
  },

  async _saveActiveRecording(meetingId) {
    if (this._recordingSaveInProgress) return false;
    this._recordingSaveInProgress = true;

    try {
      const duration = Recorder.getElapsedSeconds();
      const blob = await Recorder.stop();
      await Transcriber.stop();
      const meeting = Storage.getMeeting(meetingId);
      if (!meeting) throw new Error('Meeting no longer exists');

      if (blob && blob.size > 0) {
        await AudioStorage.save(meetingId, blob);
        meeting.audioId = meetingId;
        meeting.audioBlob = null;
      }

      meeting.transcript = [...this._transcriptSegments];
      meeting.translations = [...this._translationSegments];
      meeting.duration = duration;
      meeting.status = 'completed';
      if (meeting.sonioxUsage?.startedAt) {
        meeting.sonioxUsage = {
          ...meeting.sonioxUsage,
          endedAt: new Date().toISOString(),
          billableDurationSeconds: duration,
          estimatedCostUsd: this._estimateSonioxCost(duration)
        };
      }
      Storage.saveMeeting(meeting);
      await Storage.flush();
      this._cleanupRecordingCallbacks();
      this._updateMeetingsCount();
      return true;
    } catch (error) {
      console.error('Could not save recording:', error);
      this.toast(`Could not save recording: ${error.message}`, 'error');
      return false;
    } finally {
      this._recordingSaveInProgress = false;
    }
  },

  async _discardActiveRecording(meetingId) {
    this._cleanupRecordingCallbacks();
    await Recorder.stop();
    await Transcriber.stop();
    await AudioStorage.delete(meetingId).catch(error => {
      console.warn('Could not remove recording audio:', error);
    });
    Storage.deleteMeeting(meetingId);
    await Storage.flush();
    this._updateMeetingsCount();
  },

  /* ──────────────────────────────────────────
     Navigation Bindings
     ────────────────────────────────────────── */

  _bindNavigation() {
    document.querySelectorAll('.nav-item[data-route]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        this.navigate(el.dataset.route);
      });
    });
  },

  _bindMobileMenu() {
    const toggle = document.getElementById('mobile-toggle');
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');

    toggle.addEventListener('click', () => {
      sidebar.classList.toggle('open');
      overlay.classList.toggle('open');
    });

    overlay.addEventListener('click', () => {
      sidebar.classList.remove('open');
      overlay.classList.remove('open');
    });
  },

  _updateMeetingsCount() {
    const count = Storage.getAllMeetings().length;
    const badge = document.getElementById('nav-meetings-count');
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  },

  /* ──────────────────────────────────────────
     Toast Notifications
     ────────────────────────────────────────── */

  toast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const icons = { success: '✓', warning: '⚠', error: '✕', info: 'ℹ' };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icon = document.createElement('span');
    icon.textContent = icons[type] || 'ℹ';
    const text = document.createElement('span');
    text.textContent = String(message);
    toast.append(icon, document.createTextNode(' '), text);
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = `toast-slide-out var(--duration-normal) var(--ease-out) forwards`;
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  },

  /* ──────────────────────────────────────────
     Modal
     ────────────────────────────────────────── */

  showModal(content) {
    const backdrop = document.getElementById('modal-backdrop');
    const modal = document.getElementById('modal');
    modal.innerHTML = content;
    backdrop.classList.add('active');
    modal.classList.add('active');

    backdrop.onclick = () => this.closeModal();
  },

  closeModal() {
    document.getElementById('modal-backdrop').classList.remove('active');
    document.getElementById('modal').classList.remove('active');
  },

  /* ══════════════════════════════════════════
     VIEW: Dashboard
     ══════════════════════════════════════════ */

  _renderDashboard() {
    const stats = Storage.getStats();
    const meetings = Storage.getAllMeetings().slice(0, 5);

    return `
      <div class="view-enter">
        <!-- Stats -->
        <div class="grid grid-4 stagger-children" style="margin-bottom: var(--space-8);">
          <div class="card stat-card">
            <div class="stat-icon" style="background: var(--accent-primary-muted); color: var(--accent-primary);">📋</div>
            <div class="stat-value">${stats.totalMeetings}</div>
            <div class="stat-label">Total Meetings</div>
          </div>
          <div class="card stat-card">
            <div class="stat-icon" style="background: var(--accent-secondary-muted); color: var(--accent-secondary);">⏱️</div>
            <div class="stat-value">${stats.totalHours}</div>
            <div class="stat-label">Hours Recorded</div>
          </div>
          <div class="card stat-card">
            <div class="stat-icon" style="background: var(--color-info-muted); color: var(--color-info);">📅</div>
            <div class="stat-value">${stats.thisWeek}</div>
            <div class="stat-label">This Week</div>
          </div>
          <div class="card stat-card">
            <div class="stat-icon" style="background: var(--color-warning-muted); color: var(--color-warning);">✅</div>
            <div class="stat-value">${stats.pendingActions}</div>
            <div class="stat-label">Pending Actions</div>
          </div>
        </div>

        <!-- Quick Actions -->
        <div class="flex flex-wrap gap-4" style="margin-bottom: var(--space-8);">
          <button class="btn btn-primary btn-lg" id="dash-quick-record">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="6" fill="currentColor"/></svg>
            Quick Record
          </button>
          <button class="btn btn-secondary btn-lg" id="dash-new-meeting">
            Meeting Setup
          </button>
          <button class="btn btn-secondary btn-lg" id="dash-upload">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Upload Recording
          </button>
        </div>

        <!-- Recent Meetings -->
        <div class="card" style="padding: 0;">
          <div style="padding: var(--space-5) var(--space-6); border-bottom: 1px solid var(--border-subtle);">
            <div class="flex items-center justify-between">
              <h3 style="font-size: var(--text-base);">Recent Meetings</h3>
              ${meetings.length > 0 ? '<a class="text-sm" style="cursor:pointer; color: var(--accent-primary);" id="dash-view-all">View all →</a>' : ''}
            </div>
          </div>
          <div>
            ${meetings.length > 0 ? meetings.map(m => this._renderMeetingItem(m)).join('') : `
              <div class="empty-state" style="padding: var(--space-10);">
                <div class="empty-icon">🎙️</div>
                <h3>No meetings yet</h3>
                <p>Start your first meeting recording to see it here.</p>
              </div>
            `}
          </div>
        </div>
      </div>
    `;
  },

  _bindDashboard() {
    document.getElementById('dash-quick-record')?.addEventListener('click', () => this._quickStartMeeting());
    document.getElementById('dash-new-meeting')?.addEventListener('click', () => this.navigate('new'));
    document.getElementById('dash-view-all')?.addEventListener('click', () => this.navigate('meetings'));
    document.getElementById('dash-upload')?.addEventListener('click', () => this._handleUpload());
    this._bindMeetingItemClicks();
  },

  _defaultMeetingTitle(date = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    const formattedDate = `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
    const formattedTime = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    return `Meeting — ${formattedDate} · ${formattedTime}`;
  },

  _isDefaultMeetingTitle(title) {
    const value = String(title || '').trim();
    return !value ||
      /^Untitled Meeting$/i.test(value) ||
      /^Meeting\s*[—–-]\s*\d{1,2}\/\d{1,2}\/\d{4}\s*[·•-]\s*\d{1,2}:\d{2}$/i.test(value);
  },

  _quickStartMeeting() {
    const settings = Storage.getSettings();
    const meeting = Storage.saveMeeting({
      title: this._defaultMeetingTitle(),
      participants: [],
      language: settings.language,
      translationLanguage: settings.translationLanguage,
      status: 'draft'
    });
    this._pendingAutoStartMeetingId = meeting.id;
    this.navigate(`recording/${meeting.id}`);
    this._updateMeetingsCount();
  },

  _estimateSonioxCost(durationSeconds, rate = this.SONIOX_REALTIME_USD_PER_HOUR) {
    const seconds = Number.isFinite(Number(durationSeconds)) ? Math.max(0, Number(durationSeconds)) : 0;
    return (seconds / 3600) * rate;
  },

  _formatUsd(value) {
    const amount = Number(value) || 0;
    return `$${amount.toFixed(amount < 0.01 ? 4 : 2)}`;
  },

  _sttProviderName(id) {
    return ({
      soniox: 'Soniox',
      deepgram: 'Deepgram',
      whisper: 'OpenAI Whisper',
      google: 'Google Speech-to-Text'
    })[id] || id || 'Speech-to-text';
  },

  _renderUsageLog() {
    const records = Storage.getAllMeetings()
      .filter(meeting => meeting.sonioxUsage?.startedAt)
      .map(meeting => {
        const usage = meeting.sonioxUsage;
        const provider = usage.provider || 'soniox';
        const duration = usage.billableDurationSeconds || meeting.duration || 0;
        const hasRate = typeof usage.pricingUsdPerHour === 'number' && Number.isFinite(usage.pricingUsdPerHour);
        const hasCost = typeof usage.estimatedCostUsd === 'number' && Number.isFinite(usage.estimatedCostUsd);
        const cost = hasCost ? usage.estimatedCostUsd : (hasRate ? this._estimateSonioxCost(duration, usage.pricingUsdPerHour) : null);
        return { meeting, usage, provider, duration, cost };
      });
    const totalDuration = records.reduce((sum, record) => sum + record.duration, 0);
    const totalCost = records.reduce((sum, record) => sum + (record.cost ?? 0), 0);

    return `
      <div class="view-enter">
        <div class="grid grid-3" style="margin-bottom:var(--space-6);">
          <div class="card stat-card">
            <div class="stat-value">${this._formatUsd(totalCost)}</div>
            <div class="stat-label">Known estimated STT spend</div>
          </div>
          <div class="card stat-card">
            <div class="stat-value">${(totalDuration / 3600).toFixed(2)}</div>
            <div class="stat-label">Audio hours</div>
          </div>
          <div class="card stat-card">
            <div class="stat-value">${records.length}</div>
            <div class="stat-label">STT meetings</div>
          </div>
        </div>

        <div class="card" style="padding:0; overflow:hidden;">
          <div style="padding:var(--space-5) var(--space-6); border-bottom:1px solid var(--border-subtle);">
            <div class="flex items-center justify-between gap-4">
              <div>
                <h3 style="font-size:var(--text-base);">Speech-to-text usage by meeting</h3>
                <p class="text-xs">Cost is shown only when MeetNote has a known provider rate.</p>
              </div>
            </div>
          </div>
          <div>
            ${records.length ? records.map(record => `
              <div class="meeting-item" data-meeting-id="${Utils.escapeHtml(record.meeting.id)}">
                <div class="meeting-icon">$</div>
                <div class="meeting-info">
                  <div class="meeting-title">${Utils.escapeHtml(record.meeting.title)}</div>
                  <div class="meeting-meta">
                    <span>${Utils.formatDate(record.meeting.date)}</span>
                    <span class="dot"></span>
                    <span>${Utils.formatDurationHuman(record.duration)}</span>
                    <span class="dot"></span>
                    <span>${Utils.escapeHtml(this._sttProviderName(record.provider))}</span>
                    ${record.usage.translationEnabled ? '<span class="dot"></span><span>Translation</span>' : ''}
                  </div>
                </div>
                <div style="text-align:right;">
                  <strong>${record.cost === null ? '—' : this._formatUsd(record.cost)}</strong>
                  <div class="text-xs text-tertiary">${record.cost === null ? 'check provider billing' : 'estimated'}</div>
                </div>
              </div>
            `).join('') : `
              <div class="empty-state" style="padding:var(--space-10);">
                <div class="empty-icon">📈</div>
                <h3>No speech-to-text usage yet</h3>
                <p>Start a recording and its estimated cost will appear here.</p>
              </div>
            `}
          </div>
        </div>
      </div>
    `;
  },

  /* ══════════════════════════════════════════
     VIEW: New Meeting
     ══════════════════════════════════════════ */

  _renderNewMeeting() {
    const settings = Storage.getSettings();
    const languages = Transcriber.getSupportedLanguages();
    const langOptions = `<option value="auto" ${settings.language === 'auto' ? 'selected' : ''}>Auto-detect multilingual (Recommended)</option>` + languages.map(l =>
      `<option value="${l.code}" ${l.code === settings.language ? 'selected' : ''}>${l.name}</option>`
    ).join('');
    const translationOptions = Transcriber.getTranslationLanguages().map(language =>
      `<option value="${language.sonioxCode}" ${language.sonioxCode === settings.translationLanguage ? 'selected' : ''}>${language.name}</option>`
    ).join('');

    return `
      <div class="view-enter" style="max-width: 600px;">
        <div class="card">
          <h3 style="margin-bottom: var(--space-6);">Meeting Setup</h3>

          <div class="flex flex-col gap-5">
            <div class="input-group">
              <label for="meeting-title">Meeting Title</label>
              <input type="text" class="input" id="meeting-title" value="${Utils.escapeHtml(this._defaultMeetingTitle())}" autofocus>
            </div>

            <div class="input-group">
              <label for="meeting-participants">Participants <span class="text-tertiary">(comma-separated)</span></label>
              <input type="text" class="input" id="meeting-participants" placeholder="e.g. Alice, Bob, Charlie">
            </div>

            <div class="input-group">
              <label for="meeting-language">Spoken Language</label>
              <select class="input" id="meeting-language">
                ${langOptions}
              </select>
              <span class="text-xs text-tertiary">Choose Auto when people may switch between Vietnamese, English, or other languages.</span>
            </div>

            <div class="input-group">
              <label for="meeting-translation-language">Translate To</label>
              <select class="input" id="meeting-translation-language">
                <option value="">Off — original transcript only</option>
                ${translationOptions}
              </select>
              <span class="text-xs text-tertiary" id="meeting-translation-help"></span>
            </div>
          </div>

          ${Recorder.supportsSystemAudio() ? `
          <div class="input-group" style="margin-top: var(--space-4);">
            <label class="system-audio-toggle" id="setup-system-audio-label" title="Capture audio from Zoom/Google Meet and other participants. When enabled, the browser will ask you to select a tab or window to share audio from.">
              <input type="checkbox" id="setup-system-audio" />
              <span class="system-audio-toggle-track">
                <span class="system-audio-toggle-thumb"></span>
              </span>
              <span class="system-audio-toggle-text">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m22 6-6 4.5L22 15z"/></svg>
                System Audio
              </span>
            </label>
            <span class="text-xs text-tertiary">Enable to capture Zoom/Meet audio from other participants. Browser will ask you to share a tab.</span>
          </div>
          ` : ''}

          <div class="flex gap-3" style="margin-top: var(--space-8);">
            <button class="btn btn-primary btn-lg flex-1" id="start-recording-btn">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="6" fill="currentColor"/></svg>
              Start Recording
            </button>
            <button class="btn btn-secondary btn-lg" id="save-draft-btn">
              Save as Draft
            </button>
          </div>
        </div>

        ${!Transcriber.isSupported() ? `
          <div class="card" style="margin-top: var(--space-4); border-color: var(--color-warning); background: var(--color-warning-muted);">
            <div class="flex items-center gap-3">
              <span>⚠️</span>
              <div>
                <strong style="color: var(--color-warning);">Realtime Audio Not Supported</strong>
                <p class="text-sm" style="margin-top: 4px;">This browser cannot stream microphone audio to Soniox. Please use a current Chrome, Edge, or Safari version.</p>
              </div>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  },

  _bindNewMeeting() {
    const translationSelect = document.getElementById('meeting-translation-language');
    const translationHelp = document.getElementById('meeting-translation-help');
    const updateTranslationHelp = () => {
      if (!translationSelect || !translationHelp) return;
      if (!translationSelect.value) {
        translationHelp.textContent = 'Realtime speech-to-text stays on and shows the original words in each detected spoken language.';
        return;
      }
      const targetName = translationSelect.selectedOptions[0]?.textContent?.trim() || translationSelect.value;
      translationHelp.textContent = `Realtime speech-to-text keeps the original transcript and adds a live translation to ${targetName}.`;
    };
    translationSelect?.addEventListener('change', updateTranslationHelp);
    updateTranslationHelp();

    document.getElementById('start-recording-btn')?.addEventListener('click', () => {
      const title = document.getElementById('meeting-title').value.trim() || 'Untitled Meeting';
      const participants = document.getElementById('meeting-participants').value
        .split(',').map(p => p.trim()).filter(Boolean);
      const language = document.getElementById('meeting-language').value;
      const translationLanguage = document.getElementById('meeting-translation-language').value;
      const captureSystemAudio = document.getElementById('setup-system-audio')?.checked || false;

      const meeting = Storage.saveMeeting({
        title,
        participants,
        language,
        translationLanguage,
        captureSystemAudio,
        status: 'draft'
      });

      this._pendingAutoStartMeetingId = meeting.id;
      this.navigate(`recording/${meeting.id}`);
    });

    document.getElementById('save-draft-btn')?.addEventListener('click', () => {
      const title = document.getElementById('meeting-title').value.trim() || 'Untitled Meeting';
      const participants = document.getElementById('meeting-participants').value
        .split(',').map(p => p.trim()).filter(Boolean);
      const language = document.getElementById('meeting-language').value;
      const translationLanguage = document.getElementById('meeting-translation-language').value;

      Storage.saveMeeting({ title, participants, language, translationLanguage, status: 'draft' });
      this.toast('Meeting draft saved', 'success');
      this.navigate('meetings');
      this._updateMeetingsCount();
    });
  },

  /* ══════════════════════════════════════════
     VIEW: Recording
     ══════════════════════════════════════════ */

  _renderRecording(meetingId) {
    const meeting = Storage.getMeeting(meetingId);
    if (!meeting) return this._renderNotFound();

    // Generate waveform bars
    const bars = Array.from({ length: 32 }, () => '<div class="waveform-bar"></div>').join('');

    return `
      <div class="view-enter">
        <div class="recording-layout">
          <!-- Top: Meeting info and recording controls -->
          <div class="recording-controls-panel ambient-glow">
            <div class="recording-meeting-info">
              <h2 style="margin-bottom: var(--space-2);">${Utils.escapeHtml(meeting.title)}</h2>
              <p class="text-sm">${meeting.participants.length > 0
                ? meeting.participants.map(participant => Utils.escapeHtml(participant)).join(', ')
                : 'No participants added'}</p>
            </div>

            <div class="recording-live-metrics">
              <div class="timer-display" id="rec-timer">00:00</div>
              <div class="text-xs text-tertiary" id="rec-cost">Soniox estimate: $0.0000</div>
              <div class="waveform-container" id="rec-waveform">
                ${bars}
              </div>
            </div>

            <div class="recording-actions">
              <div class="recording-action-row">
                <button class="btn btn-ghost btn-icon" id="rec-pause" title="Pause" style="display:none;">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
                </button>

                <button class="record-btn" id="rec-toggle" title="Start Recording">
                  <div class="record-inner"></div>
                </button>

                <button class="btn btn-ghost btn-icon" id="rec-resume" title="Resume" style="display:none;">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                </button>

                <button class="btn btn-secondary btn-sm" id="rec-stop" style="display:none;">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
                  Stop & Save
                </button>
                <button class="btn btn-ghost btn-sm" id="rec-discard" style="display:none;">
                  Discard
                </button>
              </div>

              <div id="rec-status" class="text-sm text-secondary">
                Press the record button to begin
              </div>
            </div>
          </div>

          <!-- Bottom: Original transcript and optional translation -->
          <div class="recording-streams ${meeting.translationLanguage ? 'has-translation' : 'transcript-only'}">
            <section class="recording-transcript-panel">
              <div class="panel-header">
                <h4 style="font-size: var(--text-sm);">📝 Live Transcript</h4>
                <span class="badge badge-primary" id="rec-lang-badge">${Utils.escapeHtml(meeting.language === 'auto' ? 'Auto multilingual' : (meeting.language || 'vi-VN'))}</span>
              </div>
              <div class="panel-body" id="rec-transcript-body">
                <div class="empty-state" id="rec-transcript-empty" style="padding: var(--space-8);">
                  <div class="empty-icon" style="width: 56px; height: 56px; font-size: 1.4rem;">💬</div>
                  <p class="text-sm">Original speech will appear here in real-time...</p>
                </div>
                <div id="rec-transcript-list" style="display:none;"></div>
              </div>
            </section>

            ${meeting.translationLanguage ? `
              <section class="recording-transcript-panel" id="rec-translation-section">
                <div class="panel-header">
                  <h4 style="font-size: var(--text-sm);">🌐 Live Translation</h4>
                  <span class="badge badge-success">→ ${Utils.escapeHtml(meeting.translationLanguage)}</span>
                </div>
                <div class="panel-body" id="rec-translation-body">
                  <div class="empty-state" id="rec-translation-empty" style="padding: var(--space-8);">
                    <div class="empty-icon" style="width: 56px; height: 56px; font-size: 1.4rem;">🌐</div>
                    <p class="text-sm">Translated speech will appear here in real-time...</p>
                  </div>
                  <div id="rec-translation-list" style="display:none;"></div>
                </div>
              </section>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  },

  _bindRecording(meetingId) {
    const meeting = Storage.getMeeting(meetingId);
    if (!meeting) return;

    const toggleBtn = document.getElementById('rec-toggle');
    const pauseBtn = document.getElementById('rec-pause');
    const resumeBtn = document.getElementById('rec-resume');
    const stopBtn = document.getElementById('rec-stop');
    const discardBtn = document.getElementById('rec-discard');
    const timerEl = document.getElementById('rec-timer');
    const costEl = document.getElementById('rec-cost');
    const statusEl = document.getElementById('rec-status');
    const waveformEl = document.getElementById('rec-waveform');
    const transcriptBody = document.getElementById('rec-transcript-body');
    const transcriptList = document.getElementById('rec-transcript-list');
    const transcriptEmpty = document.getElementById('rec-transcript-empty');
    const translationBody = document.getElementById('rec-translation-body');
    const translationEmpty = document.getElementById('rec-translation-empty');
    const translationList = document.getElementById('rec-translation-list');

    this._transcriptSegments = [...(meeting.transcript || [])];
    this._translationSegments = [...(meeting.translations || [])];
    this._interimText = '';
    let isRecordingActive = false;
    let isRecordingStarting = false;

    const updateWaveform = (data) => {
      const bars = waveformEl.querySelectorAll('.waveform-bar');
      const step = Math.floor(data.length / bars.length);
      bars.forEach((bar, i) => {
        const val = data[i * step] || 0;
        const height = Math.max(4, (val / 255) * 40);
        bar.style.height = `${height}px`;
        bar.style.background = val > 100 ? 'var(--accent-secondary)' : 'var(--accent-primary)';
      });
    };

    const resetWaveform = () => {
      waveformEl.querySelectorAll('.waveform-bar').forEach(bar => {
        bar.style.height = '4px';
        bar.style.background = 'var(--accent-primary)';
      });
    };

    const addTranscriptSegment = (channel, text, time, speaker, language) => {
      const isTranslation = channel === 'translation';
      const segments = isTranslation ? this._translationSegments : this._transcriptSegments;
      const list = isTranslation ? translationList : transcriptList;
      if (!list) return;
      segments.push({
        text,
        time,
        speaker: speaker ? `Speaker ${speaker}` : (isTranslation ? '' : 'Speaker'),
        language: language || ''
      });

      if (isTranslation) {
        if (translationEmpty) translationEmpty.style.display = 'none';
        if (translationList) translationList.style.display = 'block';
      } else {
        transcriptEmpty.style.display = 'none';
        transcriptList.style.display = 'block';
      }

      const block = document.createElement('div');
      block.className = 'transcript-block';
      block.innerHTML = `
        <span class="transcript-time">${Utils.formatTimestamp(time)}</span>
        <div>
          <div class="transcript-speaker">${Utils.escapeHtml(
            speaker ? `Speaker ${speaker}` : (isTranslation ? 'Translation' : 'Speaker')
          )}</div>
          <div class="transcript-text">${Utils.escapeHtml(text)}</div>
        </div>
      `;
      list.appendChild(block);

      // Auto-scroll
      const panelBody = isTranslation ? translationBody : transcriptBody;
      if (!panelBody) return;
      panelBody.scrollTop = panelBody.scrollHeight;
    };

    const updateInterim = (channel, text) => {
      const isTranslation = channel === 'translation';
      const list = isTranslation ? translationList : transcriptList;
      if (!list) return;
      let interimEl = document.getElementById(`rec-interim-${channel}`);
      if (!interimEl) {
        interimEl = document.createElement('div');
        interimEl.id = `rec-interim-${channel}`;
        interimEl.className = 'transcript-block';
        interimEl.style.opacity = '0.5';
        list.appendChild(interimEl);
        if (isTranslation) {
          if (translationEmpty) translationEmpty.style.display = 'none';
          if (translationList) translationList.style.display = 'block';
        } else {
          transcriptEmpty.style.display = 'none';
          transcriptList.style.display = 'block';
        }
      }
      interimEl.innerHTML = `
        <span class="transcript-time" style="color: var(--accent-secondary);">...</span>
        <div>
          <div class="transcript-text" style="color: var(--text-secondary); font-style: italic;">${Utils.escapeHtml(text)}</div>
        </div>
      `;
      const panelBody = isTranslation ? translationBody : transcriptBody;
      if (!panelBody) return;
      panelBody.scrollTop = panelBody.scrollHeight;
    };

    const removeInterim = (channel) => {
      if (channel) document.getElementById(`rec-interim-${channel}`)?.remove();
      else {
        document.getElementById('rec-interim-original')?.remove();
        document.getElementById('rec-interim-translation')?.remove();
      }
    };

    // Recorder callbacks
    Recorder.onTick = (seconds) => {
      timerEl.textContent = Utils.formatDuration(seconds);
      costEl.textContent = `Soniox estimate: ${this._formatUsd(this._estimateSonioxCost(seconds))}`;
    };

    Recorder.onWaveform = (data) => {
      updateWaveform(data);
    };

    Recorder.onStop = null;
    Recorder.onChunk = chunk => Transcriber.sendAudio(chunk);

    // Transcriber callbacks
    Transcriber.onResult = (result) => {
      if (result.isFinal) {
        removeInterim(result.channel);
        addTranscriptSegment(
          result.channel,
          result.text,
          result.timestamp || Recorder.getElapsedSeconds(),
          result.speaker,
          result.language
        );

        // Auto-save transcript periodically
        const m = Storage.getMeeting(meetingId);
        if (m) {
          m.transcript = [...this._transcriptSegments];
          m.translations = [...this._translationSegments];
          Storage.saveMeeting(m);
        }
      } else {
        updateInterim(result.channel, result.text);
      }
    };

    Transcriber.onStatusChange = (status) => {
      if (status === 'connecting') {
        statusEl.innerHTML = '<span class="badge badge-warning">Connecting to Soniox…</span>';
      } else if (status === 'listening') {
        statusEl.innerHTML = `<span class="badge badge-recording">● Recording · ${_activeAudioMode} · Soniox live</span>`;
      } else if (status === 'error') {
        statusEl.innerHTML = `<span class="badge badge-warning">Recording audio (${_activeAudioMode}) · transcription unavailable</span>`;
      }
    };
    Transcriber.onError = error => {
      this.toast(error.message || 'Soniox transcription failed', 'error');
    };

    // Toggle recording
    let _activeAudioMode = 'Mic';

    const startRecording = async () => {
      if (!isRecordingActive && !isRecordingStarting) {
        isRecordingStarting = true;
        toggleBtn.disabled = true;
        this._pendingAutoStartMeetingId = null;

        const wantSystemAudio = meeting.captureSystemAudio || false;
        statusEl.innerHTML = wantSystemAudio
          ? '<span class="badge badge-warning">Starting microphone + system audio…</span>'
          : '<span class="badge badge-warning">Starting microphone…</span>';

        // Handle system audio share being stopped mid-recording
        Recorder.onSystemAudioLost = () => {
          _activeAudioMode = 'Mic';
          this.toast('System audio share was stopped. Continuing with microphone only.', 'warning');
          statusEl.innerHTML = '<span class="badge badge-recording">● Recording · Mic only · Soniox live</span>';
        };

        // Start recorder with optional system audio
        const started = await Recorder.start({ captureSystemAudio: wantSystemAudio });
        if (!started) {
          isRecordingStarting = false;
          toggleBtn.disabled = false;
          this.toast('Could not access microphone. Please allow microphone access.', 'error');
          return;
        }

        const activeMeeting = Storage.getMeeting(meetingId);
        if (activeMeeting) {
          activeMeeting.status = 'recording';
          Storage.saveMeeting(activeMeeting);
        }

        const hasSystemAudio = Recorder.hasSystemAudio;
        _activeAudioMode = hasSystemAudio ? 'Mic + System Audio' : 'Mic';

        // Notify user about system audio status
        if (wantSystemAudio && hasSystemAudio) {
          this.toast('✅ System audio captured! Both mic and remote audio are being recorded.', 'success');
        } else if (wantSystemAudio && !hasSystemAudio) {
          this.toast('System audio was not captured (cancelled or unsupported). Recording mic only.', 'warning');
        }

        const transcriptionStarted = await Transcriber.start({
          meetingId,
          title: meeting.title,
          participants: meeting.participants,
          language: meeting.language || 'vi-VN',
          translationLanguage: meeting.translationLanguage || ''
        });

        if (transcriptionStarted) {
          const usageMeeting = Storage.getMeeting(meetingId);
          if (usageMeeting) {
            usageMeeting.sonioxUsage = {
              provider: 'soniox',
              model: 'stt-rt-v5',
              startedAt: new Date().toISOString(),
              pricingUsdPerHour: this.SONIOX_REALTIME_USD_PER_HOUR,
              translationEnabled: Boolean(meeting.translationLanguage),
              estimatedCostUsd: 0
            };
            Storage.saveMeeting(usageMeeting);
          }
        }

        isRecordingActive = true;
        isRecordingStarting = false;
        this._activeRecordingMeetingId = meetingId;
        toggleBtn.classList.add('recording');
        toggleBtn.title = 'Recording...';
        pauseBtn.style.display = 'flex';
        stopBtn.style.display = 'flex';
        discardBtn.style.display = 'flex';
        timerEl.classList.add('recording');

        statusEl.innerHTML = transcriptionStarted
          ? `<span class="badge badge-recording">● Recording · ${_activeAudioMode} · Soniox live</span>`
          : `<span class="badge badge-warning">Recording audio (${_activeAudioMode}) · transcription unavailable</span>`;
      }
    };
    toggleBtn.addEventListener('click', startRecording);
    if (this._pendingAutoStartMeetingId === meetingId) startRecording();

    // Pause
    pauseBtn.addEventListener('click', () => {
      Recorder.pause();
      Transcriber.pause();
      toggleBtn.classList.remove('recording');
      pauseBtn.style.display = 'none';
      resumeBtn.style.display = 'flex';
      timerEl.classList.remove('recording');
      statusEl.innerHTML = '<span class="badge badge-warning">⏸ Paused</span>';
      resetWaveform();
    });

    // Resume
    resumeBtn.addEventListener('click', () => {
      Recorder.resume();
      Transcriber.resume();
      toggleBtn.classList.add('recording');
      resumeBtn.style.display = 'none';
      pauseBtn.style.display = 'flex';
      timerEl.classList.add('recording');
      statusEl.innerHTML = '<span class="badge badge-recording">● Recording</span>';
    });

    // Stop & Save
    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      stopBtn.textContent = 'Saving…';
      removeInterim();
      isRecordingActive = false;

      const saved = await this._saveActiveRecording(meetingId);
      if (!saved) {
        stopBtn.disabled = false;
        stopBtn.textContent = 'Stop & Save';
        return;
      }

      this.toast('Meeting saved successfully!', 'success');
      this.navigate(`meeting/${meetingId}`, { force: true });
    });

    // Discard
    discardBtn.addEventListener('click', () => {
      this.showModal(`
        <div class="modal-header">
          <h3>Discard Recording?</h3>
          <button class="btn btn-ghost btn-icon" onclick="App.closeModal()">✕</button>
        </div>
        <p class="text-sm text-secondary">This will stop the recording and delete all data. This action cannot be undone.</p>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-danger" id="confirm-discard">Discard</button>
        </div>
      `);

      document.getElementById('confirm-discard').addEventListener('click', async () => {
        const confirmButton = document.getElementById('confirm-discard');
        confirmButton.disabled = true;
        confirmButton.textContent = 'Discarding…';
        isRecordingActive = false;
        await this._discardActiveRecording(meetingId);
        this.closeModal();
        this.toast('Recording discarded', 'warning');
        this.navigate('dashboard', { force: true });
      });
    });
  },

  /* ══════════════════════════════════════════
     VIEW: Meeting Detail
     ══════════════════════════════════════════ */

  _renderMeetingDetail(meetingId) {
    const meeting = Storage.getMeeting(meetingId);
    if (!meeting) return this._renderNotFound();

    const statusBadge = {
      completed: '<span class="badge badge-success">Completed</span>',
      recording: '<span class="badge badge-recording">● Recording</span>',
      interrupted: '<span class="badge badge-warning">Interrupted</span>',
      processing: '<span class="badge badge-warning">Processing audio…</span>',
      failed: '<span class="badge badge-warning">Processing failed</span>',
      draft: '<span class="badge badge-primary">Draft</span>'
    }[meeting.status] || '';

    const participantChips = meeting.participants.map(p =>
      `<span class="chip">${Utils.escapeHtml(p)}</span>`
    ).join('');

    const transcriptHtml = (meeting.transcript || []).map((seg, i) => `
      <div class="transcript-block" data-index="${i}">
        <span class="transcript-time">${Utils.formatTimestamp(seg.time)}</span>
        <div class="flex-1">
          <div class="transcript-speaker">${Utils.escapeHtml(seg.speaker || 'Speaker')}</div>
          <div class="transcript-text" contenteditable="true" data-seg-index="${i}">${Utils.escapeHtml(seg.text)}</div>
        </div>
      </div>
    `).join('') || '<div class="empty-state" style="padding:var(--space-8);"><p class="text-sm">No transcript recorded.</p></div>';
    const translationHtml = (meeting.translations || []).map(seg => `
      <div class="transcript-block">
        <span class="transcript-time">${Utils.formatTimestamp(seg.time)}</span>
        <div class="flex-1">
          <div class="transcript-speaker">${Utils.escapeHtml(seg.language || meeting.translationLanguage || 'Translation')}</div>
          <div class="transcript-text">${Utils.escapeHtml(seg.text)}</div>
        </div>
      </div>
    `).join('') || '<div class="empty-state" style="padding:var(--space-8);"><p class="text-sm">No translated transcript recorded.</p></div>';

    const actionItemsHtml = (meeting.actionItems || []).map(item => `
      <label class="checkbox ${item.done ? 'checked' : ''}" data-action-id="${Utils.escapeHtml(item.id)}">
        <input type="checkbox" ${item.done ? 'checked' : ''}>
        <span class="checkbox-label">${Utils.escapeHtml(item.text)}</span>
        ${item.assignee ? `<span class="chip" style="margin-left: auto;">${Utils.escapeHtml(item.assignee)}</span>` : ''}
        ${item.dueDate ? `<span class="chip"${item.assignee ? '' : ' style="margin-left: auto;"'}>${Utils.escapeHtml(item.dueDate)}</span>` : ''}
        <button class="btn btn-ghost btn-icon btn-sm action-delete" data-action-id="${Utils.escapeHtml(item.id)}" title="Delete" style="margin-left:var(--space-2);">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </label>
    `).join('') || '';

    // Audio player
    const audioPlayerHtml = (meeting.audioId || meeting.audioBlob) ? `
      <div class="audio-player" style="margin-bottom: var(--space-6);">
        <button class="play-btn" id="detail-play">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        <div class="progress-bar" id="detail-progress">
          <div class="progress-fill" id="detail-progress-fill" style="width:0%"></div>
        </div>
        <span class="audio-time" id="detail-audio-time">0:00</span>
      </div>
    ` : '';

    return `
      <div class="view-enter">
        <!-- Header -->
        <div class="meeting-detail-header">
          <div class="meeting-detail-info">
            <div class="flex items-center gap-3" style="margin-bottom: var(--space-2);">
              <h1 id="detail-title" style="cursor:text;" title="Click to edit">${Utils.escapeHtml(meeting.title)}</h1>
              <button class="btn btn-ghost btn-icon btn-sm" id="detail-title-edit" type="button" title="Edit meeting title" aria-label="Edit meeting title">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
              </button>
              ${statusBadge}
            </div>
            <div class="meeting-detail-meta">
              <span>📅 ${Utils.formatDate(meeting.date)}</span>
              <span>⏱️ ${Utils.formatDurationHuman(meeting.duration)}</span>
              ${meeting.sonioxUsage?.startedAt ? (() => {
                const usage = meeting.sonioxUsage;
                const providerName = this._sttProviderName(usage.provider || 'soniox');
                const cost = typeof usage.estimatedCostUsd === 'number' && Number.isFinite(usage.estimatedCostUsd)
                  ? ` · ${this._formatUsd(usage.estimatedCostUsd)}`
                  : '';
                return `<span>🎙️ ${Utils.escapeHtml(providerName)}${cost}</span>`;
              })() : ''}
              ${meeting.participants.length > 0 ? `<span>👥 ${meeting.participants.length} participants</span>` : ''}
            </div>
            ${participantChips ? `<div class="flex flex-wrap gap-2" style="margin-top: var(--space-3);">${participantChips}</div>` : ''}
          </div>
          <div class="flex gap-2">
            <button class="btn btn-secondary btn-sm" id="detail-export-md" title="Export Markdown">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Export
            </button>
            <button class="btn btn-danger btn-sm" id="detail-delete" title="Delete Meeting">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14H7L5 6"/><path d="M10 11v6M14 11v6"/></svg>
            </button>
          </div>
        </div>

        ${meeting.processingError ? `
          <div class="card" style="margin-bottom:var(--space-6); border-color:var(--color-warning); background:var(--color-warning-muted);">
            <strong style="color:var(--color-warning);">Audio processing failed</strong>
            <p class="text-sm" style="margin-top:var(--space-2);">${Utils.escapeHtml(meeting.processingError)}</p>
            <p class="text-xs text-tertiary" style="margin-top:var(--space-2);">The original audio is still stored locally and can be played below.</p>
          </div>
        ` : ''}

        ${audioPlayerHtml}

        <!-- Tabs -->
        <div class="tabs" style="margin-bottom: var(--space-6);">
          <button class="tab active" data-tab="transcript">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            Transcript
          </button>
          <button class="tab" data-tab="summary">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            Summary
          </button>
          ${meeting.translationLanguage ? `
            <button class="tab" data-tab="translation">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 8l6 6"/><path d="M4 14l6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="M22 22l-5-10-5 10"/><path d="M14 18h6"/></svg>
              Translation
            </button>
          ` : ''}
          <button class="tab" data-tab="actions">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            Actions <span class="text-xs text-tertiary" style="margin-left:4px;">${(meeting.actionItems||[]).length}</span>
          </button>
          <button class="tab" data-tab="notes">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Notes
          </button>
        </div>

        <!-- Tab Content -->
        <div class="meeting-detail-content">
          <div class="tab-content active" id="tab-transcript">
            <div class="flex justify-between items-center" style="margin-bottom: var(--space-4);">
              <span class="text-sm text-secondary">${(meeting.transcript || []).length} segments</span>
              <button class="btn btn-ghost btn-sm" id="copy-transcript">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                Copy All
              </button>
            </div>
            ${transcriptHtml}
          </div>

          <div class="tab-content" id="tab-summary">
            <div class="flex justify-between items-center" style="margin-bottom: var(--space-2); gap: var(--space-2); flex-wrap: wrap;">
              <span class="text-sm text-secondary">AI-generated summary</span>
              <div class="flex gap-2" style="align-items:center;">
                <select class="input input-sm" id="summary-language" style="width: auto;" title="Summary language">
                  ${this._summaryLanguageOptions()}
                </select>
                <select class="input input-sm" id="summary-provider" style="width: auto;">
                  ${this._summaryProviderOptions()}
                </select>
                <button class="btn btn-secondary btn-sm" id="copy-summary" ${meeting.summary ? '' : 'disabled'}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  Copy
                </button>
                <button class="btn btn-primary btn-sm" id="generate-summary">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                  ${meeting.summary ? 'Regenerate' : 'Generate Summary'}
                </button>
              </div>
            </div>
            <p class="text-xs text-tertiary" id="summary-provenance" style="margin-bottom: var(--space-4);">${this._summaryProvenance(meeting)}</p>
            <div class="card" id="summary-content" style="white-space: pre-wrap; line-height: var(--leading-relaxed);">
              ${meeting.summary ? Utils.escapeHtml(meeting.summary) : '<span class="text-tertiary">No summary yet. Click "Generate Summary" to create one.</span>'}
            </div>
          </div>

          ${meeting.translationLanguage ? `
            <div class="tab-content" id="tab-translation">
              <div class="flex justify-between items-center" style="margin-bottom: var(--space-4);">
                <span class="text-sm text-secondary">${(meeting.translations || []).length} translated segments · ${Utils.escapeHtml(meeting.translationLanguage)}</span>
              </div>
              ${translationHtml}
            </div>
          ` : ''}

          <div class="tab-content" id="tab-actions">
            <div class="flex justify-between items-center" style="margin-bottom: var(--space-4);">
              <span class="text-sm text-secondary">${(meeting.actionItems||[]).filter(a=>!a.done).length} pending</span>
              <button class="btn btn-secondary btn-sm" id="add-action">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Add Item
              </button>
            </div>
            <div class="card flex flex-col gap-3" id="action-items-list">
              ${actionItemsHtml || '<span class="text-tertiary text-sm">No action items yet.</span>'}
            </div>
          </div>

          <div class="tab-content" id="tab-notes">
            <textarea class="input" id="meeting-notes" style="min-height: 300px; width: 100%;" placeholder="Add your notes here...">${Utils.escapeHtml(meeting.notes || '')}</textarea>
            <button class="btn btn-primary btn-sm" id="save-notes" style="margin-top: var(--space-4);">Save Notes</button>
          </div>
        </div>
      </div>
    `;
  },

  _LLM_PROVIDER_NAMES: { codex: 'Codex', deepseek: 'DeepSeek', gemini: 'Google Gemini' },

  _llmProviderName(id) {
    return this._LLM_PROVIDER_NAMES[id] || id || 'the selected provider';
  },

  // Language picker for the summary. "Auto" keeps the meeting's own language.
  _summaryLanguageOptions() {
    const options = ['<option value="">Auto — meeting language</option>'];
    for (const lang of Transcriber.getTranslationLanguages()) {
      options.push(`<option value="${Utils.escapeHtml(lang.sonioxCode)}">${Utils.escapeHtml(lang.name)}</option>`);
    }
    return options.join('');
  },

  // Build the meeting-level provider picker ("Use default — X" plus each provider).
  _summaryProviderOptions() {
    const defaultId = Storage.getSettings().llmProvider || 'codex';
    const options = [`<option value="">Use default — ${Utils.escapeHtml(this._llmProviderName(defaultId))}</option>`];
    for (const id of Object.keys(this._LLM_PROVIDER_NAMES)) {
      options.push(`<option value="${id}">${Utils.escapeHtml(this._LLM_PROVIDER_NAMES[id])}</option>`);
    }
    return options.join('');
  },

  // Short provenance line for the current stored summary.
  _summaryProvenance(meeting) {
    const gen = meeting.summaryGeneration;
    if (!gen || !gen.provider) return '';
    const when = gen.generatedAt ? new Date(gen.generatedAt).toLocaleString() : '';
    const parts = [`Generated with ${this._llmProviderName(gen.provider)}`];
    if (gen.model && gen.model !== 'default') parts.push(gen.model);
    if (when) parts.push(when);
    return Utils.escapeHtml(parts.join(' · '));
  },

  _bindMeetingDetail(meetingId) {
    const meeting = Storage.getMeeting(meetingId);
    if (!meeting) return;

    // Edit the title from within the detail view (reuses the list editor modal).
    const openTitleEditor = () => this._openMeetingTitleEditor(meetingId);
    document.getElementById('detail-title')?.addEventListener('click', openTitleEditor);
    document.getElementById('detail-title-edit')?.addEventListener('click', openTitleEditor);

    // Tabs
    document.querySelectorAll('.tab[data-tab]').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab[data-tab]').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
      });
    });

    // Edit transcript inline
    document.querySelectorAll('.transcript-text[contenteditable]').forEach(el => {
      el.addEventListener('blur', () => {
        const idx = parseInt(el.dataset.segIndex);
        const m = Storage.getMeeting(meetingId);
        if (m && m.transcript[idx]) {
          m.transcript[idx].text = el.textContent;
          Storage.saveMeeting(m);
        }
      });
    });

    // Copy transcript
    document.getElementById('copy-transcript')?.addEventListener('click', async () => {
      await Export.copyTranscript(meeting);
      this.toast('Transcript copied to clipboard', 'success');
    });

    document.getElementById('copy-summary')?.addEventListener('click', async () => {
      const current = Storage.getMeeting(meetingId);
      if (!current?.summary) return;
      const copied = await Export.copySummary(current);
      this.toast(copied ? 'Summary copied to clipboard' : 'Could not copy summary', copied ? 'success' : 'error');
    });

    // Generate summary
    document.getElementById('generate-summary')?.addEventListener('click', async () => {
      const btn = document.getElementById('generate-summary');
      const content = document.getElementById('summary-content');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Generating...';
      content.innerHTML = '<div class="skeleton skeleton-text" style="width:100%"></div><div class="skeleton skeleton-text" style="width:90%"></div><div class="skeleton skeleton-text" style="width:75%"></div>';

      try {
        const provider = document.getElementById('summary-provider')?.value || '';
        const language = document.getElementById('summary-language')?.value || '';
        const result = await Summary.generate(meeting, { provider, language });
        const m = Storage.getMeeting(meetingId);
        if (m) {
          m.summary = result.summary;
          m.summaryDetails = result.details;
          if (result.generation) m.summaryGeneration = result.generation;
          // Never overwrite action items the user already curated (plan §7).
          if (result.actionItems.length > 0 && m.actionItems.length === 0) {
            m.actionItems = result.actionItems;
          }
          Storage.saveMeeting(m);
          const provenance = document.getElementById('summary-provenance');
          if (provenance) provenance.textContent = this._summaryProvenance(m);
        }
        content.textContent = result.summary;
        const copyButton = document.getElementById('copy-summary');
        if (copyButton) copyButton.disabled = false;
        this.toast('Summary generated!', 'success');
      } catch (e) {
        content.textContent = `Failed to generate summary: ${e.message}`;
        this.toast(e.message || 'Summary generation failed', 'error');
      }

      btn.disabled = false;
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Regenerate`;
    });

    // Action items - toggle
    document.querySelectorAll('.checkbox[data-action-id]').forEach(el => {
      const checkbox = el.querySelector('input[type="checkbox"]');
      checkbox.addEventListener('change', () => {
        Storage.toggleActionItem(meetingId, el.dataset.actionId);
        el.classList.toggle('checked');
      });
    });

    // Action items - delete
    document.querySelectorAll('.action-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        Storage.removeActionItem(meetingId, btn.dataset.actionId);
        btn.closest('.checkbox').remove();
        this.toast('Action item removed', 'info');
      });
    });

    // Add action item
    document.getElementById('add-action')?.addEventListener('click', () => {
      this.showModal(`
        <div class="modal-header">
          <h3>Add Action Item</h3>
          <button class="btn btn-ghost btn-icon" onclick="App.closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="input-group">
            <label>Task</label>
            <input type="text" class="input" id="new-action-text" placeholder="What needs to be done?" autofocus>
          </div>
          <div class="input-group">
            <label>Assignee <span class="text-tertiary">(optional)</span></label>
            <input type="text" class="input" id="new-action-assignee" placeholder="Who is responsible?">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-primary" id="save-action">Add</button>
        </div>
      `);

      document.getElementById('save-action').addEventListener('click', () => {
        const text = document.getElementById('new-action-text').value.trim();
        if (!text) return;
        const assignee = document.getElementById('new-action-assignee').value.trim();
        Storage.addActionItem(meetingId, { text, assignee });
        this.closeModal();
        this.toast('Action item added', 'success');
        this.navigate(`meeting/${meetingId}`);
      });
    });

    // Save notes
    document.getElementById('save-notes')?.addEventListener('click', () => {
      const m = Storage.getMeeting(meetingId);
      if (m) {
        m.notes = document.getElementById('meeting-notes').value;
        Storage.saveMeeting(m);
        this.toast('Notes saved', 'success');
      }
    });

    // Export
    document.getElementById('detail-export-md')?.addEventListener('click', () => {
      Export.downloadMarkdown(meeting);
      this.toast('Exported as Markdown', 'success');
    });

    // Delete
    document.getElementById('detail-delete')?.addEventListener('click', () => {
      this.showModal(`
        <div class="modal-header">
          <h3>Delete Meeting?</h3>
          <button class="btn btn-ghost btn-icon" onclick="App.closeModal()">✕</button>
        </div>
        <p class="text-sm text-secondary">This will permanently delete "${Utils.escapeHtml(meeting.title)}" and all associated data.</p>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-danger" id="confirm-delete-meeting">Delete</button>
        </div>
      `);
      document.getElementById('confirm-delete-meeting').addEventListener('click', async () => {
        await AudioStorage.delete(meetingId).catch(error => {
          console.warn('Could not remove recording audio:', error);
        });
        Storage.deleteMeeting(meetingId);
        await Storage.flush();
        this.closeModal();
        this.toast('Meeting deleted', 'warning');
        this._updateMeetingsCount();
        this.navigate('dashboard');
      });
    });

    // Audio player
    if (meeting.audioId || meeting.audioBlob) {
      const playBtn = document.getElementById('detail-play');
      const progressBar = document.getElementById('detail-progress');
      const progressFill = document.getElementById('detail-progress-fill');
      const audioTime = document.getElementById('detail-audio-time');
      let audio = null;
      let isPlaying = false;

      let audioUrl = null;

      playBtn?.addEventListener('click', async () => {
        if (!audio) {
          playBtn.disabled = true;
          try {
            const blob = meeting.audioId
              ? await AudioStorage.get(meeting.audioId)
              : Recorder.base64ToBlob(meeting.audioBlob);
            if (!blob) throw new Error('Recording audio was not found');
            audioUrl = URL.createObjectURL(blob);
            audio = new Audio(audioUrl);
          } catch (error) {
            this.toast(`Could not load audio: ${error.message}`, 'error');
            return;
          } finally {
            playBtn.disabled = false;
          }

          audio.addEventListener('timeupdate', () => {
            const pct = (audio.currentTime / audio.duration) * 100;
            progressFill.style.width = `${pct}%`;
            audioTime.textContent = Utils.formatTimestamp(audio.currentTime);
          });
          audio.addEventListener('ended', () => {
            isPlaying = false;
            playBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
          });
        }

        if (isPlaying) {
          audio.pause();
          isPlaying = false;
          playBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
        } else {
          audio.play();
          isPlaying = true;
          playBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
        }
      });

      progressBar?.addEventListener('click', (e) => {
        if (!audio) return;
        const rect = progressBar.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        audio.currentTime = pct * audio.duration;
      });
    }
  },

  /* ══════════════════════════════════════════
     VIEW: All Meetings
     ══════════════════════════════════════════ */

  _renderAllMeetings() {
    const meetings = Storage.getAllMeetings();
    const selectableIds = new Set(
      meetings.filter(meeting => !['recording', 'processing'].includes(meeting.status)).map(meeting => meeting.id)
    );
    this._selectedMeetingIds = new Set([...this._selectedMeetingIds].filter(id => selectableIds.has(id)));

    return `
      <div class="view-enter">
        <div class="meetings-list-header" style="margin-bottom: var(--space-4);">
          <div class="search-box" style="width: 320px;">
            <svg class="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="text" class="input" id="meetings-filter" placeholder="Filter meetings...">
          </div>
          <button class="btn btn-primary btn-sm" onclick="App.navigate('new')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            New Meeting
          </button>
        </div>

        ${meetings.length > 0 ? `
          <div class="meeting-selection-toolbar" id="meeting-selection-toolbar">
            <label class="checkbox meeting-select-all-label">
              <input type="checkbox" id="select-all-meetings" aria-label="Select all visible meetings">
              <span>Select all</span>
            </label>
            <span class="text-sm text-secondary" id="meeting-selection-count">0 selected</span>
            <button class="btn btn-danger btn-sm" id="delete-selected-meetings" type="button" disabled>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14H7L5 6"/></svg>
              Delete selected
            </button>
          </div>
        ` : ''}

        <div class="card" style="padding: 0;" id="meetings-list-container">
          ${meetings.length > 0 ? `
            <div id="meetings-list">
              ${meetings.map(m => this._renderMeetingItem(m, { selectable: true })).join('')}
            </div>
          ` : `
            <div class="empty-state">
              <div class="empty-icon">📋</div>
              <h3>No meetings yet</h3>
              <p>Create your first meeting to get started.</p>
              <button class="btn btn-primary" style="margin-top: var(--space-4);" onclick="App.navigate('new')">Create Meeting</button>
            </div>
          `}
        </div>
      </div>
    `;
  },

  _bindAllMeetings() {
    this._bindMeetingItemClicks();

    const updateSelectionUi = () => {
      const selectedCount = this._selectedMeetingIds.size;
      const count = document.getElementById('meeting-selection-count');
      const deleteButton = document.getElementById('delete-selected-meetings');
      if (count) count.textContent = `${selectedCount} selected`;
      if (deleteButton) deleteButton.disabled = selectedCount === 0;

      const visibleCheckboxes = [...document.querySelectorAll('.meeting-item:not([style*="display: none"]) .meeting-select-checkbox:not(:disabled)')];
      const selectedVisible = visibleCheckboxes.filter(checkbox => checkbox.checked).length;
      const selectAll = document.getElementById('select-all-meetings');
      if (selectAll) {
        selectAll.checked = visibleCheckboxes.length > 0 && selectedVisible === visibleCheckboxes.length;
        selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visibleCheckboxes.length;
        selectAll.disabled = visibleCheckboxes.length === 0;
      }
    };

    document.querySelectorAll('.meeting-select-checkbox').forEach(checkbox => {
      checkbox.addEventListener('change', event => {
        const id = event.currentTarget.closest('.meeting-item')?.dataset.meetingId;
        if (!id) return;
        if (event.currentTarget.checked) this._selectedMeetingIds.add(id);
        else this._selectedMeetingIds.delete(id);
        event.currentTarget.closest('.meeting-item')?.classList.toggle('is-selected', event.currentTarget.checked);
        updateSelectionUi();
      });
    });

    document.getElementById('select-all-meetings')?.addEventListener('change', event => {
      document.querySelectorAll('.meeting-item').forEach(item => {
        if (item.style.display === 'none') return;
        const checkbox = item.querySelector('.meeting-select-checkbox:not(:disabled)');
        if (!checkbox) return;
        checkbox.checked = event.currentTarget.checked;
        item.classList.toggle('is-selected', checkbox.checked);
        if (checkbox.checked) this._selectedMeetingIds.add(item.dataset.meetingId);
        else this._selectedMeetingIds.delete(item.dataset.meetingId);
      });
      updateSelectionUi();
    });

    document.getElementById('delete-selected-meetings')?.addEventListener('click', () => {
      const ids = [...this._selectedMeetingIds].filter(id => Storage.getMeeting(id));
      if (!ids.length) return;
      this.showModal(`
        <div class="modal-header">
          <h3>Delete ${ids.length} meetings?</h3>
          <button class="btn btn-ghost btn-icon" id="cancel-bulk-delete" type="button">✕</button>
        </div>
        <p class="text-sm text-secondary">This permanently deletes the selected meetings, recordings, transcripts, and summaries. This action cannot be undone.</p>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="cancel-bulk-delete-footer" type="button">Cancel</button>
          <button class="btn btn-danger" id="confirm-bulk-delete" type="button">Delete ${ids.length} meetings</button>
        </div>
      `);
      document.getElementById('cancel-bulk-delete')?.addEventListener('click', () => this.closeModal());
      document.getElementById('cancel-bulk-delete-footer')?.addEventListener('click', () => this.closeModal());
      document.getElementById('confirm-bulk-delete')?.addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = 'Deleting…';
        const audioResults = await Promise.allSettled(ids.map(id => AudioStorage.delete(id)));
        Storage.deleteMultipleMeetings(ids);
        try {
          await Storage.flush();
          this._selectedMeetingIds.clear();
          this.closeModal();
          this._updateMeetingsCount();
          const audioFailures = audioResults.filter(result => result.status === 'rejected').length;
          this.toast(
            audioFailures ? `${ids.length} meetings deleted; ${audioFailures} audio files could not be removed.` : `${ids.length} meetings deleted.`,
            audioFailures ? 'warning' : 'success'
          );
          this.navigate('meetings', { force: true });
        } catch (error) {
          button.disabled = false;
          button.textContent = `Delete ${ids.length} meetings`;
          this.toast(`Could not delete meetings: ${error.message}`, 'error');
        }
      });
    });

    // Filter
    const filterInput = document.getElementById('meetings-filter');
    filterInput?.addEventListener('input', Utils.debounce(() => {
      const q = filterInput.value.toLowerCase().trim();
      document.querySelectorAll('.meeting-item').forEach(el => {
        const title = el.querySelector('.meeting-title')?.textContent.toLowerCase() || '';
        el.style.display = title.includes(q) || !q ? '' : 'none';
      });
      updateSelectionUi();
    }, 200));
    updateSelectionUi();
  },

  /* ══════════════════════════════════════════
     VIEW: Search
     ══════════════════════════════════════════ */

  _renderSearch() {
    return `
      <div class="view-enter">
        <div class="search-box" style="margin-bottom: var(--space-6);">
          <svg class="search-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" class="input input-lg" id="search-input" placeholder="Search across all meetings, transcripts, notes..." autofocus>
        </div>

        <div id="search-results">
          <div class="empty-state" id="search-empty">
            <div class="empty-icon">🔍</div>
            <h3>Search your meetings</h3>
            <p>Find anything across titles, transcripts, notes, and action items.</p>
          </div>
        </div>
      </div>
    `;
  },

  _bindSearch() {
    const input = document.getElementById('search-input');
    const results = document.getElementById('search-results');

    input?.addEventListener('input', Utils.debounce(() => {
      const q = input.value.trim();
      if (!q) {
        results.innerHTML = `
          <div class="empty-state" id="search-empty">
            <div class="empty-icon">🔍</div>
            <h3>Search your meetings</h3>
            <p>Find anything across titles, transcripts, notes, and action items.</p>
          </div>
        `;
        return;
      }

      const searchResults = Storage.searchMeetings(q);
      if (searchResults.length === 0) {
        results.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">😕</div>
            <h3>No results found</h3>
            <p>Try a different search term.</p>
          </div>
        `;
        return;
      }

      results.innerHTML = `
        <p class="text-sm text-secondary" style="margin-bottom: var(--space-4);">${searchResults.length} result${searchResults.length !== 1 ? 's' : ''} found</p>
        <div class="flex flex-col gap-3">
          ${searchResults.map(r => `
            <div class="card card-interactive search-result" data-meeting-id="${Utils.escapeHtml(r.meeting.id)}">
              <div class="flex items-center justify-between" style="margin-bottom: var(--space-2);">
                <strong style="font-size: var(--text-sm);">${Utils.highlightText(r.meeting.title, q)}</strong>
                <span class="text-xs text-tertiary">${Utils.formatRelativeTime(r.meeting.date)}</span>
              </div>
              ${r.snippets.map(s => `
                <div class="text-sm text-secondary" style="margin-top: var(--space-2); padding-left: var(--space-3); border-left: 2px solid var(--border-default);">
                  <span class="text-xs text-tertiary">${Utils.escapeHtml(s.field)}${s.speaker ? ` · ${Utils.escapeHtml(s.speaker)}` : ''}</span>
                  <div>${Utils.highlightText(s.text.substring(0, 150), q)}${s.text.length > 150 ? '...' : ''}</div>
                </div>
              `).join('')}
            </div>
          `).join('')}
        </div>
      `;

      // Bind clicks
      results.querySelectorAll('.search-result').forEach(el => {
        el.addEventListener('click', () => {
          App.navigate(`meeting/${el.dataset.meetingId}`);
        });
      });
    }, 300));
  },

  /* ══════════════════════════════════════════
     VIEW: Report a Bug
     ══════════════════════════════════════════ */

  _renderBugReport() {
    return `
      <div class="view-enter report-bug-view">
        <div class="card report-bug-card">
          <div class="report-bug-heading">
            <div class="report-bug-icon">🐞</div>
            <div>
              <h2>Tell us what went wrong</h2>
              <p class="text-sm text-secondary">Describe the issue, download the diagnostic JSON, then send that file to Nguyen Leon through the support channel provided to you.</p>
            </div>
          </div>

          <form id="bug-report-form" class="report-bug-form">
            <label class="input-group">
              <span class="form-label">Short summary</span>
              <input class="input" id="bug-report-summary" maxlength="200" required placeholder="Example: Recording stops after 10 minutes">
            </label>
            <label class="input-group">
              <span class="form-label">What happened?</span>
              <textarea class="input bug-report-description" id="bug-report-description" maxlength="10000" rows="7" required placeholder="What were you doing, what did you expect, and what happened instead?"></textarea>
            </label>
            <label class="input-group">
              <span class="form-label">Contact email <span class="text-tertiary">(optional)</span></span>
              <input class="input" id="bug-report-contact" type="email" maxlength="320" placeholder="you@example.com">
            </label>
            <div class="diagnostic-privacy-note">
              <strong>Included:</strong> app/device information, meeting counts, provider names, and recent diagnostic logs.<br>
              <strong>Excluded:</strong> meeting content, recordings, titles, and credentials.<br>
              <strong>Important:</strong> downloading the report does not send it automatically.
            </div>
            <div class="report-bug-actions">
              <button class="btn btn-primary" id="create-bug-report" type="submit">Create &amp; Download Report</button>
            </div>
          </form>
        </div>
      </div>
    `;
  },

  _bindBugReport() {
    const form = document.getElementById('bug-report-form');
    form?.addEventListener('submit', async event => {
      event.preventDefault();
      const summary = document.getElementById('bug-report-summary').value.trim();
      const description = document.getElementById('bug-report-description').value.trim();
      const contact = document.getElementById('bug-report-contact').value.trim();
      if (!summary || !description) {
        this.toast('Add a summary and description before creating the report.', 'warning');
        return;
      }

      const button = document.getElementById('create-bug-report');
      button.disabled = true;
      button.textContent = 'Creating report…';
      try {
        const response = await fetch('/api/bug-reports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ summary, description, contact })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Could not create bug report');

        const blob = new Blob([`${JSON.stringify(data.report, null, 2)}\n`], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = data.filename || 'meetnote-bug-report.json';
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);

        form.reset();
        this.toast(`Bug report ${data.report.id.slice(0, 8)} created and downloaded.`, 'success');
        this._logClientEvent('info', 'bug_report_downloaded', 'User downloaded a bug report', {
          reportId: data.report.id
        });
      } catch (error) {
        this.toast(error.message, 'error');
      } finally {
        button.disabled = false;
        button.textContent = 'Create & Download Report';
      }
    });
    document.getElementById('bug-report-summary')?.focus();
  },

  /* ══════════════════════════════════════════
     VIEW: Settings
     ══════════════════════════════════════════ */

  _renderSettings() {
    const settings = Storage.getSettings();
    const stats = Storage.getStats();
    const languages = Transcriber.getSupportedLanguages();
    const langOptions = `<option value="auto" ${settings.language === 'auto' ? 'selected' : ''}>Auto-detect multilingual</option>` + languages.map(l =>
      `<option value="${l.code}" ${l.code === settings.language ? 'selected' : ''}>${l.name}</option>`
    ).join('');
    const translationOptions = Transcriber.getTranslationLanguages().map(language =>
      `<option value="${language.sonioxCode}" ${language.sonioxCode === settings.translationLanguage ? 'selected' : ''}>${language.name}</option>`
    ).join('');

    return `
      <div class="view-enter" style="max-width: 700px;">
        <!-- General -->
        <div class="settings-section">
          <h3 style="margin-bottom: var(--space-4);">General</h3>

          <div class="settings-row">
            <div class="settings-row-info">
              <h4>Default Spoken Language</h4>
              <p>Expected language, or auto-detect for multilingual meetings</p>
            </div>
            <select class="input" id="setting-language" style="width: 200px;">
              ${langOptions}
            </select>
          </div>

          <div class="settings-row">
            <div class="settings-row-info">
              <h4>Appearance</h4>
              <p>Choose the app color theme</p>
            </div>
            <select class="input" id="setting-theme" style="width: 200px;">
              <option value="dark" ${settings.theme === 'dark' ? 'selected' : ''}>Dark</option>
              <option value="light" ${settings.theme === 'light' ? 'selected' : ''}>Light</option>
              <option value="system" ${settings.theme === 'system' ? 'selected' : ''}>Follow system</option>
            </select>
          </div>

          <div class="settings-row">
            <div class="settings-row-info">
              <h4>Default Translate To</h4>
              <p>Language used for Soniox live translated captions</p>
            </div>
            <select class="input" id="setting-translation-language" style="width: 200px;">
              <option value="">Off</option>
              ${translationOptions}
            </select>
          </div>

          <div class="settings-row">
            <div class="settings-row-info">
              <h4>Show Timestamps</h4>
              <p>Display timestamps in transcript view</p>
            </div>
            <label class="toggle">
              <input type="checkbox" id="setting-timestamps" ${settings.showTimestamps ? 'checked' : ''}>
            </label>
          </div>
        </div>

        <!-- Speech & Translation -->
        <div class="settings-section">
          <h3 style="margin-bottom: var(--space-2);">Speech &amp; Translation</h3>
          <p class="text-sm text-secondary" style="margin-bottom: var(--space-4);">Secrets stay in the operating system's secure credential storage — macOS Keychain or Windows DPAPI — and are never returned to the browser. The selected provider transcribes <strong>uploaded recordings</strong>, and also <strong>live recording</strong> when it supports streaming (Soniox, Deepgram). Whisper and Google are upload-only; live recording falls back to Soniox.</p>

          <div class="settings-row">
            <div class="settings-row-info">
              <h4>Default Provider</h4>
              <p>Used to transcribe uploaded recordings</p>
            </div>
            <select class="input" id="setting-stt-provider" style="width: 220px;"></select>
          </div>

          <div class="settings-row">
            <div class="settings-row-info">
              <h4>Model</h4>
              <p>Model used for the selected provider</p>
            </div>
            <select class="input" id="setting-stt-model" style="width: 220px;"></select>
          </div>

          <div class="settings-row">
            <div class="settings-row-info">
              <h4 id="stt-status-name">Provider status</h4>
              <p id="stt-status-text">Checking configuration…</p>
            </div>
            <span class="badge badge-warning" id="stt-status-badge">Checking</span>
          </div>

          <div id="stt-key-controls" style="display:none;">
            <div class="settings-row">
              <div class="settings-row-info">
                <h4 id="stt-key-label">API Key</h4>
                <p>Protected by macOS Keychain or Windows DPAPI. Never returned to the browser.</p>
              </div>
              <input type="password" class="input" id="setting-stt-key" placeholder="Enter API key" autocomplete="off" style="width: 280px;">
            </div>
            <div class="flex gap-2" style="margin-top: var(--space-2);">
              <button class="btn btn-secondary btn-sm" id="stt-save-key">Save Key</button>
              <button class="btn btn-ghost btn-sm" id="stt-remove-key">Remove Key</button>
            </div>
          </div>
          <div class="flex gap-2" style="margin-top: var(--space-3);">
            <button class="btn btn-secondary btn-sm" id="stt-test-key">Test Connection</button>
          </div>
        </div>

        <!-- Meeting Notes AI -->
        <div class="settings-section">
          <h3 style="margin-bottom: var(--space-2);">Meeting Notes AI</h3>
          <p class="text-sm text-secondary" style="margin-bottom: var(--space-4);">Transcript text is sent to the selected provider to generate summaries and title suggestions. Audio is never sent.</p>

          <div class="settings-row">
            <div class="settings-row-info">
              <h4>Default Provider</h4>
              <p>Used when generating summaries and titles</p>
            </div>
            <select class="input" id="setting-llm-provider" style="width: 220px;"></select>
          </div>

          <div class="settings-row">
            <div class="settings-row-info">
              <h4>Model</h4>
              <p>Model used for the selected provider</p>
            </div>
            <select class="input" id="setting-llm-model" style="width: 220px;"></select>
          </div>

          <div class="settings-row">
            <div class="settings-row-info">
              <h4 id="llm-status-name">Provider status</h4>
              <p id="llm-status-text">Checking configuration…</p>
            </div>
            <span class="badge badge-warning" id="llm-status-badge">Checking</span>
          </div>

          <div id="llm-key-controls" style="display:none;">
            <div class="settings-row">
              <div class="settings-row-info">
                <h4 id="llm-key-label">API Key</h4>
                <p>Protected by macOS Keychain or Windows DPAPI. Never returned to the browser.</p>
              </div>
              <input type="password" class="input" id="setting-llm-key" placeholder="Enter API key" autocomplete="off" style="width: 280px;">
            </div>
            <div class="flex gap-2" style="margin-top: var(--space-2);">
              <button class="btn btn-secondary btn-sm" id="llm-save-key">Save Key</button>
              <button class="btn btn-ghost btn-sm" id="llm-remove-key">Remove Key</button>
            </div>
          </div>
          <div class="card" id="llm-cli-setup" style="display:none; margin-top: var(--space-3);">
            <strong class="text-sm">Connect Codex</strong>
            <p class="text-sm text-secondary" style="margin-top: var(--space-2);">Install the Codex CLI, then run <code>codex login</code> in Terminal or PowerShell. Return here and check the connection.</p>
          </div>
          <div class="flex gap-2" style="margin-top: var(--space-3);">
            <button class="btn btn-secondary btn-sm" id="llm-test-key">Test Connection</button>
          </div>
        </div>

        <!-- Data -->
        <div class="settings-section">
          <h3 style="margin-bottom: var(--space-4);">Data Management</h3>

          <div class="card" style="margin-bottom: var(--space-4);">
            <div class="flex items-center justify-between">
              <div>
                <strong class="text-sm">${stats.totalMeetings}</strong> <span class="text-sm text-secondary">meetings</span>
                <span class="text-tertiary" style="margin: 0 var(--space-2);">·</span>
                <strong class="text-sm">${stats.totalHours}</strong> <span class="text-sm text-secondary">hours</span>
                <span class="text-tertiary" style="margin: 0 var(--space-2);">·</span>
                <strong class="text-sm">${stats.totalActions}</strong> <span class="text-sm text-secondary">action items</span>
              </div>
            </div>
          </div>

          <div class="flex gap-3">
            <button class="btn btn-secondary btn-sm" id="setting-export">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Export Backup
            </button>
            <button class="btn btn-secondary btn-sm" id="setting-import">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              Import Backup
            </button>
            <button class="btn btn-danger btn-sm" id="setting-clear">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14H7L5 6"/></svg>
              Clear All Data
            </button>
          </div>
          <p class="text-xs text-tertiary" style="margin-top: var(--space-3);">
            Backups include meeting metadata, transcripts, notes, actions, and settings. Audio recordings remain in <code>storage/audio</code>.
          </p>
          <input type="file" id="import-file-input" accept=".json" style="display:none;">
        </div>

        <!-- Support & diagnostics -->
        <div class="settings-section">
          <h3 style="margin-bottom: var(--space-2);">Support & Diagnostics</h3>
          <p class="text-sm text-secondary" style="margin-bottom: var(--space-4);">
            MeetNote keeps a small rotating local log to help diagnose crashes and failed operations.
          </p>
          <div class="flex gap-3 flex-wrap">
            <button class="btn btn-primary btn-sm" id="setting-bug-report" type="button">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 2h8l1 4H7l1-4Z"/><rect x="5" y="6" width="14" height="15" rx="3"/><path d="M2 13h3M19 13h3M9 11v5M15 11v5"/></svg>
              Report a Bug
            </button>
            <button class="btn btn-secondary btn-sm" id="setting-view-logs" type="button">View Recent Logs</button>
          </div>
          <p class="text-xs text-tertiary" style="margin-top: var(--space-3);">
            Bug reports exclude recordings, transcripts, translations, notes, summaries, action items, meeting titles, and API keys.
          </p>
        </div>

        <!-- Save -->
        <div style="margin-top: var(--space-6);">
          <button class="btn btn-primary" id="save-settings">Save Settings</button>
        </div>

        <!-- About -->
        <div class="settings-section" style="border-bottom: none;">
          <div class="text-sm text-tertiary" style="text-align: center; padding: var(--space-4);">
            <strong>MeetNote AI</strong> v1.1.1 · Local-first · Built with ❤️<br>
            Credit by <a class="creator-credit" href="https://nguyenleon.com" target="_blank" rel="noopener noreferrer">Nguyen Leon</a><br>
            Meeting data and recordings are stored locally on this device. Speech recognition and configured AI features may send audio or text to the selected service.
          </div>
        </div>
      </div>
    `;
  },

  _bindSettings() {
    document.getElementById('setting-theme')?.addEventListener('change', event => {
      this._applyTheme(event.target.value);
    });

    this._refreshProviders('stt');
    this._bindProviderControls('stt');
    this._refreshProviders('llm');
    this._bindProviderControls('llm');

    // Resolve a provider/model selection, blocking a not-ready default. Returns
    // { provider, models } or null if the chosen provider cannot be the default.
    const resolveSelection = (kind, cfg) => {
      const providerId = document.getElementById(`setting-${cfg.prefix}-provider`)?.value || cfg.fallback;
      const modelId = document.getElementById(`setting-${cfg.prefix}-model`)?.value || '';
      const selected = (this._providerState?.[kind]?.providers || []).find(p => p.id === providerId);
      if (selected && !selected.available) {
        this.toast(`${selected.name} is not ready yet. Configure it before setting it as default.`, 'error');
        return null;
      }
      const models = { ...(Storage.getSettings()[cfg.modelsKey] || {}) };
      if (modelId) models[providerId] = modelId;
      return { provider: providerId, models };
    };

    // Save settings
    document.getElementById('save-settings')?.addEventListener('click', async () => {
      try {
        const llm = resolveSelection('llm', this._PROVIDER_UI.llm);
        if (!llm) return;
        const stt = resolveSelection('stt', this._PROVIDER_UI.stt);
        if (!stt) return;

        Storage.saveSettings({
          language: document.getElementById('setting-language').value,
          translationLanguage: document.getElementById('setting-translation-language').value,
          theme: document.getElementById('setting-theme').value,
          showTimestamps: document.getElementById('setting-timestamps').checked,
          llmProvider: llm.provider,
          llmModels: llm.models,
          sttProvider: stt.provider,
          sttModels: stt.models,
        });
        await Storage.flush();
        this.toast('Settings saved', 'success');
        await this._refreshProviders('stt');
        await this._refreshProviders('llm');
      } catch (error) {
        this.toast(`Could not save settings: ${error.message}`, 'error');
      }
    });

    // Export backup
    document.getElementById('setting-export')?.addEventListener('click', () => {
      Export.downloadBackup();
      this.toast('Backup downloaded', 'success');
    });

    // Import backup
    document.getElementById('setting-import')?.addEventListener('click', () => {
      document.getElementById('import-file-input').click();
    });

    document.getElementById('import-file-input')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const result = await Export.importBackup(file);
      if (result.success) {
        try {
          await Storage.flush();
          await AudioStorage.clear();
          this.toast(`Imported ${result.count} meetings`, 'success');
          this._updateMeetingsCount();
          this.navigate('settings');
        } catch (error) {
          this.toast(`Import could not be written: ${error.message}`, 'error');
        }
      } else {
        this.toast(`Import failed: ${result.error}`, 'error');
      }
    });

    document.getElementById('setting-view-logs')?.addEventListener('click', async () => {
      try {
        const response = await fetch('/api/logs', { cache: 'no-store' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Could not load diagnostic logs');
        const lines = (data.logs || []).slice(-100).map(entry => {
          const details = entry.details && Object.keys(entry.details).length ? ` ${JSON.stringify(entry.details)}` : '';
          return `${entry.timestamp || ''} [${String(entry.level || 'info').toUpperCase()}] ${entry.event || 'event'}${details}`;
        });
        this.showModal(`
          <div class="modal-header">
            <h3>Recent Diagnostic Logs</h3>
            <button class="btn btn-ghost btn-icon" id="close-diagnostic-logs" type="button">✕</button>
          </div>
          <p class="text-xs text-tertiary" style="margin-bottom: var(--space-3);">Newest events appear at the bottom. Sensitive credential fields are redacted.</p>
          <pre class="diagnostic-log-view">${Utils.escapeHtml(lines.join('\n') || 'No log entries yet.')}</pre>
          <div class="modal-footer">
            <button class="btn btn-secondary" id="close-diagnostic-logs-footer" type="button">Close</button>
          </div>
        `);
        document.getElementById('close-diagnostic-logs')?.addEventListener('click', () => this.closeModal());
        document.getElementById('close-diagnostic-logs-footer')?.addEventListener('click', () => this.closeModal());
      } catch (error) {
        this.toast(error.message, 'error');
      }
    });

    document.getElementById('setting-bug-report')?.addEventListener('click', () => this.navigate('report-bug'));

    // Clear all data
    document.getElementById('setting-clear')?.addEventListener('click', () => {
      this.showModal(`
        <div class="modal-header">
          <h3>⚠️ Clear All Data?</h3>
          <button class="btn btn-ghost btn-icon" onclick="App.closeModal()">✕</button>
        </div>
        <p class="text-sm text-secondary">This will permanently delete all meetings, settings, and recordings. This action cannot be undone.</p>
        <label class="form-group">
          <span class="form-label">Type <strong>DELETE</strong> to confirm</span>
          <input class="input" id="confirm-clear-text" autocomplete="off" spellcheck="false">
        </label>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
          <button class="btn btn-danger" id="confirm-clear-all" disabled>Clear Everything</button>
        </div>
      `);

      const confirmInput = document.getElementById('confirm-clear-text');
      const confirmButton = document.getElementById('confirm-clear-all');
      confirmInput.addEventListener('input', () => {
        confirmButton.disabled = confirmInput.value.trim() !== 'DELETE';
      });
      confirmInput.focus();

      confirmButton.addEventListener('click', async () => {
        confirmButton.disabled = true;
        confirmButton.textContent = 'Clearing…';
        try {
          await Storage.clearAll();
          this.closeModal();
          this.toast('All data cleared', 'warning');
          this._updateMeetingsCount();
          this.navigate('settings');
        } catch (error) {
          confirmButton.disabled = false;
          confirmButton.textContent = 'Clear Everything';
          this.toast(`Could not clear data: ${error.message}`, 'error');
        }
      });
    });
  },

  // Human labels for provider status states.
  _PROVIDER_STATE_LABEL: {
    ready: { text: 'Ready', badge: 'badge-success' },
    setup_required: { text: 'Setup required', badge: 'badge-warning' },
    invalid: { text: 'Invalid credentials', badge: 'badge-danger' },
    unavailable: { text: 'Unavailable', badge: 'badge-warning' }
  },

  // Config for the two provider pickers (Meeting Notes AI + Speech). Both share
  // the same endpoint contract and DOM layout, keyed by element-id prefix.
  _PROVIDER_UI: {
    llm: { endpoint: '/api/llm/providers', prefix: 'llm', providerKey: 'llmProvider', modelsKey: 'llmModels', fallback: 'codex' },
    stt: { endpoint: '/api/stt/providers', prefix: 'stt', providerKey: 'sttProvider', modelsKey: 'sttModels', fallback: 'soniox' }
  },

  // Fetch provider metadata and repopulate the picker for one kind ('llm'|'stt').
  async _refreshProviders(kind) {
    const cfg = this._PROVIDER_UI[kind];
    const providerSelect = document.getElementById(`setting-${cfg.prefix}-provider`);
    if (!providerSelect) return;
    try {
      const response = await fetch(cfg.endpoint, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || data.error || 'Could not load providers');

      this._providerState = this._providerState || {};
      this._providerState[kind] = { providers: data.providers || [], defaultProvider: data.defaultProvider || cfg.fallback };
      const desired = providerSelect.value || Storage.getSettings()[cfg.providerKey] || data.defaultProvider || cfg.fallback;

      providerSelect.innerHTML = data.providers.map(provider => {
        const suffix = provider.available ? '' : ' — setup required';
        return `<option value="${Utils.escapeHtml(provider.id)}">${Utils.escapeHtml(provider.name)}${suffix}</option>`;
      }).join('');
      providerSelect.value = data.providers.some(p => p.id === desired) ? desired : (data.providers[0]?.id || cfg.fallback);

      this._renderProviderDetail(kind);
    } catch (error) {
      const statusText = document.getElementById(`${cfg.prefix}-status-text`);
      const statusBadge = document.getElementById(`${cfg.prefix}-status-badge`);
      if (statusText) statusText.textContent = error.message;
      if (statusBadge) statusBadge.textContent = 'Unavailable';
    }
  },

  // Sync model list, status badge and key controls to the selected provider.
  _renderProviderDetail(kind) {
    const cfg = this._PROVIDER_UI[kind];
    const providerSelect = document.getElementById(`setting-${cfg.prefix}-provider`);
    const modelSelect = document.getElementById(`setting-${cfg.prefix}-model`);
    const statusName = document.getElementById(`${cfg.prefix}-status-name`);
    const statusText = document.getElementById(`${cfg.prefix}-status-text`);
    const statusBadge = document.getElementById(`${cfg.prefix}-status-badge`);
    const keyControls = document.getElementById(`${cfg.prefix}-key-controls`);
    const keyLabel = document.getElementById(`${cfg.prefix}-key-label`);
    const testButton = document.getElementById(`${cfg.prefix}-test-key`);
    const cliSetup = document.getElementById(`${cfg.prefix}-cli-setup`);
    if (!providerSelect || !modelSelect) return;

    const provider = (this._providerState?.[kind]?.providers || []).find(p => p.id === providerSelect.value);
    if (!provider) return;

    const savedModel = (Storage.getSettings()[cfg.modelsKey] || {})[provider.id] || provider.selectedModel;
    modelSelect.innerHTML = (provider.models || []).map(model =>
      `<option value="${Utils.escapeHtml(model.id)}">${Utils.escapeHtml(model.label || model.id)}</option>`
    ).join('');
    if (provider.models?.some(m => m.id === savedModel)) modelSelect.value = savedModel;
    modelSelect.disabled = (provider.models || []).length <= 1;

    const label = this._PROVIDER_STATE_LABEL[provider.state] || this._PROVIDER_STATE_LABEL.setup_required;
    if (statusName) statusName.textContent = `${provider.name} status`;
    if (statusBadge) {
      statusBadge.className = `badge ${label.badge}`;
      statusBadge.textContent = label.text;
    }
    if (statusText) statusText.textContent = provider.message || '';
    if (keyControls) keyControls.style.display = provider.needsKey ? '' : 'none';
    if (keyLabel) keyLabel.textContent = `${provider.name} API Key`;
    if (cliSetup) cliSetup.style.display = provider.kind === 'cli' ? '' : 'none';
    if (testButton) testButton.textContent = provider.kind === 'cli' ? 'Connect / Check Codex' : 'Test Connection';
  },

  _bindProviderControls(kind) {
    const cfg = this._PROVIDER_UI[kind];
    const currentProvider = () => document.getElementById(`setting-${cfg.prefix}-provider`)?.value || '';

    document.getElementById(`setting-${cfg.prefix}-provider`)?.addEventListener('change', () => this._renderProviderDetail(kind));

    document.getElementById(`${cfg.prefix}-save-key`)?.addEventListener('click', async () => {
      const providerId = currentProvider();
      const input = document.getElementById(`setting-${cfg.prefix}-key`);
      const apiKey = input?.value.trim();
      if (!apiKey) { this.toast('Enter an API key first', 'error'); return; }
      try {
        const response = await fetch(`${cfg.endpoint}/${encodeURIComponent(providerId)}/key`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error?.message || data.error || 'Could not save the key');
        input.value = '';
        this.toast('API key saved', 'success');
        await this._refreshProviders(kind);
      } catch (error) {
        this.toast(error.message, 'error');
      }
    });

    document.getElementById(`${cfg.prefix}-test-key`)?.addEventListener('click', async () => {
      const providerId = currentProvider();
      const btn = document.getElementById(`${cfg.prefix}-test-key`);
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Testing…';
      try {
        const response = await fetch(`${cfg.endpoint}/${encodeURIComponent(providerId)}/test`, { method: 'POST' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error?.message || data.error || 'Connection failed');
        this.toast(data.message || 'Connection succeeded', 'success');
      } catch (error) {
        this.toast(error.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = original;
        await this._refreshProviders(kind);
      }
    });

    document.getElementById(`${cfg.prefix}-remove-key`)?.addEventListener('click', async () => {
      const providerId = currentProvider();
      try {
        const response = await fetch(`${cfg.endpoint}/${encodeURIComponent(providerId)}/key`, { method: 'DELETE' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error?.message || data.error || 'Could not remove the key');
        this.toast('API key removed', 'info');
        await this._refreshProviders(kind);
      } catch (error) {
        this.toast(error.message, 'error');
      }
    });
  },

  /* ══════════════════════════════════════════
     Shared Components
     ══════════════════════════════════════════ */

  _renderMeetingItem(meeting, options = {}) {
    const statusBadges = {
      completed: '<span class="badge badge-success">Completed</span>',
      recording: '<span class="badge badge-recording">● Recording</span>',
      interrupted: '<span class="badge badge-warning">Interrupted</span>',
      processing: '<span class="badge badge-warning">Processing…</span>',
      failed: '<span class="badge badge-warning">Failed</span>',
      draft: '<span class="badge badge-primary">Draft</span>'
    };

    const pendingActions = (meeting.actionItems || []).filter(a => !a.done).length;
    const hasTemporaryTitle = this._isDefaultMeetingTitle(meeting.title);
    const selectable = Boolean(options.selectable);
    const selectionDisabled = ['recording', 'processing'].includes(meeting.status);
    const selected = selectable && this._selectedMeetingIds.has(meeting.id);

    return `
      <div class="meeting-item ${hasTemporaryTitle ? 'has-temporary-title' : ''} ${selected ? 'is-selected' : ''}" data-meeting-id="${Utils.escapeHtml(meeting.id)}">
        ${selectable ? `
          <label class="meeting-select-control" title="${selectionDisabled ? 'Wait for processing to finish before deleting' : 'Select meeting'}">
            <input class="meeting-select-checkbox" type="checkbox" ${selected ? 'checked' : ''} ${selectionDisabled ? 'disabled' : ''} aria-label="Select ${Utils.escapeHtml(meeting.title || 'meeting')}">
          </label>
        ` : ''}
        <div class="meeting-icon">📋</div>
        <div class="meeting-info">
          <div class="meeting-title ${hasTemporaryTitle ? 'meeting-title-temporary' : ''}">${Utils.escapeHtml(meeting.title || 'Untitled Meeting')}</div>
          <div class="meeting-meta">
            <span>${Utils.formatRelativeTime(meeting.date)}</span>
            <span class="dot"></span>
            <span>${Utils.formatDurationHuman(meeting.duration)}</span>
            ${pendingActions > 0 ? `<span class="dot"></span><span>${pendingActions} action${pendingActions > 1 ? 's' : ''}</span>` : ''}
          </div>
        </div>
        <div class="meeting-actions">
          ${hasTemporaryTitle ? `
            <button class="btn btn-secondary btn-sm ai-title-btn" type="button" title="Suggest a title from the transcript">
              ✨ AI title
            </button>
          ` : ''}
          <button class="btn btn-ghost btn-icon btn-sm edit-title-btn" type="button" title="Edit meeting title" aria-label="Edit meeting title">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          </button>
        </div>
        ${statusBadges[meeting.status] || ''}
      </div>
    `;
  },

  _bindMeetingItemClicks() {
    document.querySelectorAll('.meeting-item[data-meeting-id]').forEach(el => {
      el.querySelector('.edit-title-btn')?.addEventListener('click', event => {
        event.stopPropagation();
        this._openMeetingTitleEditor(el.dataset.meetingId);
      });
      el.querySelector('.ai-title-btn')?.addEventListener('click', event => {
        event.stopPropagation();
        this._suggestMeetingTitle(el.dataset.meetingId, event.currentTarget);
      });
      el.addEventListener('click', event => {
        if (event.target.closest('button, input, label')) return;
        App.navigate(`meeting/${el.dataset.meetingId}`);
      });
    });
  },

  _openMeetingTitleEditor(meetingId) {
    const meeting = Storage.getMeeting(meetingId);
    if (!meeting) return;

    this.showModal(`
      <div class="modal-header">
        <h3>Edit Meeting Title</h3>
        <button class="btn btn-ghost btn-icon" id="cancel-title-edit" type="button">✕</button>
      </div>
      <div class="input-group">
        <label for="edit-meeting-title">Meeting Title</label>
        <input class="input" id="edit-meeting-title" maxlength="120" value="${Utils.escapeHtml(meeting.title || '')}">
        <span class="text-xs text-tertiary">The original meeting date and time remain available in its metadata.</span>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="cancel-title-edit-footer" type="button">Cancel</button>
        <button class="btn btn-primary" id="save-meeting-title" type="button">Save Title</button>
      </div>
    `);

    const input = document.getElementById('edit-meeting-title');
    const save = async () => {
      const title = input.value.trim();
      if (!title) {
        this.toast('Meeting title cannot be empty.', 'warning');
        input.focus();
        return;
      }
      Storage.saveMeeting({ ...meeting, title });
      await Storage.flush();
      this.closeModal();
      this.toast('Meeting title updated.', 'success');
      // Re-render the current view; rebuild the full route so the detail view
      // (currentRoute 'meeting' + currentMeetingId) is not dropped to the list.
      const route = this.currentMeetingId
        ? `${this.currentRoute}/${this.currentMeetingId}`
        : (this.currentRoute || 'meetings');
      this.navigate(route, { force: true });
    };

    document.getElementById('save-meeting-title')?.addEventListener('click', save);
    document.getElementById('cancel-title-edit')?.addEventListener('click', () => this.closeModal());
    document.getElementById('cancel-title-edit-footer')?.addEventListener('click', () => this.closeModal());
    input?.addEventListener('keydown', event => {
      if (event.key === 'Enter') save();
      if (event.key === 'Escape') this.closeModal();
    });
    input?.focus();
    input?.select();
  },

  async _suggestMeetingTitle(meetingId, button) {
    const meeting = Storage.getMeeting(meetingId);
    if (!meeting) return;
    if (!Array.isArray(meeting.transcript) || meeting.transcript.length === 0) {
      this.toast('A transcript is needed before AI can suggest a title.', 'warning');
      return;
    }

    const originalText = button?.textContent;
    if (button) {
      button.disabled = true;
      button.textContent = 'Suggesting…';
    }
    try {
      const title = await Summary.suggestTitle(meeting);
      Storage.saveMeeting({ ...meeting, title });
      await Storage.flush();
      this.toast(`AI title: ${title}`, 'success');
      this.navigate(this.currentRoute || 'meetings', { force: true });
    } catch (error) {
      this.toast(error.message || 'Could not suggest a meeting title.', 'error');
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  },

  _renderNotFound() {
    return `
      <div class="empty-state view-enter">
        <div class="empty-icon">🤔</div>
        <h3>Page Not Found</h3>
        <p>The page you're looking for doesn't exist.</p>
        <button class="btn btn-primary" style="margin-top: var(--space-4);" onclick="App.navigate('dashboard')">Go to Dashboard</button>
      </div>
    `;
  },

  _handleUpload() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.aac,.aiff,.amr,.asf,.flac,.mp3,.ogg,.wav,.webm,.m4a,.mp4,audio/*,video/mp4';
    input.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const extension = file.name.split('.').pop()?.toLowerCase() || '';
      const supported = ['aac', 'aiff', 'amr', 'asf', 'flac', 'mp3', 'ogg', 'wav', 'webm', 'm4a', 'mp4'];
      if (!supported.includes(extension)) {
        this.toast('Unsupported audio format. Please choose AAC, M4A, MP3, WAV, WebM, FLAC, OGG, AMR, ASF, AIFF, or MP4.', 'error');
        return;
      }

      const settings = Storage.getSettings();
      const startedAt = new Date().toISOString();

      const meeting = Storage.saveMeeting({
        title: file.name.replace(/\.[^.]+$/, ''),
        status: 'processing',
        participants: [],
        duration: 0,
        transcript: [],
        translations: [],
        language: settings.language,
        translationLanguage: settings.translationLanguage,
        sourceFilename: file.name
      });

      try {
        this._backgroundAudioTasks.set(meeting.id, { filename: file.name, phase: 'saving' });
        this._updateMeetingsCount();
        this._renderBackgroundTaskIndicator();
        await AudioStorage.save(meeting.id, file);
        meeting.audioId = meeting.id;
        Storage.saveMeeting(meeting);
        await Storage.flush();
        this._backgroundAudioTasks.set(meeting.id, { filename: file.name, phase: 'transcribing' });
        this._renderBackgroundTaskIndicator();
        this.toast(`${file.name} is processing in the background.`, 'info');
        this._refreshMeetingView(meeting.id);
        this._processUploadedRecording(meeting, startedAt, file.name);
      } catch (error) {
        this._backgroundAudioTasks.delete(meeting.id);
        meeting.status = 'failed';
        meeting.processingError = error.message || 'Could not save this audio file.';
        Storage.saveMeeting(meeting);
        await Storage.flush();
        this._renderBackgroundTaskIndicator();
        this.toast(`Upload failed: ${meeting.processingError}`, 'error');
        this._refreshMeetingView(meeting.id);
      }
    });
    input.click();
  },

  async _processUploadedRecording(meeting, startedAt, filename) {
    try {
      const response = await fetch('/api/import-transcription', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            meetingId: meeting.id,
            language: meeting.language,
            translationLanguage: meeting.translationLanguage
          })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error?.message || result.error || 'Could not start transcription.');

      const jobId = result.jobId;
      if (!jobId) throw new Error('Server did not return a job id.');

      this._backgroundAudioTasks.set(meeting.id, { filename, phase: 'transcribing', jobId });
      this._renderBackgroundTaskIndicator();

      // Start polling.
      this._pollJobStatus(meeting.id, jobId, filename);
    } catch (error) {
      this._backgroundAudioTasks.delete(meeting.id);
      const current = Storage.getMeeting(meeting.id) || meeting;
      current.status = 'failed';
      current.processingError = error.message || 'Could not start transcription.';
      Storage.saveMeeting(current);
      await Storage.flush();
      this._renderBackgroundTaskIndicator();
      this.toast(`Audio processing failed: ${current.processingError}`, 'error');
      this._refreshMeetingView(meeting.id);
    }
  },

  _pollJobStatus(meetingId, jobId, filename) {
    // Clear any existing poller for this meeting.
    if (this._activePollers.has(meetingId)) {
      clearTimeout(this._activePollers.get(meetingId));
    }

    let delay = 3000; // Start at 3s, backoff to 10s.
    const maxDelay = 10000;

    const poll = async () => {
      try {
        const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
        const job = await response.json().catch(() => ({}));

        if (response.status === 404) {
          // A missing job is not success. Reload the meeting first; if it is not
          // terminal, re-submit and let the server dedupe/recover the work.
          await this._reloadMeetingsFromServer();
          const current = Storage.getMeeting(meetingId);
          if (current?.status === 'completed' || current?.status === 'failed') {
            job.status = current.status;
            job.error = current.processingError ? { message: current.processingError } : null;
          } else if (current) {
            this._activePollers.delete(meetingId);
            this._processUploadedRecording(current, current.createdAt, filename || current.sourceFilename || current.title);
            return;
          } else {
            throw new Error('Transcription job and meeting were not found.');
          }
        } else if (!response.ok) {
          throw new Error(job.error || 'Could not check transcription status.');
        }

        if (job.status === 'completed') {
          // Reload meeting data from server — the server already persisted the transcript.
          await this._reloadMeetingsFromServer();
          this._backgroundAudioTasks.delete(meetingId);
          this._activePollers.delete(meetingId);
          this._renderBackgroundTaskIndicator();
          this.toast(`Transcription completed: ${filename || meetingId}`, 'success');
          this._refreshMeetingView(meetingId);
          return;
        }

        if (job.status === 'failed') {
          await this._reloadMeetingsFromServer();
          this._backgroundAudioTasks.delete(meetingId);
          this._activePollers.delete(meetingId);
          this._renderBackgroundTaskIndicator();
          const errMsg = job.error?.message || 'Transcription failed.';
          this.toast(`Audio processing failed: ${errMsg}`, 'error');
          this._refreshMeetingView(meetingId);
          return;
        }

        // Still processing — schedule next poll with backoff.
        delay = Math.min(delay * 1.5, maxDelay);
        this._activePollers.set(meetingId, setTimeout(poll, delay));
      } catch {
        // Network error — retry with backoff.
        delay = Math.min(delay * 2, maxDelay);
        this._activePollers.set(meetingId, setTimeout(poll, delay));
      }
    };

    this._activePollers.set(meetingId, setTimeout(poll, delay));
  },

  async _reloadMeetingsFromServer() {
    try {
      const response = await fetch('/api/data', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      if (Array.isArray(data.meetings)) {
        Storage._meetings = data.meetings;
      }
    } catch { /* best effort */ }
  },

  _resumeProcessingJobs() {
    const meetings = Storage.getAllMeetings();
    for (const meeting of meetings) {
      if (meeting.status !== 'processing') continue;
      // Already polling this meeting.
      if (this._activePollers.has(meeting.id)) continue;

      const jobId = meeting._activeJobId;
      if (jobId) {
        // Resume polling the existing job.
        this._backgroundAudioTasks.set(meeting.id, { filename: meeting.sourceFilename || meeting.title, phase: 'transcribing', jobId });
        this._renderBackgroundTaskIndicator();
        this._pollJobStatus(meeting.id, jobId, meeting.sourceFilename || meeting.title);
      } else {
        // No jobId — re-submit; server will dedupe if a job already exists.
        this._backgroundAudioTasks.set(meeting.id, { filename: meeting.sourceFilename || meeting.title, phase: 'transcribing' });
        this._renderBackgroundTaskIndicator();
        this._processUploadedRecording(meeting, meeting.createdAt, meeting.sourceFilename || meeting.title);
      }
    }
  }
};

/* ── Start App ── */
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await Storage.init();
    App.init();
  } catch (error) {
    console.error('Could not start MeetNote:', error);
    document.getElementById('page-title').textContent = 'Local server required';
    document.getElementById('main-content').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚠️</div>
        <h3>Could not open local storage</h3>
        <p>${Utils.escapeHtml(error.message)}</p>
        <p class="text-sm text-secondary">Run <code>npm start</code> in the project folder, then open <code>http://127.0.0.1:8765</code>.</p>
      </div>
    `;
  }
});
