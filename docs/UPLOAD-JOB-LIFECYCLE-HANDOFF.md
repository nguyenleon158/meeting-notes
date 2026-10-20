# Handoff — Code-review patch status + Upload Job Lifecycle (#3 full)

Date: 2026-08-19
Audience: the next coding agent. This doc is self-contained; act from it without the originating chat.

Companion doc: `docs/CODE_REVIEW_PATCH_NOTES.md` (the original review with all 6 findings).

---

## 1. What is already DONE (verified)

All items below are implemented and covered by `npm test` (6 tests, all passing on 2026-08-19).
Run to confirm before starting:

```sh
npm test
for f in server.js js/*.js server/llm/*.js server/llm/providers/*.js server/stt/*.js server/stt/providers/*.js; do node --check "$f" || exit 1; done
```

| # | Item | Status | Where |
|---|------|--------|-------|
| 1 | Localhost API CSRF/origin guard | DONE | `server.js`: `isTrustedApiRequest()` (Host + Origin allowlist) enforced in `requestHandler()` for every non-GET `/api/*`; `readJsonRequest()` now requires `Content-Type: application/json` (else 415). Allowlist = `ALLOWED_HOSTS`/`ALLOWED_ORIGINS` for `127.0.0.1:PORT` and `localhost:PORT`. |
| 2 | Google STT polling URL | DONE | `server/stt/providers/google.js`: `operationId = operationName.split('/').pop()`, poll `${API_HOST}/operations/${encodeURIComponent(operationId)}`. |
| 4 | Provider-aware audio size limit before read | DONE | Each STT adapter exposes `maxUploadBytes`. `server/stt/index.js` `transcribe()` now takes `{ audioMeta, loadAudio }`, checks `audioMeta.size` vs `adapter.maxUploadBytes` and throws `STT_AUDIO_TOO_LARGE` **before** calling `loadAudio()`. `server.js` `openStoredAudio()` returns `{ meta, load }` (stat + lazy loader); route passes them. |
| 5 | Malformed URL → 400 | DONE | `server.js` `serveStatic()` wraps `decodeURIComponent` in try/catch → 400. |
| 3 | Abandoned `processing` recovery | **PARTIAL (light only)** | `js/storage.js` `_recoverInterruptedRecordings()` now also flips `status: 'processing'` → `'failed'` on app load. This only prevents a *permanent* stuck state; it does NOT make the job survive a reload. Full fix below. |
| 6 | Test harness | DONE | `test/http.test.js` (origin/content-type/malformed/same-origin) + `test/stt.test.js` (Google URL, oversized-audio-before-read). `package.json` `test` = `node --test test/*.test.js`. |

**Remaining review work = only #3 full.**

---

## 2. #3 FULL — Server-owned upload transcription job lifecycle

### Problem (today)
Uploaded-file transcription is **browser-owned**: `js/app.js` `_processUploadedRecording()` calls `POST /api/import-transcription` and awaits the full result, then the browser persists the transcript. If the user reloads/closes the app or loses network mid-job:
- the provider job may still finish and **incur cost**, but the result is lost;
- the meeting is stuck `processing` (light fix only downgrades it to `failed` on next load → user must re-run and pay again).

### Goal
The **server** owns the job: it runs to completion regardless of the browser, persists the final transcript/status atomically, exposes status for the UI to resume after reload, dedupes duplicate jobs, and recovers on restart.

