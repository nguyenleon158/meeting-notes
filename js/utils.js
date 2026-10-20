/* ============================================
   MeetNote AI — Utility Functions
   ============================================ */

const Utils = {
  /**
   * Generate a UUID v4
   */
  uuid() {
    return crypto.randomUUID ? crypto.randomUUID() :
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
  },

  /**
   * Format duration in seconds to mm:ss or hh:mm:ss
   */
  formatDuration(seconds) {
    if (!seconds || seconds < 0) return '00:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const pad = n => String(n).padStart(2, '0');
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  },

  /**
   * Format duration in seconds to human-readable string
   */
  formatDurationHuman(seconds) {
    if (!seconds || seconds < 0) return '0 min';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m} min`;
  },

  /**
   * Format date to relative time (e.g., "2 hours ago", "Yesterday")
   */
  formatRelativeTime(dateStr) {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 60) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHour < 24) return `${diffHour}h ago`;
    if (diffDay === 1) return 'Yesterday';
    if (diffDay < 7) return `${diffDay}d ago`;
    return date.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
    });
  },

  /**
   * Format date to absolute string
   */
  formatDate(dateStr, options = {}) {
    const date = new Date(dateStr);
    const defaults = {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    };
    return date.toLocaleDateString('en-US', { ...defaults, ...options });
  },

  /**
   * Format date to short format (Jul 30, 2026)
   */
  formatDateShort(dateStr) {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    });
  },

  /**
   * Format time only (3:00 PM)
   */
  formatTime(dateStr) {
    return new Date(dateStr).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit'
    });
  },

  /**
   * Debounce a function
   */
  debounce(fn, delay = 300) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  },

  /**
   * Throttle a function
   */
  throttle(fn, limit = 100) {
    let inThrottle;
    return (...args) => {
      if (!inThrottle) {
        fn(...args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  },

  /**
   * Escape HTML to prevent XSS
   */
  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  /**
   * Highlight search term in text
   */
  highlightText(text, query) {
    if (!query) return Utils.escapeHtml(text);
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped})`, 'gi');
    return Utils.escapeHtml(text).replace(regex, '<mark>$1</mark>');
  },

  /**
   * Get initials from a name
   */
  getInitials(name) {
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  },

  /**
   * Generate a consistent color from a string (for avatars)
   */
  stringToColor(str) {
    const colors = [
      '#dc143c', '#1a4335', '#b8882d', '#002d31', '#d85b3f',
      '#4a605a', '#c81036', '#7b3f2f', '#9b6c22', '#2f6b59'
    ];
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  },

  /**
   * Format seconds to timestamp (00:15)
   */
  formatTimestamp(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  },

  /**
   * Simple plural helper
   */
  plural(count, singular, pluralForm) {
    return count === 1 ? singular : (pluralForm || singular + 's');
  },

  /**
   * Check if current date is in the same week
   */
  isThisWeek(dateStr) {
    const date = new Date(dateStr);
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    return date >= startOfWeek;
  },

  /**
   * Check if current date is today
   */
  isToday(dateStr) {
    const date = new Date(dateStr);
    const now = new Date();
    return date.toDateString() === now.toDateString();
  }
};
