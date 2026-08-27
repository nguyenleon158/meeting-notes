# MeetNote AI

MeetNote is a local-first meeting recorder and AI note-taking app for macOS and
Windows. It records meetings, creates live or uploaded-file transcripts, and
turns transcripts into summaries, decisions, and action items.

## Highlights

- Live recording with optional system audio capture
- Speech-to-text through Soniox, Deepgram, OpenAI Whisper, or Google Speech-to-Text
- Live translation with Soniox
- AI summaries and title suggestions through Codex, DeepSeek, or Google Gemini
- Local meeting library with search, backup, export, and multi-select deletion
- Rotating diagnostic logs and downloadable JSON bug reports
- Provider keys protected by macOS Keychain or Windows DPAPI

## Privacy model

Meeting data and recordings are stored on the user's device. MeetNote is
local-first, but it is not an offline-only app:

- Audio is sent to the speech-to-text provider selected by the user.
- Transcript text is sent to the selected AI provider when the user requests a
  summary or title.
- Bug reports are created locally and downloaded as JSON. MeetNote does not send
  them automatically.

Do not use external AI providers for sensitive material unless their handling of
the data complies with your organization’s policies.

## Run from source

Node.js 18 or newer is required.

```bash
npm start
```

Open `http://127.0.0.1:8765`. Keep the terminal running while using MeetNote and
stop it with `Ctrl+C`. Do not open `index.html` directly; the local server is
required for file storage and provider integrations.

The source checkout stores generated data under `storage/`. Packaged builds use:

| Platform | Meeting data | Logs |
| --- | --- | --- |
| macOS | `~/Library/Application Support/MeetNote/` | `~/Library/Logs/MeetNote/server.log` |
| Windows | `%APPDATA%\\MeetNote` | `%LOCALAPPDATA%\\MeetNote\\Logs\\server.log` |

## Configure integrations

Open **Settings** in MeetNote and choose the transcription and meeting-notes
providers. API-based providers require their own keys.

Codex uses an existing local Codex/ChatGPT login instead of an OpenAI Platform
API key:

```bash
codex login
codex login status
```

For complete setup and usage instructions, see
[HUONG-DAN-SU-DUNG.md](HUONG-DAN-SU-DUNG.md).

## Test

```bash
npm test
```

## Build installers

Build the Apple Silicon macOS app and DMG:

```bash
./macos/build-dmg.sh
```

Build the portable Windows x64 executable from macOS:

```bash
./windows/build-exe.sh
```

Generated installers and embedded runtimes are intentionally excluded from Git.
Publish signed binaries through GitHub Releases together with SHA-256 checksums.

## Bug reports

In MeetNote, open **Settings → Support & Diagnostics → Report a Bug**, describe
the issue, and choose **Create & Download Report**. Send the downloaded JSON file
to the maintainer through the support channel you were given.

The report is designed to exclude recordings, transcripts, notes, summaries,
meeting titles, action items, and API keys. Review the JSON before sharing it if
the description or logs could still identify you or your organization.

For public bug reports, use the GitHub issue template and never attach private
meeting data. For security issues, follow [SECURITY.md](SECURITY.md).

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening
a pull request.

## License

MeetNote is available under the [MIT License](LICENSE).

Built by [Nguyen Leon](https://nguyenleon.com).
