/* ============================================
   MeetNote AI — Export Module
   ============================================ */

const Export = {
  /**
   * Export meeting to Markdown format
   */
  toMarkdown(meeting) {
    const lines = [];

    lines.push(`# ${meeting.title}`);
    lines.push('');
    lines.push(`**Date:** ${Utils.formatDate(meeting.date)}`);
    lines.push(`**Duration:** ${Utils.formatDurationHuman(meeting.duration)}`);

    if (meeting.participants.length > 0) {
      lines.push(`**Participants:** ${meeting.participants.join(', ')}`);
    }
    lines.push('');

    // Summary
    if (meeting.summary) {
      lines.push('## Summary');
      lines.push('');
      lines.push(meeting.summary);
      lines.push('');
    }

    // Action Items
    if (meeting.actionItems && meeting.actionItems.length > 0) {
      lines.push('## Action Items');
      lines.push('');
      meeting.actionItems.forEach(item => {
        const check = item.done ? 'x' : ' ';
        const assignee = item.assignee ? ` — @${item.assignee}` : '';
        lines.push(`- [${check}] ${item.text}${assignee}`);
      });
      lines.push('');
    }

    // Transcript
    if (meeting.transcript && meeting.transcript.length > 0) {
      lines.push('## Transcript');
      lines.push('');
      meeting.transcript.forEach(seg => {
        const time = Utils.formatTimestamp(seg.time);
        const speaker = seg.speaker || 'Speaker';
        lines.push(`**[${time}] ${speaker}:** ${seg.text}`);
        lines.push('');
      });
    }

    // Notes
    if (meeting.notes) {
      lines.push('## Notes');
      lines.push('');
      lines.push(meeting.notes);
      lines.push('');
    }

    return lines.join('\n');
  },

  /**
   * Export meeting to plain text
   */
  toPlainText(meeting) {
    const lines = [];

    lines.push(meeting.title);
    lines.push('='.repeat(meeting.title.length));
    lines.push('');
    lines.push(`Date: ${Utils.formatDate(meeting.date)}`);
    lines.push(`Duration: ${Utils.formatDurationHuman(meeting.duration)}`);

    if (meeting.participants.length > 0) {
      lines.push(`Participants: ${meeting.participants.join(', ')}`);
    }
    lines.push('');

    if (meeting.summary) {
      lines.push('SUMMARY');
      lines.push('-'.repeat(40));
      lines.push(meeting.summary);
      lines.push('');
    }

    if (meeting.actionItems && meeting.actionItems.length > 0) {
      lines.push('ACTION ITEMS');
      lines.push('-'.repeat(40));
      meeting.actionItems.forEach(item => {
        const check = item.done ? '✓' : '○';
        lines.push(`${check} ${item.text}`);
      });
      lines.push('');
    }

    if (meeting.transcript && meeting.transcript.length > 0) {
      lines.push('TRANSCRIPT');
      lines.push('-'.repeat(40));
      meeting.transcript.forEach(seg => {
        const time = Utils.formatTimestamp(seg.time);
        const speaker = seg.speaker || 'Speaker';
        lines.push(`[${time}] ${speaker}: ${seg.text}`);
      });
      lines.push('');
    }

    return lines.join('\n');
  },

  /**
   * Download a file
   */
  download(content, filename, mimeType = 'text/plain') {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  /**
   * Download meeting as Markdown
   */
  downloadMarkdown(meeting) {
    const md = this.toMarkdown(meeting);
    const filename = `${meeting.title.replace(/[^a-zA-Z0-9]/g, '_')}_${Utils.formatDateShort(meeting.date)}.md`;
    this.download(md, filename, 'text/markdown');
  },

  /**
   * Download meeting as plain text
   */
  downloadText(meeting) {
    const txt = this.toPlainText(meeting);
    const filename = `${meeting.title.replace(/[^a-zA-Z0-9]/g, '_')}_${Utils.formatDateShort(meeting.date)}.txt`;
    this.download(txt, filename, 'text/plain');
  },

  /**
   * Copy transcript to clipboard
   */
  async copyTranscript(meeting) {
    const text = (meeting.transcript || [])
      .map(seg => {
        const time = Utils.formatTimestamp(seg.time);
        const speaker = seg.speaker || 'Speaker';
        return `[${time}] ${speaker}: ${seg.text}`;
      })
      .join('\n');

    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    }
  },

  /**
   * Copy summary to clipboard
   */
  async copySummary(meeting) {
    const text = meeting.summary || '';
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(ta);
      return copied;
    }
  },

  /**
   * Download all meetings as JSON backup
   */
  downloadBackup() {
    const json = Storage.exportAll();
    const date = new Date().toISOString().slice(0, 10);
    this.download(json, `meetnote_backup_${date}.json`, 'application/json');
  },

  /**
   * Import from JSON backup file
   */
  async importBackup(file) {
    if (file.size > 10 * 1024 * 1024) {
      return { success: false, error: 'Backup file must be smaller than 10 MB' };
    }

    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const result = Storage.importData(e.target.result);
        resolve(result);
      };
      reader.onerror = () => resolve({ success: false, error: 'Failed to read file' });
      reader.readAsText(file);
    });
  }
};
