const http = require('http');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const { spawn } = require('child_process');
const { createLlmService, DEFAULT_PROVIDER } = require('./server/llm');
const { createSttService, DEFAULT_PROVIDER: DEFAULT_STT_PROVIDER } = require('./server/stt');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 8765;
const ROOT_DIR = __dirname;
const STORAGE_DIR = path.resolve(process.env.MEETNOTE_STORAGE_DIR || path.join(ROOT_DIR, 'storage'));
const AUDIO_DIR = path.join(STORAGE_DIR, 'audio');
const TRANSCRIPTS_DIR = path.join(STORAGE_DIR, 'transcripts');
const SUMMARIES_DIR = path.join(STORAGE_DIR, 'summaries');
const SECRETS_DIR = path.join(STORAGE_DIR, 'secrets');
const MEETINGS_FILE = path.join(STORAGE_DIR, 'meetings.json');
const SETTINGS_FILE = path.join(STORAGE_DIR, 'settings.json');
const JOBS_FILE = path.join(STORAGE_DIR, 'jobs.json');
const LOGS_DIR = path.join(STORAGE_DIR, 'logs');
const APP_LOG_FILE = path.join(LOGS_DIR, 'meetnote.log');
const BUG_REPORTS_DIR = path.join(STORAGE_DIR, 'bug-reports');
const APP_VERSION = require('./package.json').version;
const SUMMARY_SCHEMA_FILE = path.join(ROOT_DIR, 'schemas', 'meeting-summary.schema.json');
const TITLE_SCHEMA_FILE = path.join(ROOT_DIR, 'schemas', 'meeting-title.schema.json');
const MAX_JSON_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CODEX_OUTPUT_BYTES = 4 * 1024 * 1024;
const CODEX_TIMEOUT_MS = 3 * 60 * 1000;
const LLM_API_TIMEOUT_MS = 2 * 60 * 1000;
const KEYCHAIN_SERVICE = 'meetnote-local';
const SONIOX_KEYCHAIN_ACCOUNT = 'soniox-api-key';
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_CLIENT_LOG_MESSAGE = 4000;

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};

async function ensureStorage() {
  await Promise.all([
    fsp.mkdir(AUDIO_DIR, { recursive: true }),
    fsp.mkdir(TRANSCRIPTS_DIR, { recursive: true }),
    fsp.mkdir(SUMMARIES_DIR, { recursive: true }),
    fsp.mkdir(SECRETS_DIR, { recursive: true }),
    fsp.mkdir(LOGS_DIR, { recursive: true }),
    fsp.mkdir(BUG_REPORTS_DIR, { recursive: true })
  ]);
  await ensureJsonFile(MEETINGS_FILE, []);
  await ensureJsonFile(SETTINGS_FILE, {});
  await ensureJsonFile(JOBS_FILE, []);
  await migrateLlmSettings();
}

// Default any pre-existing install to today's providers so upgrades keep working.
async function migrateLlmSettings() {
  const settings = await readJson(SETTINGS_FILE, {});
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return;
  let changed = false;
  if (typeof settings.llmProvider !== 'string' || !settings.llmProvider) {
    settings.llmProvider = DEFAULT_PROVIDER;
    if (!settings.llmModels || typeof settings.llmModels !== 'object') settings.llmModels = { codex: 'default' };
    changed = true;
  }
  if (typeof settings.sttProvider !== 'string' || !settings.sttProvider) {
    settings.sttProvider = DEFAULT_STT_PROVIDER;
    if (!settings.sttModels || typeof settings.sttModels !== 'object') settings.sttModels = {};
    changed = true;
  }
  if (changed) await atomicWriteJson(SETTINGS_FILE, settings);
}

async function ensureJsonFile(filePath, defaultValue) {
  try {
    await fsp.access(filePath);
  } catch {
    await atomicWriteJson(filePath, defaultValue);
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function atomicWriteJson(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(tempPath, filePath);
}

function sanitizeDiagnosticValue(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (typeof value === 'string') return value.slice(0, MAX_CLIENT_LOG_MESSAGE);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 30).map(item => sanitizeDiagnosticValue(item, depth + 1));
  if (!value || typeof value !== 'object') return String(value || '');

  const sanitized = {};
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    if (/api.?key|secret|token|authorization|password/i.test(key)) {
      sanitized[key] = '[redacted]';
    } else {
      sanitized[key] = sanitizeDiagnosticValue(item, depth + 1);
    }
  }
  return sanitized;
}

let logWriteQueue = Promise.resolve();

function logEvent(level, event, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
    event: String(event || 'app.event').slice(0, 120),
    details: sanitizeDiagnosticValue(details)
  };

  logWriteQueue = logWriteQueue.catch(() => {}).then(async () => {
    await fsp.mkdir(LOGS_DIR, { recursive: true });
    const stat = await fsp.stat(APP_LOG_FILE).catch(() => null);
    if (stat && stat.size >= MAX_LOG_BYTES) {
      await fsp.rm(`${APP_LOG_FILE}.1`, { force: true });
      await fsp.rename(APP_LOG_FILE, `${APP_LOG_FILE}.1`);
    }
    await fsp.appendFile(APP_LOG_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
  });
  logWriteQueue.catch(error => console.error('Could not write diagnostic log:', error));
  return logWriteQueue;
}