### Current code to change
- `server.js`: `/api/import-transcription` route; `openStoredAudio()`; `ensureStorage()`/startup; the `stt` service instance.
- `server/stt/index.js`: `transcribe()` (reuse as the worker's core call — already takes `{ providerId, modelId, audioMeta, loadAudio, language, translationLanguage }` and returns the normalized `{ transcript, translations, duration, model, provider }`).
- `js/app.js`: `_handleUpload()`, `_processUploadedRecording()` (lines ~2440–2500); the meeting-list "processing" badge already exists.
- `js/storage.js`: `_recoverInterruptedRecordings()` (the light `processing`→`failed` flip must be REMOVED/relaxed once the server owns recovery, otherwise it will fight the server — see Edge cases).

### Design (KISS, file-based, matches the app's local-only architecture)

**Job store:** a new `storage/jobs.json` (array), managed only by the server, written via the existing `atomicWriteJson()`. One record per transcription job:

```json
{
  "id": "job-<uuid>",
  "meetingId": "<id>",
  "provider": "deepgram",
  "model": "nova-3",
  "language": "auto",
  "translationLanguage": "",
  "status": "processing",          // queued | processing | completed | failed
  "error": null,                    // { code, message } when failed
  "result": null,                   // normalized STT result when completed (or store on the meeting only)
  "createdAt": "ISO",
  "updatedAt": "ISO"
}
```

Keep an **in-memory map** of running jobs (Promise handles) for dedupe within a process; the file is the source of truth across restarts.

**Endpoints:**
- `POST /api/import-transcription` → change contract: create (or return existing) job for `meetingId`, kick off the worker, respond **immediately** `201 { jobId, status }`. Do NOT await the transcription.
  - Dedupe: if an active job already exists for that `meetingId`, return that job instead of starting a second (no double cost).
- `GET /api/jobs/:jobId` → `{ id, meetingId, status, error }` (never return secrets).
  - Alternative that avoids a new endpoint: fold job status into `GET /api/data` (e.g. add `jobs` array), so the UI already polling `/api/data` sees it. Pick one; a dedicated endpoint is cleaner for polling.

**Worker (server):**
1. On job start: write job `processing`; open audio via `openStoredAudio()` (lazy) — size guard already runs inside `stt.transcribe`.
2. `await stt.transcribe(...)`.
3. On success: **atomically** persist the transcript onto the meeting in `storage/meetings.json` (mirror what `_processUploadedRecording` writes today: `transcript`, `translations`, `duration`, `status:'completed'`, provider/usage metadata) AND set job `completed`. Persist the meeting write BEFORE marking the job complete (acceptance: "output persisted before job reported complete").
4. On failure: job `failed` + `error`; set meeting `status:'failed'`, `processingError`; keep the original audio.

**Note on meeting writes:** meetings are currently owned by the client (`PUT /api/meetings` replaces the whole array). The server writing directly into `meetings.json` introduces a **two-writer** situation (client autosave vs server worker). Resolve this deliberately — options:
  - (a) Server merges: read `meetings.json`, update only the target meeting's transcription fields, atomic write. Client autosave still last-write-wins on other fields → risk of clobber. Mitigate by having the client re-fetch `/api/data` after a job completes (it will, via polling) and by the client NOT writing the meeting while a job is active.
  - (b) Server writes the result to the **job record only**; the client, on seeing `completed`, GETs the job result and persists it onto the meeting through the normal client path. This keeps a single meeting-writer (client) and is simpler/safer, at the cost of "result only lands when the browser next opens". Given the whole point is browser-independence, prefer (a) but guard the merge.
  → **Recommended: (a) with a targeted merge helper** on the server, and make the client treat server-updated transcription fields as authoritative.

**Client (`js/app.js`):**
- `_processUploadedRecording()` → POST, get `{ jobId }`, set meeting `processing`, then **poll** `GET /api/jobs/:jobId` (e.g. every 2–3s, with backoff/cap) until terminal, then refresh from `/api/data` and re-render. No more long-await.
- On app load, for any meeting still `processing` with a known job, resume polling instead of marking failed.

**Startup recovery (server):**
- On boot, scan `jobs.json` for `processing`/`queued` jobs. A job cannot resume a provider call it lost, so mark such jobs `failed` with a clear error and set the meeting `failed` (preserve audio). This replaces the client-side light flip.
- Then **remove/relax** `js/storage.js` `_recoverInterruptedRecordings()`'s `processing`→`failed` branch so client and server don't both mutate it. (Keep the `recording`→`interrupted` branch — that is still client-only and correct.)

### Edge cases / must-handle
- Duplicate submit for same meeting → one job (dedupe by `meetingId`, in-memory + jobs.json scan).
- Server restart mid-job → no permanent `processing`; job marked failed, audio preserved, user can retry.
- Provider size/auth errors → surface as the meeting's `processingError` (typed STT error message).
- Never log API keys / tokens / raw provider responses.
- Concurrency: the STT service already serializes per provider (`enqueue`); keep that.

### Acceptance criteria (from the review)
- Start an upload, reload/close, reopen → eventually see `completed` or `failed` (not stuck).
- A meeting never stays `processing` forever after a server restart.
- Repeated client polling / re-submit does not create duplicate provider jobs.
- Successful output is persisted before the job is reported complete.

### Tests to add (`test/`)
- Job created returns immediately (status `processing`), not blocked on transcription (mock a slow `stt.transcribe`).
- Duplicate `POST /api/import-transcription` for the same meeting returns the same job (no second worker run).
- Worker success persists meeting transcript before job flips `completed`.
- Simulated restart: a `processing` job in `jobs.json` is recovered to `failed` on boot, audio still present.
- Mock the provider (inject a fake `stt` or stub `fetch`) so no network/keys are needed — mirror the style in `test/stt.test.js`.

---

## 3. Verification commands

```sh
npm test
for f in server.js js/*.js server/llm/*.js server/llm/providers/*.js server/stt/*.js server/stt/providers/*.js; do node --check "$f" || exit 1; done
plutil -lint macos/Info.plist
sh -n macos/build-dmg.sh
```

## 4. Guardrails for the successor
- Preserve local-only architecture + existing user data; use `atomicWriteJson()` for all persistence.
- Do not weaken the #1 origin/Host/Content-Type guard when adding `/api/jobs/*` (the new POST/GET must respect it; GET is fine unguarded, POST must stay guarded).
- Keep the BYOK model: no secrets to the browser, keys stay in Keychain/env.
- `Codex` LLM provider depends on a local ChatGPT app + login; unrelated to STT jobs but note it is not resale-friendly (separate decision).

## 5. Open questions for the owner
- Meeting-write ownership: adopt server-merge (a) or client-persists-on-complete (b)? (Recommended: a.)
- Poll via new `GET /api/jobs/:id` or fold into `GET /api/data`?
- Retention: keep completed job records (history) or prune after the meeting is updated?
