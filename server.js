'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { OggOpusWriter } = require('./oggopus');

const PORT = parseInt(process.env.PORT || '8080', 10);
const SAVE_AUDIO = process.env.SAVE_AUDIO !== '0';
const SAVE_DIR = process.env.SAVE_DIR || path.join(__dirname, 'recordings');
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const SEGMENT_MINUTES = parseInt(process.env.SEGMENT_MINUTES || '30', 10);

const clients = new Set();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
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
      this.sink.close();
      this.sink = null;
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
const INDEX_HTML = path.join(__dirname, 'public', 'index.html');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'DELETE') {
    if (url.pathname.startsWith('/rec/')) {
      serveRecording(req, res, url);
    } else {
      res.writeHead(405);
      res.end();
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/command') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4096) req.destroy();
    });
    req.on('end', () => {
      try {
        const { deviceId, action } = JSON.parse(body);
        if (!['start', 'stop', 'restart'].includes(action)) throw new Error('bad action');
        const delivered = sendCommand(String(deviceId), action);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, delivered }));
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end();
    return;
  }
  if (url.pathname === '/') {
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
  if (url.pathname === '/status') {
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
  if (url.pathname === '/api/recordings') {
    const payload = listRecordings();
    payload.controls = [...controlDevices.entries()].map(([deviceId, entry]) => ({
      deviceId,
      monitoring: entry.monitoring,
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }
  if (url.pathname.startsWith('/rec/')) {
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
    if (deviceId && controlDevices.get(deviceId)?.ws === ws) {
      controlDevices.delete(deviceId);
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

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('shutting down, finalizing recordings…');
    for (const session of clients) session.end();
    process.exit(0);
  });
}

server.listen(PORT, () => {
  log(`GuidedVoiceMonitor server listening on :${PORT}`);
  log(`  WebSocket endpoint : ws://<this-host>:${PORT}/stream`);
  log(`  Status endpoint    : http://<this-host>:${PORT}/status`);
  log(`  Saving audio       : ${SAVE_AUDIO ? SAVE_DIR : 'disabled (SAVE_AUDIO=0)'}`);
  log(`  Auth token         : ${AUTH_TOKEN ? 'required' : 'not required'}`);
  log(`  Segment length     : ${SEGMENT_MINUTES} min`);
});
