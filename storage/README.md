# Local application data

This folder is managed by `server.js`. Its generated contents are intentionally
excluded from Git because they can contain private meeting data. Only this
README should be committed.

- `meetings.json`: meeting metadata, transcripts, summaries, notes, and actions.
- `settings.json`: non-secret application settings.
- `audio/`: recorded audio files and their metadata.
- `transcripts/`: per-meeting original and translated transcript snapshots.
- `summaries/`: structured Codex/ChatGPT summary snapshots.

Provider API keys are stored in macOS Keychain or protected with Windows DPAPI,
not in this folder.
Per-meeting Soniox usage estimates are stored with meeting metadata in
`meetings.json` and displayed in the app's Usage Log.

Do not edit these files while the application is running.

Before sharing a copy of the project, verify that no recordings, transcripts,
summaries, logs, settings, or exported bug reports have been added manually.