async function readRecentLogEntries(limit = 200) {
  const text = await fsp.readFile(APP_LOG_FILE, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return text.trim().split('\n').filter(Boolean).slice(-limit).map(line => {
    try { return JSON.parse(line); } catch { return { timestamp: '', level: 'warn', event: 'log.parse_failed' }; }
  });
}

async function summarizeAudioStorage() {
  const files = await fsp.readdir(AUDIO_DIR, { withFileTypes: true }).catch(() => []);
  const audioFiles = files.filter(entry => entry.isFile() && entry.name.endsWith('.audio'));
  let totalBytes = 0;
  for (const entry of audioFiles) {
    const stat = await fsp.stat(path.join(AUDIO_DIR, entry.name)).catch(() => null);
    totalBytes += stat?.size || 0;
  }
  return { fileCount: audioFiles.length, totalBytes };
}

function safeSettingsForDiagnostics(settings) {
  const allowed = [
    'language', 'translationLanguage', 'theme', 'uiLanguage', 'autoSave',
    'showTimestamps', 'llmProvider', 'llmModels', 'sttProvider', 'sttModels'
  ];
  return Object.fromEntries(allowed.filter(key => settings[key] !== undefined).map(key => [key, settings[key]]));
}

async function createBugReport(input) {
  const [meetings, settings, audio, logs] = await Promise.all([
    readJson(MEETINGS_FILE, []),
    readJson(SETTINGS_FILE, {}),
    summarizeAudioStorage(),
    readRecentLogEntries()
  ]);
  const statusCounts = {};
  for (const meeting of meetings) {
    const status = String(meeting?.status || 'unknown');
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const report = {
    schemaVersion: 1,
    id,
    createdAt,
    app: { name: 'MeetNote AI', version: APP_VERSION },
    userReport: {
      summary: String(input.summary || '').trim().slice(0, 200),
      description: String(input.description || '').trim().slice(0, 10000),
      contact: String(input.contact || '').trim().slice(0, 320)
    },
    environment: {
      platform: process.platform,
      architecture: process.arch,
      osRelease: os.release(),
      nodeVersion: process.version,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    },
    diagnostics: {
      meetingCount: meetings.length,
      meetingStatusCounts: statusCounts,
      audio,
      settings: safeSettingsForDiagnostics(settings),
      recentLogs: logs
    },
    privacy: {
      excluded: ['audio content', 'transcripts', 'translations', 'notes', 'summaries', 'action items', 'meeting titles', 'API keys']
    }
  };
  const filename = `meetnote-bug-report-${createdAt.replace(/[:.]/g, '-')}-${id.slice(0, 8)}.json`;
  await atomicWriteJson(path.join(BUG_REPORTS_DIR, filename), report);
  await logEvent('info', 'bug_report.created', { reportId: id });
  return { filename, report };
}

// Serialize every read-modify-write operation for a JSON file. Atomic rename
// prevents torn files, while this queue prevents two requests from reading the
// same snapshot and then silently overwriting each other's changes.
const jsonMutationQueues = new Map();

function withJsonMutation(filePath, operation) {
  const previous = jsonMutationQueues.get(filePath) || Promise.resolve();
  const current = previous.then(operation, operation);
  jsonMutationQueues.set(filePath, current.catch(() => {}));
  return current;
}

function replaceJson(filePath, value) {
  return withJsonMutation(filePath, () => atomicWriteJson(filePath, value));
}

function mutateJson(filePath, fallback, mutation) {
  return withJsonMutation(filePath, async () => {
    const value = await readJson(filePath, fallback);
    const result = await mutation(value);
    await atomicWriteJson(filePath, value);
    return result;
  });
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { error: message });
}

async function readRequestBody(request, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error('Request body is too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonRequest(request) {
  // Require an explicit JSON content type so a cross-site page cannot smuggle a
  // body through a CORS-safelisted text/plain "simple request".
  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    throw Object.assign(new Error('Content-Type must be application/json'), { statusCode: 415 });
  }
  const body = await readRequestBody(request, MAX_JSON_BYTES);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 });
  }
}

// Loopback origins the app is served from. Used to reject cross-site and
// DNS-rebinding requests against the local API.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

// A state-changing API request is trusted only when it targets our loopback
// Host (blocks DNS rebinding) and, if a browser attached an Origin, that Origin
// is ours (blocks cross-site requests). Non-browser callers omit Origin.
function isTrustedApiRequest(request) {
  if (!ALLOWED_HOSTS.has(String(request.headers.host || ''))) return false;
  const origin = request.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return false;
  return true;
}

function hasTrustedHost(request) {
  return ALLOWED_HOSTS.has(String(request.headers.host || ''));
}

function audioKey(id) {
  return crypto.createHash('sha256').update(id).digest('hex');
}

function audioPaths(id) {
  const key = audioKey(id);
  return {
    data: path.join(AUDIO_DIR, `${key}.audio`),
    metadata: path.join(AUDIO_DIR, `${key}.json`)
  };
}

function artifactPath(directory, id) {
  return path.join(directory, `${audioKey(id)}.json`);
}

