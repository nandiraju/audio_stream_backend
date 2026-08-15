'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { OggOpusWriter } = require('./oggopus');
const pipeline = require('./pipeline');
const {
  S3Client, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand,
} = require('@aws-sdk/client-s3');

const PORT = parseInt(process.env.PORT || '8080', 10);
const SAVE_AUDIO = process.env.SAVE_AUDIO !== '0';
const SAVE_DIR = process.env.SAVE_DIR || path.join(__dirname, 'recordings');
const PUBLIC_DIR = path.join(__dirname, 'public');
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const SEGMENT_MINUTES = parseInt(process.env.SEGMENT_MINUTES || '30', 10);

// Web UI passphrase gate (separate from AUTH_TOKEN, which guards the device
// WebSocket streams). Not a substitute for real user accounts — good enough
// for a single-household monitor.
const UI_PASSPHRASE = process.env.UI_PASSPHRASE || 'osho';
const UI_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const uiTokens = new Map(); // token -> issuedAt ms

const S3_BUCKET = process.env.AUDIO_STREAMS_BUCKET || 'audio-streams-725925681354';
const S3_REGION = process.env.AWS_REGION || 'us-east-1';
const s3 = new S3Client({ region: S3_REGION });

const clients = new Set();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ---------------------------------------------------------------------------
// Web UI passphrase auth
// ---------------------------------------------------------------------------
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function issueUiToken() {
  const token = crypto.randomBytes(24).toString('hex');
  uiTokens.set(token, Date.now());
  return token;
}

function requestToken(req, url) {
  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return bearer || url.searchParams.get('token') || '';
}

function checkUiAuth(req, url) {
  const token = requestToken(req, url);
  if (!token) return false;
  const issuedAt = uiTokens.get(token);
  if (!issuedAt) return false;
  if (Date.now() - issuedAt > UI_TOKEN_TTL_MS) {
    uiTokens.delete(token);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// S3-backed recordings: uploaded here as each segment finalizes, and the web
// UI's file list/playback/delete all read from the bucket, not local disk.
// ---------------------------------------------------------------------------
// Uploads live in pipeline.js — a finished segment is transcribed, PUT with a
// SHA-256 the bucket validates, read back with HeadObject, and only then
// deleted from local disk.

// Duration probing for S3 objects — same header/tail math as the local-disk
// probes, but via ranged GETs. Objects are immutable once uploaded, so cache
// by key forever; only files never seen before cost a request.
const s3DurationCache = new Map(); // key -> seconds | null

function opusDurationFromTail(buf) {
  const idx = buf.lastIndexOf('OggS');
  if (idx < 0 || idx + 14 > buf.length) return null;
  // Granule position = total 48 kHz samples up to the final page (pre-skip 0).
  return Number(buf.readBigUInt64LE(idx + 6)) / 48000;
}

function wavDurationFromHeader(buf, size) {
  if (size <= 44 || buf.length < 44) return 0;
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  if (!bytesPerSecond) return null;
  return (size - 44) / bytesPerSecond;
}

async function probeS3Duration(key, size) {
  if (s3DurationCache.has(key)) return s3DurationCache.get(key);
  let seconds = null;
  try {
    if (key.endsWith('.opus')) {
      const start = Math.max(0, size - 65536);
      const obj = await s3.send(new GetObjectCommand({
        Bucket: S3_BUCKET, Key: key, Range: `bytes=${start}-${size - 1}`,
      }));
      seconds = opusDurationFromTail(Buffer.from(await obj.Body.transformToByteArray()));
    } else if (key.endsWith('.wav')) {
      const obj = await s3.send(new GetObjectCommand({
        Bucket: S3_BUCKET, Key: key, Range: 'bytes=0-43',
      }));
      seconds = wavDurationFromHeader(Buffer.from(await obj.Body.transformToByteArray()), size);
    }
  } catch { /* unreadable — leave null */ }
  s3DurationCache.set(key, seconds);
  return seconds;
}

async function listS3Recordings() {
  const byDevice = new Map();
  // Transcripts are `<audio key>.json`, so FILE_RE already keeps them out of
  // the recordings list. Collect them in the same pass instead of discarding,
  // so flagging which recordings have text costs no extra S3 requests.
  const transcripts = new Set();
  let ContinuationToken;
  do {
    const resp = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, ContinuationToken }));
    for (const obj of resp.Contents || []) {
      const parts = obj.Key.split('/');
      if (parts.length !== 2) continue;
      const [deviceId, name] = parts;
      if (!DEVICE_RE.test(deviceId)) continue;
      if (name.endsWith('.json')) { transcripts.add(obj.Key); continue; }
      if (!FILE_RE.test(name)) continue;
      if (!byDevice.has(deviceId)) byDevice.set(deviceId, []);
      byDevice.get(deviceId).push({
        name,
        size: obj.Size,
        mtime: obj.LastModified ? new Date(obj.LastModified).toISOString() : null,
        duration: null,
        hasTranscript: false,
      });
    }
    ContinuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (ContinuationToken);

  for (const [deviceId, files] of byDevice) {
    for (const f of files) f.hasTranscript = transcripts.has(`${deviceId}/${f.name}.json`);
  }

  await Promise.all([...byDevice.entries()].flatMap(([deviceId, files]) =>
    files.map(async (f) => {
      f.duration = await probeS3Duration(`${deviceId}/${f.name}`, f.size);
    })
  ));

  const devices = [...byDevice.entries()]
    .map(([deviceId, files]) => ({
      deviceId,
      files: files.sort((a, b) => (b.mtime || '').localeCompare(a.mtime || '')),
    }))
    .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  return { devices };
}

