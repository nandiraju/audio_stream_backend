'use strict';

// ---------------------------------------------------------------------------
// Post-segment pipeline: transcribe → upload → verify → delete local.
//
// Invariant: a recording still present in SAVE_DIR is unfinished work. Once
// both the audio and its transcript are confirmed in S3 (checksum-validated
// PUT + HeadObject readback), the local copies are removed. That makes the
// directory itself the queue — a boot-time scan of SAVE_DIR is all the crash
// recovery this needs, with no sidecar state file to drift out of sync.
//
// Nothing here ever blocks audio ingest: the queue runs at concurrency 1 and
// whisper is spawned at nice 19 so it yields to the WebSocket path.
// ---------------------------------------------------------------------------

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

const TRANSCRIBE = process.env.TRANSCRIBE !== '0';
const DELETE_LOCAL_AFTER_UPLOAD = process.env.DELETE_LOCAL_AFTER_UPLOAD !== '0';
const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper-cli';
// Multilingual by default. The bundled sample recordings contain non-English
// speech that `base.en` renders as fluent English nonsense ("nastanam" ->
// "the nastanam nastanam"), because an English-only model has no other option.
const WHISPER_MODEL = process.env.WHISPER_MODEL || '/models/ggml-large-v3-turbo-q5_0.bin';
const WHISPER_VAD_MODEL = process.env.WHISPER_VAD_MODEL || '/models/ggml-silero-v5.1.2.bin';
const WHISPER_THREADS = process.env.WHISPER_THREADS || '2';
const WHISPER_NICE = parseInt(process.env.WHISPER_NICE || '19', 10);
// 'auto' is safe here only because VAD runs first: detection sees speech rather
// than room tone. Set this explicitly (te, hi, en…) once you know the language —
// it is both faster and more accurate than per-segment detection.
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || 'auto';
// Anti-hallucination knobs. Whisper invents fluent text from room tone, and on
// this project's far-field audio it does so reliably — see README §6. Defaults
// below are chosen to lose a little marginal speech rather than emit fiction.
//   max-context 0 : never condition a window on the previous window's text,
//                   which is what lets a single bad guess repeat for minutes.
//   suppress-nst  : drop "(speaks in foreign language)"-style annotation tokens.
const WHISPER_MAX_CONTEXT = process.env.WHISPER_MAX_CONTEXT || '0';
const WHISPER_SUPPRESS_NST = process.env.WHISPER_SUPPRESS_NST !== '0';
const WHISPER_ENTROPY_THOLD = process.env.WHISPER_ENTROPY_THOLD || '2.4';
const WHISPER_LOGPROB_THOLD = process.env.WHISPER_LOGPROB_THOLD || '-1.0';
const WHISPER_NO_SPEECH_THOLD = process.env.WHISPER_NO_SPEECH_THOLD || '0.6';
const REPEAT_MAX = parseInt(process.env.TRANSCRIBE_REPEAT_MAX || '3', 10);
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
const MAX_ATTEMPTS = parseInt(process.env.TRANSCRIBE_MAX_ATTEMPTS || '3', 10);

const DEVICE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FILE_RE = /^[A-Za-z0-9._-]+\.(opus|wav)$/;

let deps = null;
let transcriptionAvailable = TRANSCRIBE;
let warnedNoVad = false;

const queue = [];
const queued = new Set(); // filePath — dedupe across enqueue + reconcile
let pumping = false;
let idleWaiters = [];

function init(injected) {
  deps = injected;
  if (!TRANSCRIBE) deps.log('pipeline: transcription disabled (TRANSCRIBE=0)');
  if (!DELETE_LOCAL_AFTER_UPLOAD) {
    deps.log('pipeline: local retention ON (DELETE_LOCAL_AFTER_UPLOAD=0) — disk will grow');
  }
}

const tmpDir = () => path.join(deps.SAVE_DIR, '.transcribe-tmp');
const wavCacheFor = (deviceId, file) =>
  path.join(deps.SAVE_DIR, '.wav-cache', deviceId, `${file}.wav`);