async function syncMeetingArtifacts(previousMeetings, meetings) {
  const previousById = new Map(previousMeetings.map(meeting => [meeting.id, meeting]));
  const activeArtifactNames = new Set();
  const writes = [];

  for (const meeting of meetings) {
    if (!meeting || typeof meeting.id !== 'string' || !meeting.id) continue;
    const artifactName = `${audioKey(meeting.id)}.json`;
    activeArtifactNames.add(artifactName);
    const previous = previousById.get(meeting.id);
    if (previous?.updatedAt === meeting.updatedAt) continue;

    writes.push(atomicWriteJson(artifactPath(TRANSCRIPTS_DIR, meeting.id), {
      meetingId: meeting.id,
      title: meeting.title || 'Untitled Meeting',
      language: meeting.language || '',
      translationLanguage: meeting.translationLanguage || '',
      updatedAt: meeting.updatedAt || new Date().toISOString(),
      transcript: Array.isArray(meeting.transcript) ? meeting.transcript : [],
      translations: Array.isArray(meeting.translations) ? meeting.translations : [],
      sonioxUsage: meeting.sonioxUsage || null
    }));

    if (meeting.summary || meeting.summaryDetails) {
      writes.push(atomicWriteJson(artifactPath(SUMMARIES_DIR, meeting.id), {
        meetingId: meeting.id,
        title: meeting.title || 'Untitled Meeting',
        updatedAt: meeting.updatedAt || new Date().toISOString(),
        summary: meeting.summary || '',
        details: meeting.summaryDetails || null,
        actionItems: Array.isArray(meeting.actionItems) ? meeting.actionItems : []
      }));
    }
  }

  await Promise.all(writes);
  await Promise.all([
    removeStaleArtifacts(TRANSCRIPTS_DIR, activeArtifactNames),
    removeStaleArtifacts(SUMMARIES_DIR, activeArtifactNames)
  ]);
}

async function removeStaleArtifacts(directory, activeNames) {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  await Promise.all(entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json') && !activeNames.has(entry.name))
    .map(entry => fsp.rm(path.join(directory, entry.name), { force: true })));
}

function decodeAudioId(pathname) {
  try {
    const id = decodeURIComponent(pathname.slice('/api/audio/'.length));
    if (!id || id.length > 256 || id.includes('\0')) return null;
    return id;
  } catch {
    return null;
  }
}

async function saveAudio(request, id) {
  const paths = audioPaths(id);
  const tempPath = `${paths.data}.${process.pid}.${Date.now()}.tmp`;
  let total = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      total += chunk.length;
      if (total > MAX_AUDIO_BYTES) {
        callback(Object.assign(new Error('Audio file is too large'), { statusCode: 413 }));
        return;
      }
      callback(null, chunk);
    }
  });

  try {
    await pipeline(request, limiter, fs.createWriteStream(tempPath, { flags: 'wx' }));
    await fsp.rename(tempPath, paths.data);
    await atomicWriteJson(paths.metadata, {
      id,
      mimeType: request.headers['content-type'] || 'application/octet-stream',
      filename: decodeAudioFilename(request.headers['x-audio-filename']),
      size: total,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    await fsp.rm(tempPath, { force: true });
    throw error;
  }
}

function decodeAudioFilename(value) {
  if (!value) return '';
  try {
    return path.basename(decodeURIComponent(String(value))).slice(0, 255);
  } catch {
    return '';
  }
}

function audioExtensionForMime(mimeType) {
  const type = String(mimeType || '').toLowerCase();
  if (type.includes('webm')) return 'webm';
  if (type.includes('mp4') || type.includes('m4a')) return 'm4a';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  if (type.includes('wav')) return 'wav';
  if (type.includes('flac')) return 'flac';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('aac')) return 'aac';
  return 'audio';
}

async function clearAudio() {
  await fsp.mkdir(AUDIO_DIR, { recursive: true });
  const entries = await fsp.readdir(AUDIO_DIR, { withFileTypes: true });
  await Promise.all(entries
    .filter(entry => entry.name !== '.gitkeep')
    .map(entry => fsp.rm(path.join(AUDIO_DIR, entry.name), {
      recursive: entry.isDirectory(),
      force: true
    })));
}

async function clearDirectory(directory) {
  await fsp.mkdir(directory, { recursive: true });
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  await Promise.all(entries
    .filter(entry => entry.name !== '.gitkeep')
    .map(entry => fsp.rm(path.join(directory, entry.name), {
      recursive: entry.isDirectory(),
      force: true
    })));
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT_DIR,
      env: options.env || process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish(reject, Object.assign(new Error(`${path.basename(command)} timed out`), { statusCode: 504 }));
    }, options.timeoutMs || 15_000);

    child.on('error', error => finish(reject, error));
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > (options.maxOutputBytes || MAX_CODEX_OUTPUT_BYTES)) {
        child.kill('SIGTERM');
        finish(reject, Object.assign(new Error('Process output is too large'), { statusCode: 502 }));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_CODEX_OUTPUT_BYTES) stderr.push(chunk);
    });
    child.on('close', code => finish(resolve, {
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8')
    }));

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function readKeychainSecret(account) {
  if (process.platform === 'darwin') {
    const result = await runProcess('/usr/bin/security', [
      'find-generic-password',
      '-a', account,
      '-s', KEYCHAIN_SERVICE,
      '-w'
    ]).catch(() => null);
    return result?.code === 0 ? result.stdout.trim() : '';
  }
  if (process.platform === 'win32') {
    const result = await runWindowsDpapi('read', account).catch(() => null);
    return result?.code === 0 ? result.stdout.trim() : '';
  }
  return '';
}

async function writeKeychainSecret(account, secret) {
  if (process.platform === 'win32') {
    const result = await runWindowsDpapi('write', account, secret);
    if (result.code !== 0) {
      throw Object.assign(new Error('Could not save the API key with Windows Data Protection'), { statusCode: 500 });
    }
    return;
  }
  if (process.platform !== 'darwin') {
    throw Object.assign(new Error('Secure credential storage is unavailable on this platform'), { statusCode: 501 });
  }
  const result = await runProcess('/usr/bin/security', [
    'add-generic-password',
    '-U',
    '-a', account,
    '-s', KEYCHAIN_SERVICE,
    '-w', secret
  ]);
  if (result.code !== 0) {
    throw Object.assign(new Error('Could not save the API key in macOS Keychain'), { statusCode: 500 });
  }
}

