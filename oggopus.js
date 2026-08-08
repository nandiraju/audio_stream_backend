'use strict';

const fs = require('fs');
const crypto = require('crypto');

// Ogg page CRC: polynomial 0x04c11db7, init 0, no reflection, no final xor.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = (i << 24) >>> 0;
    for (let j = 0; j < 8; j++) {
      r = (r & 0x80000000) ? (((r << 1) ^ 0x04c11db7) >>> 0) : ((r << 1) >>> 0);
    }
    table[i] = r;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc = (((crc << 8) >>> 0) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  }
  return crc;
}

// Number of 48 kHz samples in one Opus packet, derived from the TOC byte (RFC 6716 §3.1).
function packetSamples(packet) {
  if (packet.length === 0) return 0;
  const toc = packet[0];
  const config = toc >> 3;
  let frameMs;
  if (config < 12) frameMs = [10, 20, 40, 60][config & 3];        // SILK
  else if (config < 16) frameMs = [10, 20][config & 1];           // Hybrid
  else frameMs = [2.5, 5, 10, 20][config & 3];                    // CELT
  const code = toc & 3;
  let frames;
  if (code === 0) frames = 1;
  else if (code === 3) frames = packet.length >= 2 ? (packet[1] & 0x3f) : 0;
  else frames = 2;
  return Math.round(frameMs * 48 * frames);
}

/**
 * Minimal Ogg Opus muxer — writes standard .opus files playable by
 * ffmpeg/VLC/browsers. One packet per page (simple and robust; ~27 bytes of
 * overhead per 20 ms packet, irrelevant for storage).
 */
class OggOpusWriter {
  constructor(filePath, { channels = 1, inputSampleRate = 48000 } = {}) {
    this.fd = fs.openSync(filePath, 'w');
    this.filePath = filePath;
    this.serial = crypto.randomBytes(4).readUInt32LE(0);
    this.seq = 0;
    this.granule = 0n;
    this.pending = null;
    this.closed = false;

    const head = Buffer.alloc(19);
    head.write('OpusHead', 0);
    head[8] = 1;                              // version
    head[9] = channels;
    head.writeUInt16LE(0, 10);                // pre-skip
    head.writeUInt32LE(inputSampleRate, 12);
    head.writeInt16LE(0, 16);                 // output gain
    head[18] = 0;                             // mapping family
    this._writePage(head, { bos: true, granule: 0n });

    const vendor = Buffer.from('guided-voice-monitor');
    const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
    tags.write('OpusTags', 0);
    tags.writeUInt32LE(vendor.length, 8);
    vendor.copy(tags, 12);
    tags.writeUInt32LE(0, 12 + vendor.length); // zero user comments
    this._writePage(tags, { granule: 0n });
  }

  writePacket(packet) {
    if (this.closed) return;
    // Hold one packet back so the final page can carry the EOS flag on close.
    if (this.pending) this._flushPending(false);
    this.pending = Buffer.from(packet);
  }

  close() {
    if (this.closed) return;
    if (this.pending) this._flushPending(true);
    this.closed = true;
    fs.closeSync(this.fd);
  }

  _flushPending(eos) {
    const packet = this.pending;
    this.pending = null;
    this.granule += BigInt(packetSamples(packet));
    this._writePage(packet, { eos, granule: this.granule });
  }

  _writePage(payload, { bos = false, eos = false, granule = 0n } = {}) {
    const segments = [];
    let remaining = payload.length;
    while (remaining >= 255) {
      segments.push(255);
      remaining -= 255;
    }
    segments.push(remaining);

    const header = Buffer.alloc(27 + segments.length);
    header.write('OggS', 0);
    header[4] = 0;                                  // stream structure version
    header[5] = (bos ? 0x02 : 0) | (eos ? 0x04 : 0);
    header.writeBigUInt64LE(BigInt(granule), 6);
    header.writeUInt32LE(this.serial, 14);
    header.writeUInt32LE(this.seq++, 18);
    header.writeUInt32LE(0, 22);                    // CRC placeholder
    header[26] = segments.length;
    Buffer.from(segments).copy(header, 27);

    const page = Buffer.concat([header, payload]);
    page.writeUInt32LE(crc32(page), 22);
    fs.writeSync(this.fd, page);
  }
}

module.exports = { OggOpusWriter, packetSamples };