// Transcripts are small and whole-file — no range handling, unlike the audio.
async function serveS3Transcript(res, device, file) {
  if (!DEVICE_RE.test(device) || !FILE_RE.test(file)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'bad path' }));
    return;
  }
  try {
    const obj = await s3.send(new GetObjectCommand({
      Bucket: S3_BUCKET, Key: `${device}/${file}.json`,
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(await obj.Body.transformToString());
  } catch (err) {
    const notFound = err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404;
    res.writeHead(notFound ? 404 : 500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: notFound ? 'no transcript' : err.message }));
  }
}

async function serveS3Recording(req, res, device, file) {
  const key = `${device}/${file}`;
  try {
    const obj = await s3.send(new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Range: req.headers.range,
    }));
    const headers = {
      'content-type': obj.ContentType || (file.endsWith('.wav') ? 'audio/wav' : 'audio/ogg'),
      'accept-ranges': 'bytes',
    };
    if (obj.ContentRange) headers['content-range'] = obj.ContentRange;
    if (obj.ContentLength != null) headers['content-length'] = obj.ContentLength;
    res.writeHead(req.headers.range ? 206 : 200, headers);
    obj.Body.pipe(res);
  } catch (err) {
    const notFound = err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404;
    res.writeHead(notFound ? 404 : 500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: notFound ? 'not found' : err.message }));
  }
}

// ---------------------------------------------------------------------------
// Live listen: relays the Ogg Opus pages of a currently-recording session
// straight to an HTTP response as they're muxed (chunked transfer — same
// trick Icecast uses), so <audio src="/api/live/:device"> just works. Only
// supported for opus sessions; the pcm16/WAV fallback has no equivalent tap.
// ---------------------------------------------------------------------------
function findLiveOpusSession(deviceId) {
  for (const c of clients) {
    if (c.hello && c.hello.deviceId === deviceId && c.hello.codec === 'opus' && c.sink) return c;
  }
  return null;
}

