'use strict';

// Integration tests for the live-recording streaming audio endpoints
// (/api/audio/:id/append and /finalize). Spawns the real server against a
// throwaway storage dir.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');

const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let storageDir;

before(async () => {
  storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meetnote-audio-test-'));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), MEETNOTE_STORAGE_DIR: storageDir },
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
});

after(async () => {
  if (server) server.kill('SIGTERM');
  if (storageDir) await fs.rm(storageDir, { recursive: true, force: true });
});

function appendUrl(id) { return `${BASE}/api/audio/${encodeURIComponent(id)}/append`; }
function finalizeUrl(id) { return `${BASE}/api/audio/${encodeURIComponent(id)}/finalize`; }
function audioUrl(id) { return `${BASE}/api/audio/${encodeURIComponent(id)}`; }

test('streamed append + finalize concatenates chunks into the final audio file', async () => {
  const id = 'stream-roundtrip-1';

  // First append resets, subsequent appends grow the part file.
  let r = await fetch(appendUrl(id), {
    method: 'PUT',
    headers: { 'Content-Type': 'audio/webm', 'X-Audio-Reset': '1' },
    body: Buffer.from('AAA')
  });
  assert.strictEqual(r.status, 200);

  r = await fetch(appendUrl(id), {
    method: 'PUT',
    headers: { 'Content-Type': 'audio/webm' },
    body: Buffer.from('BBB')
  });
  assert.strictEqual(r.status, 200);

  // Not finalized yet — the audio is not readable.
  assert.strictEqual((await fetch(audioUrl(id))).status, 404);

  r = await fetch(finalizeUrl(id), {
    method: 'POST',
    headers: { 'X-Audio-Content-Type': 'audio/webm' }
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).size, 6);

  const finalized = await fetch(audioUrl(id));
  assert.strictEqual(finalized.status, 200);
  assert.strictEqual(finalized.headers.get('content-type'), 'audio/webm');
  assert.strictEqual(await finalized.text(), 'AAABBB');
});

test('reset append discards a stale part file from an earlier attempt', async () => {
  const id = 'stream-reset-2';

  await fetch(appendUrl(id), {
    method: 'PUT',
    headers: { 'Content-Type': 'audio/webm', 'X-Audio-Reset': '1' },
    body: Buffer.from('STALE-CHUNK')
  });
  // A new recording for the same id starts over with a reset.
  await fetch(appendUrl(id), {
    method: 'PUT',
    headers: { 'Content-Type': 'audio/webm', 'X-Audio-Reset': '1' },
    body: Buffer.from('FRESH')
  });
  await fetch(finalizeUrl(id), { method: 'POST', headers: { 'X-Audio-Content-Type': 'audio/webm' } });

  const finalized = await fetch(audioUrl(id));
  assert.strictEqual(await finalized.text(), 'FRESH');
});

test('DELETE removes an in-progress part file', async () => {
  const id = 'stream-delete-3';

  await fetch(appendUrl(id), {
    method: 'PUT',
    headers: { 'Content-Type': 'audio/webm', 'X-Audio-Reset': '1' },
    body: Buffer.from('PARTIAL')
  });
  const del = await fetch(audioUrl(id), { method: 'DELETE' });
  assert.strictEqual(del.status, 200);

  // Finalize after delete finds no part file and reports nothing saved.
  const fin = await fetch(finalizeUrl(id), { method: 'POST', headers: { 'X-Audio-Content-Type': 'audio/webm' } });
  assert.strictEqual(fin.status, 200);
  assert.strictEqual((await fin.json()).size, 0);
  assert.strictEqual((await fetch(audioUrl(id))).status, 404);
});
