# Contributing to MeetNote

Thank you for helping improve MeetNote.

## Development workflow

1. Fork the repository and create a focused branch.
2. Run the app with `npm start`.
3. Add or update tests for behavior changes.
4. Run `npm test` before opening a pull request.
5. Describe the problem, the solution, and how you verified it.

Keep pull requests small when practical. Preserve the local-first data model and
make any external network transfer clear in the UI and documentation.

## Data and secrets

Never commit or attach:

- recordings, transcripts, summaries, meeting metadata, or backups;
- provider API keys, session tokens, environment files, or signing material;
- diagnostic logs or bug-report JSON containing personal information; or
- generated installers, embedded runtimes, or build directories.

Use synthetic meeting content in tests and screenshots. If a secret is exposed,
revoke or rotate it before attempting to remove it from Git history.

## User-facing changes

Update `HUONG-DAN-SU-DUNG.md` when a change affects setup, storage, privacy,
provider behavior, or the visible workflow. Keep accessibility, Windows, and
macOS behavior in mind.