function serveLiveAudio(req, res, device) {
  const session = findLiveOpusSession(device);
  if (!session) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'device not live' }));
    return;
  }
  res.writeHead(200, {
    'content-type': 'audio/ogg',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const sink = session.sink;
  const listener = {
    write: (buf) => { if (!res.writableEnded) res.write(buf); },
    end: () => { if (!res.writableEnded) res.end(); },
  };
  sink.addListener(listener);
  req.on('close', () => sink.removeListener(listener));
}

async function deleteS3Recording(res, device, file) {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: `${device}/${file}` }));
    // Drop the transcript sibling too, or the bucket accumulates orphaned JSON
    // for audio that no longer exists.
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: `${device}/${file}.json` }))
      .catch(() => {});
    log(`deleted s3://${S3_BUCKET}/${device}/${file}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
}

// ---------------------------------------------------------------------------
// WAV sink for the pcm16 fallback codec.
// ---------------------------------------------------------------------------
class WavWriter {
  constructor(filePath, { sampleRate = 48000, channels = 1 } = {}) {
    this.fd = fs.openSync(filePath, 'w');
    this.filePath = filePath;
    this.dataBytes = 0;
    this.closed = false;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(0, 4); // patched on close
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * channels * 2, 28);
    header.writeUInt16LE(channels * 2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(0, 40); // patched on close
    fs.writeSync(this.fd, header);
  }

  writePacket(buf) {
    if (this.closed) return;
    fs.writeSync(this.fd, buf);
    this.dataBytes += buf.length;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const size = Buffer.alloc(4);
    size.writeUInt32LE(36 + this.dataBytes, 0);
    fs.writeSync(this.fd, size, 0, 4, 4);
    size.writeUInt32LE(this.dataBytes, 0);
    fs.writeSync(this.fd, size, 0, 4, 40);
    fs.closeSync(this.fd);
  }
}

// ---------------------------------------------------------------------------
// Per-connection state
// ---------------------------------------------------------------------------
class ClientSession {
  constructor(ws, remote) {
    this.ws = ws;
    this.remote = remote;
    this.hello = null;
    this.sink = null;
    this.rotateTimer = null;
    this.bytesReceived = 0;
    this.connectedAt = new Date();
  }

  get deviceId() {
    return this.hello ? this.hello.deviceId : '(no hello yet)';
  }

  handleHello(hello) {
    const codec = hello.codec === 'opus' ? 'opus' : 'pcm16';
    this.hello = {
      deviceId: String(hello.deviceId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
      codec,
      sampleRate: Number(hello.sampleRate) || 48000,
      channels: Number(hello.channels) || 1,
    };
    log(`[${this.hello.deviceId}] hello from ${this.remote} — codec=${codec}, ` +
        `${this.hello.sampleRate} Hz, ${this.hello.channels}ch`);
    if (SAVE_AUDIO) {
      this.openSink();
      if (SEGMENT_MINUTES > 0) {
        this.rotateTimer = setInterval(() => {
          log(`[${this.hello.deviceId}] rotating segment`);
          this.closeSink();
          this.openSink();
        }, SEGMENT_MINUTES * 60 * 1000);
      }
    }
    this.ws.send(JSON.stringify({ type: 'ack', saving: SAVE_AUDIO }));
  }

  openSink() {
    const dir = path.join(SAVE_DIR, this.hello.deviceId);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (this.hello.codec === 'opus') {
      const file = path.join(dir, `${stamp}.opus`);
      this.sink = new OggOpusWriter(file, { channels: this.hello.channels });
      log(`[${this.hello.deviceId}] recording → ${file}`);
    } else {
      const file = path.join(dir, `${stamp}.wav`);
      this.sink = new WavWriter(file, {
        sampleRate: this.hello.sampleRate,
        channels: this.hello.channels,
      });
      log(`[${this.hello.deviceId}] recording → ${file}`);
    }
  }

  closeSink() {
    if (this.sink) {
      const filePath = this.sink.filePath;
      this.sink.close();
      this.sink = null;
      pipeline.enqueue(this.hello.deviceId, filePath);
    }
  }

  // Binary bundles are repeated [uint16 BE length][frame] — an Opus packet or
  // a raw PCM16 chunk per frame.
  handleBinary(data) {
    if (!this.hello) return;
    this.bytesReceived += data.length;
    let offset = 0;
    while (offset + 2 <= data.length) {
      const length = data.readUInt16BE(offset);
      offset += 2;
      if (offset + length > data.length) break;
      const frame = data.subarray(offset, offset + length);
      offset += length;
      if (this.sink) this.sink.writePacket(frame);
    }
  }

  end() {
    clearInterval(this.rotateTimer);
    this.closeSink();
    log(`[${this.deviceId}] disconnected (${this.bytesReceived} bytes received)`);
  }
}

// ---------------------------------------------------------------------------
// Web UI: recording browser + playback
// ---------------------------------------------------------------------------
const WAV_CACHE = path.join(SAVE_DIR, '.wav-cache');
const transcodesInFlight = new Map();

const DEVICE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FILE_RE = /^[A-Za-z0-9._-]+\.(opus|wav)$/;

function liveFilePaths() {
  const live = new Set();
  for (const c of clients) {
    if (c.sink && c.sink.filePath) live.add(c.sink.filePath);
  }
  return live;
}

// Duration probing — cheap header/tail reads, cached by (size, mtime) so the
// UI's polling never re-reads unchanged files.
const durationCache = new Map(); // path -> { size, mtimeMs, seconds }

function opusDurationSeconds(filePath, size) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const len = Math.min(size, 65536);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const idx = buf.lastIndexOf('OggS');
    if (idx < 0 || idx + 14 > len) return null;
    // Granule position = total 48 kHz samples up to this page (pre-skip 0).
    return Number(buf.readBigUInt64LE(idx + 6)) / 48000;
  } finally {
    fs.closeSync(fd);
  }
}

function wavDurationSeconds(filePath, size) {
  if (size <= 44) return 0;
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(44);
    fs.readSync(fd, header, 0, 44, 0);
    const channels = header.readUInt16LE(22);
    const sampleRate = header.readUInt32LE(24);
    const bitsPerSample = header.readUInt16LE(34);
    const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
    if (!bytesPerSecond) return null;
    return (size - 44) / bytesPerSecond;
  } finally {
    fs.closeSync(fd);
  }
}

function fileDuration(filePath, stat) {
  const cached = durationCache.get(filePath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.seconds;
  }
  let seconds = null;
  try {
    if (filePath.endsWith('.opus')) seconds = opusDurationSeconds(filePath, stat.size);
    else if (filePath.endsWith('.wav')) seconds = wavDurationSeconds(filePath, stat.size);
  } catch { /* unreadable — leave null */ }
  durationCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, seconds });
  return seconds;
}

function listRecordings() {
  const live = liveFilePaths();
  const onlineIds = new Set([...clients].map((c) => c.deviceId));
  const devices = [];
  let deviceDirs = [];
  try {
    deviceDirs = fs.readdirSync(SAVE_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && DEVICE_RE.test(e.name));
  } catch {
    return { devices };
  }
  for (const dir of deviceDirs) {
    const dirPath = path.join(SAVE_DIR, dir.name);
    const files = fs.readdirSync(dirPath)
      .filter((f) => FILE_RE.test(f))
      .map((f) => {
        const filePath = path.join(dirPath, f);
        const stat = fs.statSync(filePath);
        return {
          name: f,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          duration: fileDuration(filePath, stat),
          live: live.has(filePath),
        };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
    if (files.length) {
      devices.push({ deviceId: dir.name, online: onlineIds.has(dir.name), files });
    }
  }
  devices.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  return { devices };
}

function serveFileWithRanges(req, res, filePath, contentType) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const range = req.headers.range;
  const headers = { 'content-type': contentType, 'accept-ranges': 'bytes' };
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? Math.min(parseInt(match[2], 10), stat.size - 1) : stat.size - 1;
      if (start <= end && start < stat.size) {
        headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
        headers['content-length'] = end - start + 1;
        res.writeHead(206, headers);
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }
    res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
    res.end();
    return;
  }
  headers['content-length'] = stat.size;
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

// Transcode .opus → .wav once per file (cached; re-done if source grew).
function ensureWavCache(srcPath, cachePath) {
  const existing = transcodesInFlight.get(cachePath);
  if (existing) return existing;
  const promise = new Promise((resolve, reject) => {
    try {
      const srcStat = fs.statSync(srcPath);
      const cacheStat = fs.statSync(cachePath);
      if (cacheStat.mtimeMs >= srcStat.mtimeMs) return resolve();
    } catch { /* cache miss — transcode below */ }
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const ffmpeg = spawn('ffmpeg', ['-y', '-v', 'error', '-i', srcPath, cachePath]);
    let stderr = '';
    ffmpeg.stderr.on('data', (d) => { stderr += d; });
    ffmpeg.on('error', (err) => reject(new Error(`ffmpeg not available: ${err.message}`)));
    ffmpeg.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (${code}): ${stderr.slice(0, 300)}`));
    });
  }).finally(() => transcodesInFlight.delete(cachePath));
  transcodesInFlight.set(cachePath, promise);
  return promise;
}