async function deleteKeychainSecret(account) {
  if (process.platform === 'win32') {
    await fsp.rm(windowsSecretPath(account), { force: true });
    return;
  }
  if (process.platform !== 'darwin') return;
  // A missing item exits non-zero; treat that as already removed.
  await runProcess('/usr/bin/security', [
    'delete-generic-password',
    '-a', account,
    '-s', KEYCHAIN_SERVICE
  ]).catch(() => {});
}

function windowsSecretPath(account) {
  const key = crypto.createHash('sha256').update(`${KEYCHAIN_SERVICE}:${account}`).digest('hex');
  return path.join(SECRETS_DIR, `${key}.dpapi`);
}

async function runWindowsDpapi(action, account, secret = '') {
  await fsp.mkdir(SECRETS_DIR, { recursive: true });
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
  );
  const secretFile = windowsSecretPath(account);
  const readScript = [
    '$p=$args[0]',
    'if (!(Test-Path -LiteralPath $p)) { exit 0 }',
    '$b=[IO.File]::ReadAllBytes($p)',
    '$u=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($u))'
  ].join(';');
  const writeScript = [
    '$p=$args[0]',
    '$s=[Console]::In.ReadToEnd()',
    '$b=[Text.Encoding]::UTF8.GetBytes($s)',
    '$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[IO.File]::WriteAllBytes($p,$e)'
  ].join(';');
  return runProcess(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', action === 'write' ? writeScript : readScript,
    secretFile
  ], {
    input: action === 'write' ? secret : undefined,
    timeoutMs: 15_000,
    maxOutputBytes: 16 * 1024
  });
}

async function getSonioxApiKey() {
  return (process.env.SONIOX_API_KEY || '').trim() ||
    await readKeychainSecret(SONIOX_KEYCHAIN_ACCOUNT);
}

// Speech-to-text service for the file-upload flow. Providers stay decoupled
// from routing; the live streaming path stays in the browser transcriber.
const stt = createSttService({
  timeoutMs: LLM_API_TIMEOUT_MS,
  secretStore: {
    read: readKeychainSecret,
    write: writeKeychainSecret,
    remove: deleteKeychainSecret
  },
  getSettings: () => readJson(SETTINGS_FILE, {})
});

// ── Server-owned transcription job lifecycle ──────────────────────────────────
// In-memory map of running jobs (meetingId → { jobId, promise }). Used for
// dedupe within a single process; jobs.json is the source of truth across
// restarts.
const runningJobs = new Map();

async function readJobs() {
  return readJson(JOBS_FILE, []);
}

const MAX_TERMINAL_JOBS = 200;

function pruneTerminalJobs(jobs) {
  const active = jobs.filter(job => job.status === 'processing' || job.status === 'queued');
  const terminal = jobs
    .filter(job => job.status !== 'processing' && job.status !== 'queued')
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, MAX_TERMINAL_JOBS);
  jobs.splice(0, jobs.length, ...active, ...terminal);
}

function findActiveJob(jobs, meetingId) {
  return jobs.find(j => j.meetingId === meetingId && (j.status === 'processing' || j.status === 'queued'));
}

// Targeted merge: update only transcription-related fields on a single meeting.
// This keeps the server as a single-field writer and avoids clobbering client
// fields (notes, actionItems, summary, etc.).
async function mergeTranscriptionIntoMeeting(meetingId, updates) {
  return mutateJson(MEETINGS_FILE, [], async meetings => {
    const index = meetings.findIndex(m => m.id === meetingId);
    if (index < 0) return false; // meeting was deleted while job was running
    const previousMeetings = meetings.map(meeting => ({ ...meeting }));
    Object.assign(meetings[index], updates, { updatedAt: new Date().toISOString() });
    await syncMeetingArtifacts(previousMeetings, meetings)
      .catch(err => console.error('artifact sync failed:', err));
    return true;
  });
}

// Fire-and-forget worker. Runs stt.transcribe, persists the result onto the
// meeting BEFORE marking the job complete (acceptance criterion).
async function runTranscriptionJob(job) {
  try {
    const audio = await openStoredAudio(job.meetingId);
    const result = await stt.transcribe({
      providerId: job.provider,
      modelId: job.model,
      audioMeta: audio.meta,
      loadAudio: audio.load,
      language: job.language,
      translationLanguage: job.translationLanguage
    });

    // Persist transcript onto meeting FIRST.
    const provider = result.provider || job.provider || 'soniox';
    const duration = Number(result.duration) || 0;
    const isSoniox = provider === 'soniox';
    const sonioxRate = job.translationLanguage ? 0.16 : 0.10;
    await mergeTranscriptionIntoMeeting(job.meetingId, {
      transcript: Array.isArray(result.transcript) ? result.transcript : [],
      translations: Array.isArray(result.translations) ? result.translations : [],
      duration,
      status: 'completed',
      processingError: '',
      _activeJobId: null,
      sonioxUsage: {
        provider,
        model: result.model || job.model || '',
        startedAt: job.createdAt,
        endedAt: new Date().toISOString(),
        billableDurationSeconds: duration,
        pricingUsdPerHour: isSoniox ? sonioxRate : null,
        estimatedCostUsd: isSoniox ? (duration / 3600) * sonioxRate : null,
        translationEnabled: Boolean(job.translationLanguage),
        source: 'file-upload'
      }
    });

    // THEN mark the job completed. Keep a bounded terminal record so an unknown
    // id is never mistaken for a successfully completed job.
    await mutateJson(JOBS_FILE, [], jobs => {
      const stored = jobs.find(item => item.id === job.id);
      if (stored) {
        stored.status = 'completed';
        stored.error = null;
        stored.updatedAt = new Date().toISOString();
      }
      pruneTerminalJobs(jobs);
    });
  } catch (error) {
    // Mark job failed; update meeting to failed.
    const errorInfo = {
      code: error.llmCode || 'STT_TRANSCRIBE_FAILED',
      message: error.message || 'Transcription failed.'
    };
    await mergeTranscriptionIntoMeeting(job.meetingId, {
      status: 'failed',
      processingError: errorInfo.message,
      _activeJobId: null
    });
    await mutateJson(JOBS_FILE, [], jobs => {
      const stored = jobs.find(item => item.id === job.id);
      if (stored) {
        stored.status = 'failed';
        stored.error = errorInfo;
        stored.updatedAt = new Date().toISOString();
      }
      pruneTerminalJobs(jobs);
    });
  } finally {
    runningJobs.delete(job.meetingId);
  }
}

