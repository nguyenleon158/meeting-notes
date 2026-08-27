'use strict';

// Integration tests for the server-owned upload transcription job lifecycle.
// Spawns the real server against a throwaway storage dir.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');

const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let storageDir;

async function startServer(extraEnv = {}) {
  storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meetnote-jobs-test-'));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), MEETNOTE_STORAGE_DIR: storageDir, ...extraEnv },
    stdio: 'ignore'
  });
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise(res => setTimeout(res, 150));
  }
}

function stopServer() {
  if (server) { server.kill('SIGTERM'); server = null; }
}

async function cleanup() {
  stopServer();
  if (storageDir) await fs.rm(storageDir, { recursive: true, force: true }).catch(() => {});
  storageDir = null;
}

// Helper: create a meeting and store a tiny audio blob for it.
async function seedMeeting(meetingId) {
  const meetings = [{ id: meetingId, title: 'Test', status: 'processing', transcript: [], translations: [], language: 'en', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
  await fetch(`${BASE}/api/meetings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meetings) });
  // Store a tiny audio file.
  await fetch(`${BASE}/api/audio/${encodeURIComponent(meetingId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'audio/webm', 'X-Audio-Filename': 'test.webm' },
    body: Buffer.from('fake-audio-data')
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test('POST /api/import-transcription returns 201 immediately with a jobId', async () => {
  await startServer();
  try {
    const meetingId = 'test-immediate-' + Date.now();
    await seedMeeting(meetingId);

    const r = await fetch(`${BASE}/api/import-transcription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingId })
    });
    assert.strictEqual(r.status, 201, 'should return 201 Created');
    const body = await r.json();
    assert.ok(body.jobId, 'response must include a jobId');
    assert.strictEqual(body.status, 'processing');
  } finally {
    await cleanup();
  }
});

test('duplicate POST for same meetingId returns the same job (no second worker)', async () => {
  await startServer();
  try {
    const meetingId = 'test-dedupe-' + Date.now();
    await seedMeeting(meetingId);

    const submit = () => fetch(`${BASE}/api/import-transcription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingId, provider: 'invalid-test-provider' })
    });
    const [r1, r2] = await Promise.all([submit(), submit()]);
    assert.ok([200, 201].includes(r1.status), `first concurrent submit returned ${r1.status}`);
    assert.ok([200, 201].includes(r2.status), `second concurrent submit returned ${r2.status}`);
    const body1 = await r1.json();
    const body2 = await r2.json();

    assert.strictEqual(body1.jobId, body2.jobId, 'duplicate submit must return the same jobId');
  } finally {
    await cleanup();
  }
});

test('concurrent jobs for different meetings do not collide or lose records', async () => {
  await startServer();
  try {
    const suffix = Date.now();
    const ids = [`concurrent-a-${suffix}`, `concurrent-b-${suffix}`];
    const meetings = ids.map(id => ({
      id, title: id, status: 'processing', transcript: [], translations: [],
      language: 'en', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }));
    await fetch(`${BASE}/api/meetings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meetings)
    });
    await Promise.all(ids.map(id => fetch(`${BASE}/api/audio/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'audio/webm' }, body: Buffer.from('fake-audio')
    })));

    const responses = await Promise.all(ids.map(meetingId => fetch(`${BASE}/api/import-transcription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingId, provider: 'invalid-test-provider' })
    })));
    assert.deepStrictEqual(responses.map(response => response.status), [201, 201]);
    const submitted = await Promise.all(responses.map(response => response.json()));
    assert.notStrictEqual(submitted[0].jobId, submitted[1].jobId);

    const deadline = Date.now() + 3000;
    for (;;) {
      const statuses = await Promise.all(submitted.map(({ jobId }) =>
        fetch(`${BASE}/api/jobs/${jobId}`).then(response => response.json())));
      if (statuses.every(job => job.status === 'failed')) break;
      if (Date.now() > deadline) throw new Error('concurrent jobs did not reach a terminal state');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  } finally {
    await cleanup();
  }
});

test('GET /api/jobs/:id returns job status', async () => {
  await startServer();
  try {
    const meetingId = 'test-poll-' + Date.now();
    await seedMeeting(meetingId);

    const r1 = await fetch(`${BASE}/api/import-transcription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingId })
    });
    const { jobId } = await r1.json();

    const r2 = await fetch(`${BASE}/api/jobs/${encodeURIComponent(jobId)}`);
    assert.strictEqual(r2.status, 200);
    const job = await r2.json();
    assert.strictEqual(job.id, jobId);
    assert.ok(['processing', 'completed', 'failed'].includes(job.status), `status should be valid, got "${job.status}"`);
    assert.strictEqual(job.meetingId, meetingId);
  } finally {
    await cleanup();
  }
});