// ---------------------------------------------------------------------------
// Verified S3 writes
//
// The PUT carries a precomputed SHA-256, so S3 itself rejects a body that does
// not match — a 200 response already means the bytes landed intact. The
// HeadObject readback afterwards is the paranoid half: it proves the object is
// visible for reads before we delete the only other copy.
// ---------------------------------------------------------------------------
function sha256Base64(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('base64')));
  });
}

async function headObject(key) {
  try {
    const out = await deps.s3.send(new HeadObjectCommand({
      Bucket: deps.S3_BUCKET, Key: key,
    }));
    return { size: out.ContentLength };
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode;
    if (status === 404 || err.name === 'NotFound') return null;
    throw err;
  }
}

async function putVerified(key, filePath, contentType) {
  const { size } = await fsp.stat(filePath);
  const checksum = await sha256Base64(filePath);

  // A PUT that rejects before reading the body leaves this stream dangling. An
  // unhandled 'error' on it would take the process down later (e.g. when the
  // UI deletes that recording), so own its lifecycle explicitly.
  const body = fs.createReadStream(filePath);
  body.on('error', () => { /* surfaced through the send() rejection instead */ });
  try {
    await deps.s3.send(new PutObjectCommand({
      Bucket: deps.S3_BUCKET,
      Key: key,
      Body: body,
      ContentLength: size,
      ContentType: contentType,
      ChecksumAlgorithm: 'SHA256',
      ChecksumSHA256: checksum,
    }));
  } catch (err) {
    body.destroy();
    throw err;
  }

  const head = await headObject(key);
  if (!head) throw new Error(`verify failed: ${key} not readable after PUT`);
  if (head.size !== size) {
    throw new Error(`verify failed: ${key} is ${head.size} B, expected ${size} B`);
  }
  deps.log(`verified s3://${deps.S3_BUCKET}/${key} (${size} B)`);
  return size;
}