function serveRecording(req, res, url) {
  const parts = url.pathname.split('/').map(decodeURIComponent);
  // Expected: ['', 'rec', device, file]
  const device = parts[2] || '';
  const file = parts[3] || '';
  if (parts.length !== 4 || !DEVICE_RE.test(device) || !FILE_RE.test(file)) {
    res.writeHead(400);
    res.end('bad path');
    return;
  }
  const filePath = path.join(SAVE_DIR, device, file);
  if (!filePath.startsWith(path.resolve(SAVE_DIR) + path.sep)) {
    res.writeHead(400);
    res.end('bad path');
    return;
  }
  if (req.method === 'DELETE') {
    if (liveFilePaths().has(filePath)) {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'recording in progress' }));
      return;
    }
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
      return;
    }
    try {
      fs.unlinkSync(path.join(WAV_CACHE, device, `${file}.wav`));
    } catch { /* no cached transcode */ }
    try {
      fs.unlinkSync(path.join(SAVE_DIR, device, `${file}.json`));
    } catch { /* no local transcript */ }
    log(`deleted recording ${device}/${file}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.searchParams.get('fmt') === 'wav' && file.endsWith('.opus')) {
    const cachePath = path.join(WAV_CACHE, device, `${file}.wav`);
    ensureWavCache(filePath, cachePath)
      .then(() => serveFileWithRanges(req, res, cachePath, 'audio/wav'))
      .catch((err) => {
        log(`transcode error: ${err.message}`);
        res.writeHead(501, { 'content-type': 'text/plain' });
        res.end(`transcode unavailable: ${err.message}`);
      });
    return;
  }
  const contentType = file.endsWith('.wav') ? 'audio/wav' : 'audio/ogg';
  serveFileWithRanges(req, res, filePath, contentType);
}

// ---------------------------------------------------------------------------
// HTTP endpoints + WebSocket server
// ---------------------------------------------------------------------------
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');
const STATIC_RE = /\.(js|mjs|css|svg|png|jpg|ico|json|woff2?|map)$/i;
const MIME_TYPES = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.json': 'application/json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json',
};

function serveStatic(res, pathname) {
  const filePath = path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) {
    res.writeHead(400);
    res.end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME_TYPES[ext] || 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
    });
    res.end(data);
  });
}

function readJsonBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (err) {
        reject(err);
      }
    });
  });
}

const S3_REC_RE = /^\/api\/s3\/rec\/([^/]+)\/([^/]+)$/;
const S3_TRANSCRIPT_RE = /^\/api\/s3\/transcript\/([^/]+)\/([^/]+)$/;
const LIVE_RE = /^\/api\/live\/([^/]+)$/;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  // ---- public routes: app shell, static assets, login ----
  if (req.method === 'GET' && pathname === '/') {
    fs.readFile(INDEX_HTML, (err, html) => {
      if (err) {
        res.writeHead(500);
        res.end('index.html missing');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
      });
      res.end(html);
    });
    return;
  }
  if (req.method === 'GET' && STATIC_RE.test(pathname)) {
    serveStatic(res, pathname);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/login') {
    readJsonBody(req)
      .then(({ passphrase }) => {
        if (typeof passphrase !== 'string' || !safeEqual(passphrase, UI_PASSPHRASE)) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid passphrase' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, token: issueUiToken() }));
      })
      .catch(() => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad request' }));
      });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/logout') {
    uiTokens.delete(requestToken(req, url));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ---- everything below requires a valid UI session token ----
  if (!checkUiAuth(req, url)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    return;
  }

  if (req.method === 'DELETE') {
    const s3Match = S3_REC_RE.exec(pathname);
    if (s3Match) {
      deleteS3Recording(res, decodeURIComponent(s3Match[1]), decodeURIComponent(s3Match[2]));
      return;
    }
    if (pathname.startsWith('/rec/')) {
      serveRecording(req, res, url);
      return;
    }
    res.writeHead(405);
    res.end();
    return;
  }

  if (req.method === 'POST' && pathname === '/api/command') {
    readJsonBody(req)
      .then(({ deviceId, action }) => {
        if (!['start', 'stop', 'restart'].includes(action)) throw new Error('bad action');
        const delivered = sendCommand(String(deviceId), action);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, delivered }));
      })
      .catch((err) => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end();
    return;
  }

  if (pathname === '/status') {
    const devices = [...clients].map((c) => ({
      deviceId: c.deviceId,
      codec: c.hello ? c.hello.codec : null,
      remote: c.remote,
      connectedAt: c.connectedAt.toISOString(),
      bytesReceived: c.bytesReceived,
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, saving: SAVE_AUDIO, devices }, null, 2));
    return;
  }
  if (pathname === '/api/recordings') {
    const payload = listRecordings();
    payload.controls = [...controlDevices.entries()].map(([deviceId, entry]) => ({
      deviceId,
      monitoring: entry.monitoring,
      connected: entry.ws.readyState === entry.ws.OPEN,
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }
  if (pathname === '/api/controls') {
    const controls = [...controlDevices.entries()].map(([deviceId, entry]) => ({
      deviceId,
      monitoring: entry.monitoring,
      connected: entry.ws.readyState === entry.ws.OPEN,
    }));
    const live = [...clients]
      .filter((c) => c.hello && c.sink)
      .map((c) => ({ deviceId: c.hello.deviceId, codec: c.hello.codec }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, controls, live }));
    return;
  }
  const liveMatch = LIVE_RE.exec(pathname);
  if (liveMatch) {
    serveLiveAudio(req, res, decodeURIComponent(liveMatch[1]));
    return;
  }
  if (pathname === '/api/s3/recordings') {
    listS3Recordings()
      .then((payload) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...payload }));
      })
      .catch((err) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    return;
  }
  const s3GetMatch = S3_REC_RE.exec(pathname);
  if (s3GetMatch) {
    serveS3Recording(req, res, decodeURIComponent(s3GetMatch[1]), decodeURIComponent(s3GetMatch[2]));
    return;
  }
  const transcriptMatch = S3_TRANSCRIPT_RE.exec(pathname);
  if (transcriptMatch) {
    serveS3Transcript(res, decodeURIComponent(transcriptMatch[1]), decodeURIComponent(transcriptMatch[2]));
    return;
  }
  if (pathname.startsWith('/rec/')) {
    serveRecording(req, res, url);
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

// ---------------------------------------------------------------------------
// Control channel: devices keep a socket open on /control from app launch so
// the web UI can command start / stop / restart even while idle.
// ---------------------------------------------------------------------------
const controlDevices = new Map(); // deviceId -> { ws, monitoring, connectedAt }

function sendCommand(deviceId, action) {
  const entry = controlDevices.get(deviceId);
  if (!entry || entry.ws.readyState !== entry.ws.OPEN) return false;
  entry.ws.send(JSON.stringify({ type: 'command', action }));
  log(`sent '${action}' command to ${deviceId}`);
  return true;
}

const controlWss = new WebSocketServer({ noServer: true });

controlWss.on('connection', (ws, req) => {
  let deviceId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'hello' && msg.role === 'control') {
        deviceId = String(msg.deviceId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        controlDevices.set(deviceId, { ws, monitoring: false, connectedAt: new Date() });
        log(`control channel connected: ${deviceId}`);
      } else if (msg.type === 'status' && deviceId) {
        const entry = controlDevices.get(deviceId);
        if (entry) entry.monitoring = !!msg.monitoring;
      }
    } catch { /* ignore malformed */ }
  });
  ws.on('close', () => {
    // Keep the entry (marked offline via ws.readyState) instead of deleting it,
    // so the device stays visible/reconnectable in the UI even with no
    // recordings left to key its row off of.
    if (deviceId && controlDevices.get(deviceId)?.ws === ws) {
      log(`control channel closed: ${deviceId}`);
    }
  });
  ws.on('error', () => {});
});

const wss = new WebSocketServer({ noServer: true });

function authorized(req) {
  if (!AUTH_TOKEN) return true;
  const url = new URL(req.url, 'http://localhost');
  const token = req.headers['x-auth-token'] || url.searchParams.get('token') || '';
  return token === AUTH_TOKEN;
}

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (!authorized(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  if (pathname === '/stream') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (pathname === '/control') {
    controlWss.handleUpgrade(req, socket, head, (ws) => controlWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  const remote = `${req.socket.remoteAddress}:${req.socket.remotePort}`;

  if (AUTH_TOKEN) {
    const url = new URL(req.url, 'http://localhost');
    const token = req.headers['x-auth-token'] || url.searchParams.get('token') || '';
    if (token !== AUTH_TOKEN) {
      log(`rejected unauthorized connection from ${remote}`);
      ws.close(4001, 'unauthorized');
      return;
    }
  }

  const session = new ClientSession(ws, remote);
  clients.add(session);
  ws.isAlive = true;
  log(`connection from ${remote}`);

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      session.handleBinary(data);
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'hello') session.handleHello(msg);
    } catch {
      log(`[${session.deviceId}] ignoring malformed text message`);
    }
  });

  ws.on('close', () => {
    clients.delete(session);
    session.end();
  });

  ws.on('error', (err) => log(`[${session.deviceId}] socket error: ${err.message}`));
});

// Drop dead connections so files get finalized even after silent link loss.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30 * 1000);

wss.on('close', () => clearInterval(heartbeat));

// Shutdown must outlive the uploads it starts. `session.end()` only closes the
// sinks and queues them; exiting here without draining would leave the final
// segment on local disk and out of S3 on every deploy. Bounded so a wedged
// bucket can't hold the container open past its stop grace period — anything
// left behind is picked up by the next reconcile.
const SHUTDOWN_DRAIN_MS = parseInt(process.env.SHUTDOWN_DRAIN_MS || '45000', 10);

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('shutting down, finalizing recordings…');
    for (const session of clients) session.end();
    const timedOut = Symbol('timeout');
    const result = await Promise.race([
      pipeline.drain(),
      new Promise((r) => setTimeout(() => r(timedOut), SHUTDOWN_DRAIN_MS)),
    ]);
    if (result === timedOut) log('drain timed out — leftovers stay local for reconcile');
    process.exit(0);
  });
}

pipeline.init({ s3, S3_BUCKET, SAVE_DIR, log, liveFilePaths });

server.listen(PORT, () => {
  log(`GuidedVoiceMonitor server listening on :${PORT}`);
  log(`  WebSocket endpoint : ws://<this-host>:${PORT}/stream`);
  log(`  Status endpoint    : http://<this-host>:${PORT}/status`);
  log(`  Saving audio       : ${SAVE_AUDIO ? SAVE_DIR : 'disabled (SAVE_AUDIO=0)'}`);
  log(`  Auth token         : ${AUTH_TOKEN ? 'required' : 'not required'}`);
  log(`  Segment length     : ${SEGMENT_MINUTES} min`);
  // Sweep up whatever the last process left behind before taking new audio.
  pipeline.reconcile().catch((err) => log(`reconcile failed: ${err.message}`));
});