test('GET /api/jobs/:id does not report an unknown job as completed', async () => {
  await startServer();
  try {
    const r = await fetch(`${BASE}/api/jobs/job-nonexistent-12345`);
    assert.strictEqual(r.status, 404);
  } finally {
    await cleanup();
  }
});

test('stale processing snapshot cannot overwrite a terminal transcription result', async () => {
  await startServer();
  try {
    const meetingId = 'test-stale-' + Date.now();
    const completed = [{
      id: meetingId,
      title: 'Completed',
      status: 'completed',
      transcript: [{ text: 'server result', time: 0, speaker: 'Speaker' }],
      translations: [],
      duration: 12,
      processingError: '',
      sonioxUsage: { provider: 'soniox', startedAt: new Date().toISOString() },
      updatedAt: new Date().toISOString()
    }];
    await fetch(`${BASE}/api/meetings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(completed)
    });

    const stale = [{ ...completed[0], status: 'processing', transcript: [], duration: 0, updatedAt: new Date().toISOString() }];
    const write = await fetch(`${BASE}/api/meetings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stale)
    });
    assert.strictEqual(write.status, 200);
    const data = await (await fetch(`${BASE}/api/data`)).json();
    const meeting = data.meetings.find(item => item.id === meetingId);
    assert.strictEqual(meeting.status, 'completed');
    assert.strictEqual(meeting.transcript[0].text, 'server result');
    assert.strictEqual(meeting.duration, 12);
  } finally {
    await cleanup();
  }
});

test('startup recovery marks stuck processing jobs as failed', async () => {
  // 1. Start a server to seed storage, then stop it.
  await startServer();
  const meetingId = 'test-recovery-' + Date.now();
  await seedMeeting(meetingId);

  // Write a stuck "processing" job directly into jobs.json.
  const jobsFile = path.join(storageDir, 'jobs.json');
  const stuckJob = {
    id: 'job-stuck-test',
    meetingId,
    provider: '',
    model: '',
    language: 'en',
    translationLanguage: '',
    status: 'processing',
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await fs.writeFile(jobsFile, JSON.stringify([stuckJob]), 'utf8');
  stopServer();

  // 2. Restart the server — it should recover the stuck job on boot.
  const savedStorageDir = storageDir;
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), MEETNOTE_STORAGE_DIR: savedStorageDir },
    stdio: 'ignore'
  });
  storageDir = savedStorageDir;
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not restart');
    await new Promise(res => setTimeout(res, 150));
  }

  try {
    // Job should now be failed.
    const r = await fetch(`${BASE}/api/jobs/job-stuck-test`);
    const job = await r.json();
    assert.strictEqual(job.status, 'failed', 'stuck job must be recovered to failed');
    assert.ok(job.error, 'error info must be present');
    assert.ok(job.error.message.includes('restarted'), 'error message should mention restart');

    // Meeting should also be failed.
    const dataR = await fetch(`${BASE}/api/data`);
    const data = await dataR.json();
    const meeting = data.meetings.find(m => m.id === meetingId);
    assert.ok(meeting, 'meeting must still exist');
    assert.strictEqual(meeting.status, 'failed', 'meeting should be marked failed on recovery');
    assert.ok(meeting.processingError, 'meeting should have a processingError');
  } finally {
    await cleanup();
  }
});