// ---------------------------------------------------------------------------
// Decode + transcribe
// ---------------------------------------------------------------------------
function run(bin, args, label, priority) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    if (priority != null) {
      // Renice rather than spawning through `nice`, so an ENOENT below still
      // means "this binary is missing" instead of "nice couldn't exec it".
      try { os.setPriority(child.pid, priority); } catch { /* best effort */ }
    }
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => reject(Object.assign(
      new Error(`${label} unavailable: ${err.message}`), { code: err.code },
    )));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${code}): ${stderr.trim().slice(0, 400)}`));
    });
  });
}

// whisper.cpp reads 16 kHz mono s16 WAV only — Opus always decodes at 48 kHz,
// so the resample is mandatory regardless of what the iPad sent.
async function decodeForWhisper(srcPath, wavPath) {
  await fsp.mkdir(path.dirname(wavPath), { recursive: true });
  await run(FFMPEG_BIN, [
    '-y', '-v', 'error',
    '-i', srcPath,
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
    wavPath,
  ], 'ffmpeg', WHISPER_NICE);
}

// --- degenerate-output filters ---------------------------------------------
// Decoder flags cut most hallucination, but loops still slip through, so the
// output is cleaned structurally too.

const cmpKey = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();

// "I'm a man. I'm a man. I'm a man." -> "I'm a man."
// Finds the shortest word-level period that tiles the segment at least three
// times and keeps a single copy.
function collapseInner(text) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 6) return text;
  for (let p = 1; p <= Math.floor(words.length / 3); p += 1) {
    let tiles = true;
    for (let i = p; i < words.length && tiles; i += 1) {
      if (cmpKey(words[i]) !== cmpKey(words[i - p])) tiles = false;
    }
    if (tiles) return words.slice(0, p).join(' ');
  }
  return text;
}

// Collapse consecutive repeats into one segment spanning the whole run, and
// cap how many times any long line may appear. Short backchannels ("Okay.",
// "Uh-huh.") legitimately repeat, so only longer lines are capped.
function dedupe(segments) {
  const merged = [];
  for (const seg of segments) {
    const prev = merged[merged.length - 1];
    if (prev && cmpKey(prev.text) === cmpKey(seg.text)) {
      prev.end = seg.end;
      prev.repeats = (prev.repeats || 1) + 1;
      continue;
    }
    merged.push({ ...seg });
  }
  const counts = new Map();
  return merged.filter((seg) => {
    if (cmpKey(seg.text).length <= 15) return true;
    const n = (counts.get(cmpKey(seg.text)) || 0) + 1;
    counts.set(cmpKey(seg.text), n);
    return n <= REPEAT_MAX;
  });
}

// Normalized transcript shape, so the web UI never has to track whisper.cpp's
// own JSON schema across versions.
function normalize(raw, modelName) {
  const rawSegments = (raw.transcription || []).map((seg) => ({
    start: (seg.offsets?.from ?? 0) / 1000,
    end: (seg.offsets?.to ?? 0) / 1000,
    text: collapseInner((seg.text || '').trim()),
  })).filter((s) => s.text);

  const segments = dedupe(rawSegments);

  return {
    version: 1,
    model: modelName,
    language: raw.result?.language || WHISPER_LANGUAGE,
    createdAt: new Date().toISOString(),
    // How much was dropped as degenerate — useful when a transcript looks thin.
    droppedSegments: rawSegments.length - segments.length,
    segments,
    text: segments.map((s) => s.text).join(' '),
  };
}

async function transcribe(srcPath, outJsonPath) {
  const base = path.join(tmpDir(), path.basename(srcPath));
  const wavPath = `${base}.16k.wav`;
  const whisperPrefix = `${base}.out`;

  // VAD is a large win on a mostly-silent room — it also suppresses whisper's
  // habit of hallucinating text out of ambient noise. Degrade to a plain
  // transcribe rather than failing every segment if the model isn't present.
  const vadArgs = fs.existsSync(WHISPER_VAD_MODEL)
    ? ['--vad', '--vad-model', WHISPER_VAD_MODEL, '--vad-speech-pad-ms', '200']
    : [];
  if (!vadArgs.length && !warnedNoVad) {
    warnedNoVad = true;
    // Without VAD a large model runs below realtime on 2 vCPU and the queue
    // never drains, so this is a throughput emergency, not a nicety.
    deps.log(`pipeline: VAD model missing at ${WHISPER_VAD_MODEL} — running WITHOUT VAD. ` +
      'Expect hallucinated text on silence, and with a large model the queue may not keep up.');
  }

  try {
    await decodeForWhisper(srcPath, wavPath);
    await run(WHISPER_BIN, [
      '-m', WHISPER_MODEL,
      '-t', WHISPER_THREADS,
      '-l', WHISPER_LANGUAGE,
      '-mc', WHISPER_MAX_CONTEXT,
      '-et', WHISPER_ENTROPY_THOLD,
      '-lpt', WHISPER_LOGPROB_THOLD,
      '-nth', WHISPER_NO_SPEECH_THOLD,
      ...(WHISPER_SUPPRESS_NST ? ['-sns'] : []),
      ...vadArgs,
      '-np',                       // keep per-segment logs out of the container output
      '-oj', '-of', whisperPrefix,
      '-f', wavPath,
    ], 'whisper', WHISPER_NICE);

    const raw = JSON.parse(await fsp.readFile(`${whisperPrefix}.json`, 'utf8'));
    const doc = normalize(raw, path.basename(WHISPER_MODEL));
    await fsp.mkdir(path.dirname(outJsonPath), { recursive: true });
    await fsp.writeFile(outJsonPath, JSON.stringify(doc));
    return doc.segments.length;
  } finally {
    // Big intermediates die even on failure — a 30 min segment is ~58 MB of WAV.
    await fsp.rm(wavPath, { force: true });
    await fsp.rm(`${whisperPrefix}.json`, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Per-segment state machine
// ---------------------------------------------------------------------------
async function processSegment(job) {
  const { deviceId, filePath } = job;
  const file = path.basename(filePath);
  const audioKey = `${deviceId}/${file}`;
  const transcriptKey = `${audioKey}.json`;
  const localJson = path.join(deps.SAVE_DIR, deviceId, `${file}.json`);

  if (deps.liveFilePaths().has(filePath)) return;      // still recording
  if (!fs.existsSync(filePath)) return;                // already finished + swept

  // 1. transcript — reuse whatever already exists in S3 or on disk
  let haveTranscript = Boolean(await headObject(transcriptKey));
  if (!haveTranscript && transcriptionAvailable) {
    try {
      if (!fs.existsSync(localJson)) {
        const n = await transcribe(filePath, localJson);
        deps.log(`transcribed ${audioKey} — ${n} speech segments`);
      }
      haveTranscript = true;
    } catch (err) {
      if (err.code === 'ENOENT') {
        // whisper or ffmpeg missing entirely — stop retrying every segment.
        transcriptionAvailable = false;
        deps.log(`pipeline: ${err.message} — transcription disabled for this process`);
      } else {
        deps.log(`transcribe error for ${audioKey}: ${err.message}`);
        job.attempts += 1;
        if (job.attempts < MAX_ATTEMPTS) throw err; // requeue, audio stays local
        deps.log(`giving up on transcript for ${audioKey} after ${job.attempts} attempts`);
      }
    }
  }

  // 2. audio → S3 (skip if an identical-size object is already there)
  const { size } = await fsp.stat(filePath);
  const existing = await headObject(audioKey);
  if (!existing || existing.size !== size) {
    await putVerified(audioKey, filePath, file.endsWith('.wav') ? 'audio/wav' : 'audio/ogg');
  }

  // 3. transcript → S3
  if (fs.existsSync(localJson) && !(await headObject(transcriptKey))) {
    await putVerified(transcriptKey, localJson, 'application/json');
  }

  // 4. only now is the local copy expendable
  if (!DELETE_LOCAL_AFTER_UPLOAD) return;
  if (deps.liveFilePaths().has(filePath)) return;      // re-check: never unlink a live sink

  await fsp.rm(filePath, { force: true });
  await fsp.rm(localJson, { force: true });
  await fsp.rm(wavCacheFor(deviceId, file), { force: true });
  deps.log(`swept local ${deviceId}/${file} (${size} B reclaimed)`);
}

// ---------------------------------------------------------------------------
// Serial queue
// ---------------------------------------------------------------------------
function enqueue(deviceId, filePath) {
  if (queued.has(filePath)) return;
  queued.add(filePath);
  queue.push({ deviceId, filePath, attempts: 0 });
  pump();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      try {
        await processSegment(job);
        queued.delete(job.filePath);
      } catch (err) {
        queued.delete(job.filePath);
        deps.log(`pipeline error for ${job.deviceId}/${path.basename(job.filePath)}: ${err.message}`);
        // Left on disk on purpose: the next reconcile picks it up. Losing the
        // recording is worse than keeping the bytes around another cycle.
      }
    }
  } finally {
    pumping = false;
    idleWaiters.forEach((r) => r());
    idleWaiters = [];
  }
}

function drain() {
  if (!pumping && !queue.length) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

// ---------------------------------------------------------------------------
// Boot recovery: anything left in SAVE_DIR is, by the invariant, unfinished.
// Covers crashes, OOM kills, and shutdowns that outran the upload.
// ---------------------------------------------------------------------------
async function reconcile() {
  await fsp.rm(tmpDir(), { recursive: true, force: true }); // stale WAVs from a killed run
  let found = 0;
  let devices;
  try {
    devices = await fsp.readdir(deps.SAVE_DIR, { withFileTypes: true });
  } catch {
    return 0;
  }
  const live = deps.liveFilePaths();
  for (const dirent of devices) {
    if (!dirent.isDirectory() || !DEVICE_RE.test(dirent.name)) continue; // skips .wav-cache etc.
    const deviceDir = path.join(deps.SAVE_DIR, dirent.name);
    for (const name of await fsp.readdir(deviceDir)) {
      if (!FILE_RE.test(name)) continue;
      const filePath = path.join(deviceDir, name);
      if (live.has(filePath)) continue;
      enqueue(dirent.name, filePath);
      found += 1;
    }
  }
  if (found) deps.log(`pipeline: reconcile queued ${found} unfinished segment(s)`);
  return found;
}

module.exports = { init, enqueue, reconcile, drain };