// Recover jobs that were processing when the server last exited. They cannot
// resume a lost provider call, so mark them failed and preserve the audio for
// retry.
async function recoverInterruptedJobs() {
  const jobs = await readJobs();
  const stuck = jobs.filter(j => j.status === 'processing' || j.status === 'queued');
  if (stuck.length === 0) return;
  const now = new Date().toISOString();
  for (const job of stuck) {
    job.status = 'failed';
    job.error = { code: 'STT_SERVER_RESTARTED', message: 'The server restarted before transcription finished. The original audio is preserved — please try again.' };
    job.updatedAt = now;
    await mergeTranscriptionIntoMeeting(job.meetingId, {
      status: 'failed',
      processingError: job.error.message,
      _activeJobId: null
    });
  }
  await replaceJson(JOBS_FILE, jobs);
}

// Stat a stored recording and return its metadata + a lazy byte loader. The
// caller checks size against the provider limit before invoking the loader, so
// an oversized file is never read into memory.
async function openStoredAudio(meetingId) {
  const paths = audioPaths(meetingId);
  const [metadata, stat] = await Promise.all([
    readJson(paths.metadata, {}),
    fsp.stat(paths.data).catch(error => {
      if (error.code === 'ENOENT') throw Object.assign(new Error('Uploaded audio file was not found'), { statusCode: 404 });
      throw error;
    })
  ]);
  const mimeType = metadata.mimeType || 'application/octet-stream';
  return {
    meta: {
      mimeType,
      filename: metadata.filename || `${meetingId}.${audioExtensionForMime(mimeType)}`,
      size: stat.size
    },
    load: () => fsp.readFile(paths.data)
  };
}

function validateMeetingForSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('Meeting must be an object'), { statusCode: 400 });
  }
  const transcript = Array.isArray(value.transcript) ? value.transcript : [];
  if (transcript.length === 0) {
    throw Object.assign(new Error('The meeting has no transcript to summarize'), { statusCode: 400 });
  }
  return {
    id: typeof value.id === 'string' ? value.id.slice(0, 256) : '',
    title: typeof value.title === 'string' ? value.title.slice(0, 500) : 'Untitled Meeting',
    date: typeof value.date === 'string' ? value.date.slice(0, 64) : '',
    duration: Number.isFinite(Number(value.duration)) ? Math.max(0, Number(value.duration)) : 0,
    participants: Array.isArray(value.participants)
      ? value.participants.slice(0, 200).map(item => String(item).slice(0, 200))
      : [],
    transcript: transcript.slice(0, 50000).map(segment => ({
      time: Number.isFinite(Number(segment?.time)) ? Math.max(0, Number(segment.time)) : 0,
      speaker: typeof segment?.speaker === 'string' ? segment.speaker.slice(0, 200) : 'Speaker',
      text: typeof segment?.text === 'string' ? segment.text.slice(0, 20000) : ''
    })).filter(segment => segment.text)
  };
}

function resolveCodexBinary() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const appBinary = '/Applications/ChatGPT.app/Contents/Resources/codex';
  if (fs.existsSync(appBinary)) return appBinary;
  return 'codex';
}

// Single LLM service the routes talk to. Providers stay decoupled from routing.
const llm = createLlmService({
  runProcess,
  resolveCodexBinary,
  summarySchemaFile: SUMMARY_SCHEMA_FILE,
  titleSchemaFile: TITLE_SCHEMA_FILE,
  apiTimeoutMs: LLM_API_TIMEOUT_MS,
  codexTimeoutMs: CODEX_TIMEOUT_MS,
  secretStore: {
    read: readKeychainSecret,
    write: writeKeychainSecret,
    remove: deleteKeychainSecret
  },
  getSettings: () => readJson(SETTINGS_FILE, {})
});

// Pull the meeting payload from either { meeting } or a legacy flat body.
function extractMeetingPayload(body) {
  return body && typeof body.meeting === 'object' && body.meeting ? body.meeting : body;
}

