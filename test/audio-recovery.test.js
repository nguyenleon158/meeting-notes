'use strict';

// Verifies startup recovery of orphan `.part` files: a recording whose audio
// was streamed to disk but never finalized (the app crashed mid-recording) is
// promoted to a playable file and linked back to its meeting on next boot.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');

const PORT = 8796;
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let storageDir;

const audioKey = id => crypto.createHash('sha256').update(id).digest('hex');

async function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), MEETNOTE_STORAGE_DIR: storageDir },
    stdio: 'ignore'
  });
  const deadline = Date.now() + 10000;
  for (;;) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise(res => setTimeout(res, 150));
  }
}

before(async () => {
  storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meetnote-recover-test-'));
  const audioDir = path.join(storageDir, 'audio');
  await fs.mkdir(audioDir, { recursive: true });

  // Two interrupted recordings: one with an orphan part to recover, and one
  // stale part whose recording already finalized (must not clobber good audio).
  const recoverId = 'crashed-meeting-1';
  const staleId = 'completed-meeting-2';
  await fs.writeFile(path.join(storageDir, 'meetings.json'), JSON.stringify([
    { id: recoverId, title: 'Crashed', status: 'recording', audioId: null, transcript: [], translations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    { id: staleId, title: 'Completed', status: 'completed', audioId: staleId, transcript: [], translations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  ]));

  // Orphan part + its provisional metadata (as a reset append would have written).
  const rKey = audioKey(recoverId);
  await fs.writeFile(path.join(audioDir, `${rKey}.audio.part`), Buffer.from('RECOVERED-AUDIO'));
  await fs.writeFile(path.join(audioDir, `${rKey}.json`), JSON.stringify({ id: recoverId, mimeType: 'audio/webm', size: 0, partial: true }));

  // Stale part alongside an already-finalized recording.
  const sKey = audioKey(staleId);
  await fs.writeFile(path.join(audioDir, `${sKey}.audio`), Buffer.from('GOOD-FINAL-AUDIO'));
  await fs.writeFile(path.join(audioDir, `${sKey}.json`), JSON.stringify({ id: staleId, mimeType: 'audio/webm', size: 16 }));
  await fs.writeFile(path.join(audioDir, `${sKey}.audio.part`), Buffer.from('STALE'));

  await startServer();
});

after(async () => {
  if (server) server.kill('SIGTERM');
  if (storageDir) await fs.rm(storageDir, { recursive: true, force: true });
});

test('orphan part is finalized and served after restart', async () => {
  const r = await fetch(`${BASE}/api/audio/${encodeURIComponent('crashed-meeting-1')}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(await r.text(), 'RECOVERED-AUDIO');

  // The part file is gone.
  const audioDir = path.join(storageDir, 'audio');
  const key = audioKey('crashed-meeting-1');
  await assert.rejects(fs.stat(path.join(audioDir, `${key}.audio.part`)));
});

test('recovered recording is linked back to its meeting', async () => {
  const data = await (await fetch(`${BASE}/api/data`)).json();
  const meeting = data.meetings.find(m => m.id === 'crashed-meeting-1');
  assert.strictEqual(meeting.audioId, 'crashed-meeting-1');
});

test('stale part does not clobber an already-finalized recording', async () => {
  const r = await fetch(`${BASE}/api/audio/${encodeURIComponent('completed-meeting-2')}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(await r.text(), 'GOOD-FINAL-AUDIO');

  const audioDir = path.join(storageDir, 'audio');
  const key = audioKey('completed-meeting-2');
  await assert.rejects(fs.stat(path.join(audioDir, `${key}.audio.part`)), 'stale part should be removed');
});
