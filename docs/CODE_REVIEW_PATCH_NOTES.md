# MeetNote Code Review — Patch Handoff

Date: 2026-08-18

## Objective

Patch the issues below in priority order. Preserve the current local-only architecture and existing user data. Add focused regression tests where practical.

## 1. P1 — Protect localhost API from cross-site requests

### Problem

The HTTP server accepts state-changing requests without validating the request origin or requiring an app-specific token. `readJsonRequest()` also parses JSON regardless of `Content-Type`, so a hostile website can send a CORS-safelisted `text/plain` POST to the localhost server.

This was reproduced against a temporary storage directory:

```http
POST /api/clear HTTP/1.1
Origin: https://evil.example
Content-Type: text/plain

{"confirmation":"CLEAR_ALL_DATA"}
```

The server returned `200` and cleared the temporary data.

### Relevant code

- `server.js`: `requestHandler()`, `readJsonRequest()`, and all `/api/*` mutation routes.
- Highest-risk routes include `/api/clear`, provider test/generation routes, temporary-key routes, transcription, and audio mutations.

### Required fix

- Reject browser requests whose `Origin` is present and is not the app's allowed local origin.
- Validate `Host`/port consistently rather than trusting arbitrary host headers.
- Require `Content-Type: application/json` for JSON mutation endpoints.
- Add an app-specific random session token or equivalent protection for state-changing and cost-incurring API calls. Do not rely only on CORS headers.
- Keep normal requests from the packaged app and `http://127.0.0.1:8765` working.
- Do not expose API keys or the session token in logs.

### Acceptance criteria

- A request with `Origin: https://evil.example` cannot clear data, modify settings/meetings, mint temporary credentials, or start LLM/STT work.
- `POST /api/clear` with `Content-Type: text/plain` is rejected.
- Valid same-origin requests from the app continue to work.
- Add regression tests for allowed and rejected origins/content types.

## 2. P1 — Fix Google Speech-to-Text operation polling URL

### Problem

Google returns an operation resource name such as `operations/...`. The current code prepends another `/operations/` and URL-encodes the entire resource name:

```js
`${API_HOST}/operations/${encodeURIComponent(operationName)}`
```

This can produce an invalid path similar to:

```text
/v1/operations/operations%2F...
```

### Relevant code

- `server/stt/providers/google.js`, polling loop around the `operations.get` request.

### Required fix

- Build the polling URL from the operation resource name according to Google's `operations.get` path format.
- Validate the returned resource name before using it.
- Preserve API-key authentication and the existing timeout/error mapping.

### Acceptance criteria

- A mocked operation named `operations/test-operation` is polled using the correct URL.
- Polling handles `done: false`, `done: true`, and an operation-level error.
- Add a unit test that would fail with the current duplicated/encoded path.

## 3. P2 — Move uploaded-audio processing ownership to the server

### Problem

The UI describes uploaded transcription as a background task, but the browser owns the request and persists the returned transcript. If the user reloads or closes the app during processing, the provider job may finish and incur cost while the response/result is lost. The meeting can remain in `processing` indefinitely.

### Relevant code

- `js/app.js`: `_handleUpload()` and `_processUploadedRecording()`.
- `server.js`: `/api/import-transcription`.
- Startup recovery currently handles interrupted recordings but not abandoned `processing` meetings.

### Required fix

- Make the server own the transcription job lifecycle and persist the final meeting/transcript state atomically.
- Return a job ID or meeting processing status immediately instead of requiring the browser to stay open for the result.
- Add a status endpoint or reuse persisted meeting status so the UI can resume monitoring after reload.
- Persist terminal failure information and preserve the original uploaded audio.
- Recover or clearly mark abandoned/incomplete jobs after server restart.
- Avoid starting duplicate provider jobs for the same meeting.

### Acceptance criteria

- Start an upload transcription, reload/close the page, reopen it, and observe the eventual completed or failed state.
- A meeting does not remain in `processing` forever after a server restart.
- Repeated client polling does not create duplicate STT jobs.
- Successful output is persisted before the job is reported complete.

## 4. P2 — Prevent large audio files from exhausting Node memory

### Problem

The upload endpoint permits files up to 2 GB. `loadStoredAudio()` then calls `fsp.readFile()` before provider-specific limits are checked. Soniox allows 500 MB, Whisper 25 MB, and Google inline transcription about 10 MB. Reading the full file into a Buffer can freeze or terminate the Node process.

### Relevant code

- `server.js`: `MAX_AUDIO_BYTES`, `loadStoredAudio()`, `/api/import-transcription`.
- `server/stt/providers/soniox.js`
- `server/stt/providers/whisper.js`
- `server/stt/providers/google.js`
- `server/stt/providers/deepgram.js`

### Required fix

- Resolve the selected STT provider/model before loading audio bytes.
- Check `stat.size` against that provider's limit before allocating a Buffer.
- Prefer file streams/multipart streaming for providers that support them.
- For providers that require an in-memory/base64 payload, enforce a conservative hard limit before reading.
- Return the existing typed `STT_AUDIO_TOO_LARGE` error shape.

### Acceptance criteria

- Oversized Whisper/Google/Soniox inputs are rejected before `fsp.readFile()` runs.
- A large rejected upload does not materially increase server memory usage.
- Supported files still transcribe successfully.
- Provider limits are defined in one discoverable place or exposed through a provider capability method rather than duplicated inconsistently.

## 5. P3 — Harden malformed URL handling

### Problem

An invalid percent-encoded path, for example `/%E0%A4%A`, causes `decodeURIComponent()` to throw and currently returns `500 URI malformed`.

### Relevant code

- `server.js`: `serveStatic()` and the top-level error mapping.

### Required fix

- Catch URI decoding errors and return `400 Bad Request` without a stack trace or noisy server error.

### Acceptance criteria

- Malformed URL encoding returns `400`.
- The server remains healthy afterward.

## 6. Test and verification baseline

The project currently has only a `start` script and no automated test/lint commands. Add a minimal test harness suitable for the plain CommonJS/Node architecture. Prefer Node's built-in test runner unless another dependency is necessary.

At minimum, cover:

- Cross-origin and wrong-content-type rejection.
- Same-origin API success.
- Google operation polling URL construction.
- Provider-specific audio size rejection before reading the file.
- Background job persistence/recovery across a simulated client disconnect or server restart.
- Malformed URL returns `400`.

Run these existing checks as well:

```sh
for f in server.js js/*.js server/llm/*.js server/llm/providers/*.js server/stt/*.js server/stt/providers/*.js; do
  node --check "$f" || exit 1
done

plutil -lint macos/Info.plist
sh -n macos/build-dmg.sh
```

## Current verification notes

- All JavaScript files passed `node --check` on 2026-08-18.
- `macos/Info.plist` passed `plutil -lint`.
- `macos/build-dmg.sh` passed shell syntax checking.
- Current `storage/meetings.json` and `storage/settings.json` parsed successfully as JSON.
- No source files were changed as part of the review other than this handoff document.

## Suggested implementation order

1. Localhost API request authentication/CSRF protection.
2. Google STT operation polling URL.
3. Server-owned transcription job lifecycle and persistence.
4. Provider-aware audio limits and streaming.
5. Malformed URL handling.
6. Regression tests and final packaged-app smoke test.