// Normalize a typed LLM error into the standard error envelope.
function sendLlmError(response, error) {
  sendJson(response, error.statusCode || 500, {
    error: {
      code: error.llmCode || 'LLM_PROVIDER_UNAVAILABLE',
      message: error.message || 'The provider request failed.',
      provider: error.provider || '',
      retryable: Boolean(error.retryable)
    }
  });
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { ok: true, storage: 'file', version: APP_VERSION });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/logs') {
    sendJson(response, 200, { logs: await readRecentLogEntries(), version: APP_VERSION });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/logs') {
    const body = await readJsonRequest(request);
    await logEvent(body?.level, `client.${body?.event || 'event'}`, {
      message: String(body?.message || '').slice(0, MAX_CLIENT_LOG_MESSAGE),
      context: body?.context || {}
    });
    sendJson(response, 202, { success: true });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/bug-reports') {
    const body = await readJsonRequest(request);
    const summary = String(body?.summary || '').trim();
    const description = String(body?.description || '').trim();
    if (!summary || !description) {
      sendError(response, 400, 'Summary and description are required');
      return true;
    }
    sendJson(response, 201, await createBugReport(body));
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/integrations/status') {
    const sonioxApiKey = await getSonioxApiKey();
    sendJson(response, 200, {
      soniox: {
        configured: Boolean(sonioxApiKey),
        source: process.env.SONIOX_API_KEY ? 'environment' : (sonioxApiKey ? 'keychain' : '')
      }
    });
    return true;
  }

  // Safe provider metadata for the settings UI (never returns secrets).
  if (request.method === 'GET' && url.pathname === '/api/llm/providers') {
    sendJson(response, 200, await llm.listProviders());
    return true;
  }

  // Save / remove / test a provider API key (API providers only).
  const providerKeyMatch = url.pathname.match(/^\/api\/llm\/providers\/([a-z0-9-]{1,40})\/key$/);
  if (providerKeyMatch) {
    const providerId = providerKeyMatch[1];
    if (request.method === 'PUT') {
      const body = await readJsonRequest(request);
      const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
      if (!apiKey || apiKey.length > 4000) {
        sendError(response, 400, 'Enter a valid API key');
        return true;
      }
      try {
        await llm.saveKey(providerId, apiKey);
      } catch (error) {
        if (error.llmCode) return sendLlmError(response, error), true;
        throw error;
      }
      sendJson(response, 200, { success: true });
      return true;
    }
    if (request.method === 'DELETE') {
      try {
        await llm.removeKey(providerId);
      } catch (error) {
        if (error.llmCode) return sendLlmError(response, error), true;
        throw error;
      }
      sendJson(response, 200, { success: true });
      return true;
    }
  }

  const providerTestMatch = url.pathname.match(/^\/api\/llm\/providers\/([a-z0-9-]{1,40})\/test$/);
  if (request.method === 'POST' && providerTestMatch) {
    try {
      const result = await llm.testConnection(providerTestMatch[1]);
      sendJson(response, 200, result);
    } catch (error) {
      if (error.llmCode) sendLlmError(response, error);
      else throw error;
    }
    return true;
  }

  // Speech-to-text provider management (mirrors the LLM provider endpoints).
  if (request.method === 'GET' && url.pathname === '/api/stt/providers') {
    sendJson(response, 200, await stt.listProviders());
    return true;
  }

  const sttKeyMatch = url.pathname.match(/^\/api\/stt\/providers\/([a-z0-9-]{1,40})\/key$/);
  if (sttKeyMatch) {
    const providerId = sttKeyMatch[1];
    if (request.method === 'PUT') {
      const body = await readJsonRequest(request);
      const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
      if (!apiKey || apiKey.length > 4000) {
        sendError(response, 400, 'Enter a valid API key');
        return true;
      }
      try {
        await stt.saveKey(providerId, apiKey);
      } catch (error) {
        if (error.llmCode) return sendLlmError(response, error), true;
        throw error;
      }
      sendJson(response, 200, { success: true });
      return true;
    }
    if (request.method === 'DELETE') {
      try {
        await stt.removeKey(providerId);
      } catch (error) {
        if (error.llmCode) return sendLlmError(response, error), true;
        throw error;
      }
      sendJson(response, 200, { success: true });
      return true;
    }
  }

  const sttTestMatch = url.pathname.match(/^\/api\/stt\/providers\/([a-z0-9-]{1,40})\/test$/);
  if (request.method === 'POST' && sttTestMatch) {
    try {
      sendJson(response, 200, await stt.testConnection(sttTestMatch[1]));
    } catch (error) {
      if (error.llmCode) sendLlmError(response, error);
      else throw error;
    }
    return true;
  }

  // Short-lived credential for a browser live-streaming session (e.g. Deepgram).
  const sttTempKeyMatch = url.pathname.match(/^\/api\/stt\/providers\/([a-z0-9-]{1,40})\/temporary-key$/);
  if (request.method === 'POST' && sttTempKeyMatch) {
    try {
      sendJson(response, 201, await stt.temporaryKey(sttTempKeyMatch[1]));
    } catch (error) {
      if (error.llmCode) sendLlmError(response, error);
      else throw error;
    }
    return true;
  }

  if (request.method === 'PUT' && url.pathname === '/api/soniox/key') {
    const body = await readJsonRequest(request);
    const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
    if (!apiKey || apiKey.length > 1000) {
      sendError(response, 400, 'Enter a valid Soniox API key');
      return true;
    }
    await writeKeychainSecret(SONIOX_KEYCHAIN_ACCOUNT, apiKey);
    sendJson(response, 200, { success: true });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/soniox/temporary-key') {
    const body = await readJsonRequest(request);
    const apiKey = await getSonioxApiKey();
    if (!apiKey) {
      sendError(response, 400, 'Soniox is not configured. Add the API key in Settings.');
      return true;
    }
    const clientReferenceId = typeof body?.meetingId === 'string'
      ? body.meetingId.slice(0, 256)
      : undefined;
    const sonioxResponse = await fetch('https://api.soniox.com/v1/auth/temporary-api-key', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        usage_type: 'transcribe_websocket',
        expires_in_seconds: 60,
        single_use: true,
        max_session_duration_seconds: 5 * 60 * 60,
        ...(clientReferenceId ? { client_reference_id: clientReferenceId } : {})
      })
    });
    const data = await sonioxResponse.json().catch(() => ({}));
    if (!sonioxResponse.ok) {
      const message = data.message || data.error_message || 'Soniox rejected the API key request';
      throw Object.assign(new Error(message), { statusCode: sonioxResponse.status });
    }
    sendJson(response, 201, {
      apiKey: data.api_key,
      expiresAt: data.expires_at
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/summary') {
    const body = await readJsonRequest(request);
    const meeting = validateMeetingForSummary(extractMeetingPayload(body));
    let result;
    try {
      result = await llm.generateSummary({
        providerId: typeof body?.provider === 'string' ? body.provider : '',
        modelId: typeof body?.model === 'string' ? body.model : '',
        language: typeof body?.language === 'string' ? body.language.slice(0, 20) : '',
        meeting
      });
    } catch (error) {
      if (error.llmCode) return sendLlmError(response, error), true;
      throw error;
    }
    if (meeting.id) {
      await atomicWriteJson(artifactPath(SUMMARIES_DIR, meeting.id), {
        meetingId: meeting.id,
        title: meeting.title,
        summaryGeneration: result.generation,
        details: result.data
      });
    }
    sendJson(response, 200, { ...result.data, summaryGeneration: result.generation });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/title-suggestion') {
    const body = await readJsonRequest(request);
    const meeting = validateMeetingForSummary(extractMeetingPayload(body));
    try {
      const result = await llm.suggestTitle({
        providerId: typeof body?.provider === 'string' ? body.provider : '',
        modelId: typeof body?.model === 'string' ? body.model : '',
        meeting
      });
      sendJson(response, 200, { ...result.data, generation: result.generation });
    } catch (error) {
      if (error.llmCode) sendLlmError(response, error);
      else throw error;
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/import-transcription') {
    const body = await readJsonRequest(request);
    const meetingId = typeof body?.meetingId === 'string' ? body.meetingId.slice(0, 256) : '';
    if (!meetingId) {
      sendError(response, 400, 'Meeting id is required');
      return true;
    }

    // Dedupe: return the existing active job for this meeting if one exists.
    const existingInMemory = runningJobs.get(meetingId);
    if (existingInMemory) {
      sendJson(response, 200, { jobId: existingInMemory.jobId, status: 'processing' });
      return true;
    }
    // Verify audio exists before creating the job.
    await openStoredAudio(meetingId);

    // Check-and-create under one file mutation lock so concurrent submissions
    // for the same meeting cannot both create workers or lose job records.
    const transaction = await mutateJson(JOBS_FILE, [], jobs => {
      const existing = findActiveJob(jobs, meetingId);
      if (existing) return { job: existing, created: false };
      const now = new Date().toISOString();
      const job = {
        id: `job-${crypto.randomUUID()}`,
        meetingId,
        provider: typeof body.provider === 'string' ? body.provider : '',
        model: typeof body.model === 'string' ? body.model : '',
        language: typeof body.language === 'string' ? body.language.slice(0, 20) : 'auto',
        translationLanguage: typeof body.translationLanguage === 'string' ? body.translationLanguage.slice(0, 20) : '',
        status: 'processing',
        error: null,
        createdAt: now,
        updatedAt: now
      };
      jobs.push(job);
      pruneTerminalJobs(jobs);
      return { job, created: true };
    });
    const { job, created } = transaction;
    if (!created) {
      sendJson(response, 200, { jobId: job.id, status: job.status });
      return true;
    }

    // The association is server-owned; the browser never needs to PUT a stale
    // meeting snapshot merely to remember which job it should poll.
    const associated = await mergeTranscriptionIntoMeeting(meetingId, {
      status: 'processing',
      processingError: '',
      _activeJobId: job.id
    });
    if (!associated) {
      await mutateJson(JOBS_FILE, [], jobs => {
        const index = jobs.findIndex(item => item.id === job.id);
        if (index >= 0) jobs.splice(index, 1);
      });
      sendError(response, 404, 'Meeting not found');
      return true;
    }

    // Fire-and-forget: kick off the worker, track in-memory for dedupe.
    const promise = runTranscriptionJob(job);
    runningJobs.set(meetingId, { jobId: job.id, promise });

    sendJson(response, 201, { jobId: job.id, status: 'processing' });
    return true;
  }

  // Poll a transcription job's status.
  const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]{1,80})$/);
  if (request.method === 'GET' && jobMatch) {
    const jobId = jobMatch[1];
    const jobs = await readJobs();
    const job = jobs.find(j => j.id === jobId);
    if (!job) {
      sendError(response, 404, 'Transcription job not found');
      return true;
    }
    sendJson(response, 200, { id: job.id, meetingId: job.meetingId, status: job.status, error: job.error });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/data') {
    const [meetings, settings] = await Promise.all([
      readJson(MEETINGS_FILE, []),
      readJson(SETTINGS_FILE, {})
    ]);
    sendJson(response, 200, { meetings, settings });
    return true;
  }

  if (request.method === 'PUT' && url.pathname === '/api/meetings') {
    const incomingMeetings = await readJsonRequest(request);
    if (!Array.isArray(incomingMeetings)) {
      sendError(response, 400, 'Meetings must be an array');
      return true;
    }
    await mutateJson(MEETINGS_FILE, [], async meetings => {
      const previousMeetings = meetings.map(meeting => ({ ...meeting }));
      const currentById = new Map(meetings.map(meeting => [meeting.id, meeting]));
      const merged = incomingMeetings.map(incoming => {
        const current = currentById.get(incoming?.id);
        // A stale browser snapshot must never roll a server-owned terminal STT
        // result back to processing. Explicit future retries should go through
        // the transcription endpoint, which sets processing server-side.
        if (current && ['completed', 'failed'].includes(current.status) && incoming?.status === 'processing') {
          return {
            ...incoming,
            transcript: current.transcript,
            translations: current.translations,
            duration: current.duration,
            status: current.status,
            processingError: current.processingError,
            sonioxUsage: current.sonioxUsage,
            _activeJobId: current._activeJobId || null,
            updatedAt: current.updatedAt
          };
        }
        return incoming;
      });
      meetings.splice(0, meetings.length, ...merged);
      await syncMeetingArtifacts(previousMeetings, meetings);
      const remainingIds = new Set(merged.map(meeting => meeting.id));
      const removedCount = previousMeetings.filter(previous => !remainingIds.has(previous.id)).length;
      if (removedCount > 0) await logEvent('info', 'meetings.deleted', { count: removedCount });
    });
    sendJson(response, 200, { success: true });
    return true;
  }

  if (request.method === 'PUT' && url.pathname === '/api/settings') {
    const settings = await readJsonRequest(request);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      sendError(response, 400, 'Settings must be an object');
      return true;
    }
    await replaceJson(SETTINGS_FILE, settings);
    sendJson(response, 200, { success: true });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/clear') {
    const body = await readJsonRequest(request);
    if (body?.confirmation !== 'CLEAR_ALL_DATA') {
      sendError(response, 400, 'Explicit clear confirmation is required');
      return true;
    }
    await Promise.all([
      replaceJson(MEETINGS_FILE, []),
      replaceJson(SETTINGS_FILE, {}),
      replaceJson(JOBS_FILE, []),
      clearAudio(),
      clearDirectory(TRANSCRIPTS_DIR),
      clearDirectory(SUMMARIES_DIR)
    ]);
    sendJson(response, 200, { success: true });
    return true;
  }

  if (url.pathname === '/api/audio' && request.method === 'DELETE') {
    await clearAudio();
    sendJson(response, 200, { success: true });
    return true;
  }

  if (url.pathname.startsWith('/api/audio/')) {
    const id = decodeAudioId(url.pathname);
    if (!id) {
      sendError(response, 400, 'Invalid audio id');
      return true;
    }
    const paths = audioPaths(id);

    if (request.method === 'PUT') {
      await saveAudio(request, id);
      sendJson(response, 200, { success: true });
      return true;
    }

    if (request.method === 'GET') {
      try {
        const [metadata, stat] = await Promise.all([
          readJson(paths.metadata, {}),
          fsp.stat(paths.data)
        ]);
        response.writeHead(200, {
          'Content-Type': metadata.mimeType || 'application/octet-stream',
          'Content-Length': stat.size,
          'Cache-Control': 'no-store'
        });
        fs.createReadStream(paths.data).pipe(response);
      } catch (error) {
        if (error.code === 'ENOENT') sendError(response, 404, 'Audio not found');
        else throw error;
      }
      return true;
    }

    if (request.method === 'DELETE') {
      await Promise.all([
        fsp.rm(paths.data, { force: true }),
        fsp.rm(paths.metadata, { force: true })
      ]);
      sendJson(response, 200, { success: true });
      return true;
    }
  }

  return false;
}

