'use strict';

// HTTP-level regression tests for the localhost API guard and URL handling.
// Spawns the real server against a throwaway storage dir.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let storageDir;

before(async () => {
  storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meetnote-test-'));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), MEETNOTE_STORAGE_DIR: storageDir },
    stdio: 'ignore'
  });
  // Wait for the server to accept connections.
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise(res => setTimeout(res, 150));
  }
});

after(async () => {
  if (server) server.kill('SIGTERM');
  if (storageDir) await fs.rm(storageDir, { recursive: true, force: true });
});

test('same-origin JSON request succeeds (no Origin header, loopback Host)', async () => {
  const r = await fetch(`${BASE}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ marker: 'kept', theme: 'light' })
  });
  assert.strictEqual(r.status, 200);
});

test('cross-site Origin is rejected and cannot clear data', async () => {
  const r = await fetch(`${BASE}/api/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ confirmation: 'CLEAR_ALL_DATA' })
  });
  assert.strictEqual(r.status, 403);
  // The marker set above must still be there — nothing was cleared.
  const data = await (await fetch(`${BASE}/api/data`)).json();
  assert.strictEqual(data.settings.marker, 'kept');
});

test('DNS-rebinding Host cannot read meetings or settings', async () => {
  const r = await fetch(`${BASE}/api/data`, {
    headers: { Host: 'evil.example', Origin: 'http://evil.example' }
  });
  assert.strictEqual(r.status, 403);
});

test('wrong Content-Type (text/plain) is rejected for JSON endpoints', async () => {
  const r = await fetch(`${BASE}/api/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ confirmation: 'CLEAR_ALL_DATA' })
  });
  assert.strictEqual(r.status, 415);
  const data = await (await fetch(`${BASE}/api/data`)).json();
  assert.strictEqual(data.settings.marker, 'kept');
});

test('malformed percent-encoding returns 400, not 500', async () => {
  const r = await fetch(`${BASE}/%E0%A4%A`);
  assert.strictEqual(r.status, 400);
  // Server stays healthy afterwards.
  assert.ok((await fetch(`${BASE}/api/health`)).ok);
});

test('client diagnostics are recorded with credential fields redacted', async () => {
  const write = await fetch(`${BASE}/api/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      level: 'error',
      event: 'test_failure',
      message: 'Something failed',
      context: { apiKey: 'must-not-leak', route: 'settings' }
    })
  });
  assert.strictEqual(write.status, 202);

  const data = await (await fetch(`${BASE}/api/logs`)).json();
  const entry = data.logs.find(item => item.event === 'client.test_failure');
  assert.ok(entry, 'client log entry should be available');
  assert.strictEqual(entry.details.context.apiKey, '[redacted]');
  assert.strictEqual(entry.details.context.route, 'settings');
});

test('bug report is saved and excludes private meeting content', async () => {
  const privateTitle = 'PRIVATE-TITLE-MUST-NOT-LEAK';
  const privateTranscript = 'PRIVATE-TRANSCRIPT-MUST-NOT-LEAK';
  await fetch(`${BASE}/api/meetings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{
      id: 'privacy-test-meeting',
      title: privateTitle,
      status: 'completed',
      transcript: [{ text: privateTranscript, time: 0 }],
      notes: 'PRIVATE-NOTES-MUST-NOT-LEAK'
    }])
  });

  const response = await fetch(`${BASE}/api/bug-reports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary: 'Recording issue', description: 'Stopped unexpectedly', contact: 'user@example.com' })
  });
  assert.strictEqual(response.status, 201);
  const data = await response.json();
  assert.ok(data.filename.endsWith('.json'));
  assert.strictEqual(data.report.diagnostics.meetingCount, 1);
  assert.strictEqual(data.report.userReport.summary, 'Recording issue');

  const serialized = JSON.stringify(data.report);
  assert.ok(!serialized.includes(privateTitle));
  assert.ok(!serialized.includes(privateTranscript));
  assert.ok(!serialized.includes('PRIVATE-NOTES'));

  const saved = JSON.parse(await fs.readFile(path.join(storageDir, 'bug-reports', data.filename), 'utf8'));
  assert.strictEqual(saved.id, data.report.id);
});

test('bug report requires a summary and description', async () => {
  const response = await fetch(`${BASE}/api/bug-reports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary: '' })
  });
  assert.strictEqual(response.status, 400);
});
