'use strict';

// Simulates the iPad app without an iPad: connects, sends a hello, then
// streams 5 seconds of a 440 Hz sine as pcm16 frames using the same
// length-prefixed wire protocol. Verify with: ffplay recordings/<id>/<ts>.wav

const WebSocket = require('ws');

const URL = process.env.URL || 'ws://localhost:8080/stream';
const TOKEN = process.env.AUTH_TOKEN || '';
const SAMPLE_RATE = 48000;
const CHUNK_SAMPLES = 4800; // 100 ms
const SECONDS = 5;

const ws = new WebSocket(URL, TOKEN ? { headers: { 'x-auth-token': TOKEN } } : {});

ws.on('open', () => {
  console.log('connected, sending hello');
  ws.send(JSON.stringify({
    type: 'hello',
    deviceId: 'test-client',
    codec: 'pcm16',
    sampleRate: SAMPLE_RATE,
    channels: 1,
  }));

  let sent = 0;
  let phase = 0;
  const interval = setInterval(() => {
    const pcm = Buffer.alloc(CHUNK_SAMPLES * 2);
    for (let i = 0; i < CHUNK_SAMPLES; i++) {
      pcm.writeInt16LE(Math.round(Math.sin(phase) * 12000), i * 2);
      phase += (2 * Math.PI * 440) / SAMPLE_RATE;
    }
    const frame = Buffer.alloc(2 + pcm.length);
    frame.writeUInt16BE(pcm.length, 0);
    pcm.copy(frame, 2);
    ws.send(frame);
    sent++;
    if (sent >= SECONDS * 10) {
      clearInterval(interval);
      console.log(`sent ${sent} chunks (${SECONDS}s), closing`);
      ws.close(1000);
    }
  }, 100);
});

ws.on('message', (data) => console.log('server:', data.toString()));
ws.on('close', () => process.exit(0));
ws.on('error', (err) => {
  console.error('error:', err.message);
  process.exit(1);
});