async function serveStatic(request, response, url) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    sendError(response, 405, 'Method not allowed');
    return;
  }

  const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestedPath);
  } catch {
    // Malformed percent-encoding (e.g. /%E0%A4%A) — reject cleanly, don't 500.
    sendError(response, 400, 'Bad request');
    return;
  }
  const filePath = path.resolve(ROOT_DIR, `.${decodedPath}`);
  const relativePath = path.relative(ROOT_DIR, filePath);

  if (
    relativePath.startsWith('..') ||
    path.isAbsolute(relativePath) ||
    relativePath === 'storage' ||
    relativePath.startsWith(`storage${path.sep}`) ||
    relativePath === 'server.js' ||
    relativePath === 'package.json'
  ) {
    sendError(response, 404, 'Not found');
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store'
    });
    if (request.method === 'HEAD') response.end();
    else fs.createReadStream(filePath).pipe(response);
  } catch (error) {
    if (error.code === 'ENOENT') sendError(response, 404, 'Not found');
    else throw error;
  }
}

async function requestHandler(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname.startsWith('/api/')) {
      // Guard reads as well as mutations. Checking only writes still lets a DNS
      // rebinding origin read transcripts, settings, and stored audio.
      if (!hasTrustedHost(request) || !isTrustedApiRequest(request)) {
        sendError(response, 403, 'Forbidden');
        return;
      }
      const handled = await handleApi(request, response, url);
      if (!handled) sendError(response, 404, 'API endpoint not found');
      return;
    }
    await serveStatic(request, response, url);
  } catch (error) {
    console.error(error);
    await logEvent('error', 'server.request_failed', {
      method: request.method,
      path: String(request.url || '').split('?')[0],
      statusCode: error.statusCode || 500,
      error: error.message || 'Internal server error',
      stack: error.stack || ''
    }).catch(() => {});
    if (response.headersSent) {
      response.destroy();
    } else if (error.llmCode) {
      sendLlmError(response, error);
    } else {
      sendError(response, error.statusCode || 500, error.message || 'Internal server error');
    }
  }
}

ensureStorage()
  .then(() => recoverInterruptedJobs())
  .then(() => logEvent('info', 'server.started', {
    version: APP_VERSION,
    platform: process.platform,
    architecture: process.arch,
    port: PORT
  }))
  .then(() => {
    http.createServer(requestHandler).listen(PORT, HOST, () => {
      console.log(`MeetNote is running at http://${HOST}:${PORT}`);
      console.log(`Data is stored in ${STORAGE_DIR}`);
    });
  })
  .catch(error => {
    console.error('Could not initialize local storage:', error);
    process.exitCode = 1;
  });
