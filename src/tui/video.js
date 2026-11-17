/** Plays a video inside the terminal: ffmpeg decodes frames, and an image protocol shows them. */

import { spawn } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { itermImage } from './image.js';

export const FPS = 15;
const IDS = [0x7ff00001, 0x7ff00002];

/** Resolves true when `cmd -version` runs. */
export function hasCommand(cmd) {
  return new Promise((done) => {
    const p = spawn(cmd, ['-version'], { stdio: 'ignore' });
    p.on('error', () => done(false));
    p.on('close', (code) => done(code === 0));
  });
}

/** One raw RGB frame for a kitty-protocol terminal, zlib-compressed, shown at the cursor. */
export function kittyFrame(id, rgb, w, h, cols, rows) {
  const b64 = deflateSync(rgb, { level: 1 }).toString('base64');
  const parts = [];
  for (let i = 0; i < b64.length; i += 4096) parts.push(b64.slice(i, i + 4096));
  return parts
    .map((chunk, n) => {
      const more = n < parts.length - 1 ? 1 : 0;
      const keys = n === 0 ? `a=T,f=24,s=${w},v=${h},o=z,i=${id},p=1,c=${cols},r=${rows},C=1,q=2,m=${more}` : `q=2,m=${more}`;
      return `\x1b_G${keys};${chunk}\x1b\\`;
    })
    .join('');
}

const kittyDelete = (id) => `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`;

/** Splits a stream of JPEG images (ffmpeg mjpeg image2pipe) into single images. */
export function jpegSplitter(onImage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const start = buf.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        buf = Buffer.alloc(0);
        return;
      }
      const end = buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) {
        buf = buf.subarray(start);
        return;
      }
      onImage(buf.subarray(start, end + 2));
      buf = buf.subarray(end + 2);
    }
  };
}

/** Splits a stream of raw frames of a fixed size. */
export function rawSplitter(size, onFrame) {
  let parts = [];
  let have = 0;
  return (chunk) => {
    parts.push(chunk);
    have += chunk.length;
    while (have >= size) {
      const all = Buffer.concat(parts);
      onFrame(all.subarray(0, size));
      const rest = all.subarray(size);
      parts = rest.length ? [rest] : [];
      have = rest.length;
    }
  };
}

/**
 * Plays one clip. `input(seconds)` returns the ffmpeg input arguments that
 * start at that time. `audio(seconds)` returns ffplay arguments, or null for
 * no sound. `box` is the screen area in cells, `size` the frame size in pixels.
 */
export class VideoPlayer {
  constructor({ input, audio = null, protocol, write, canWrite = () => true, box, size, duration, onChange = () => {}, spawnFn = spawn }) {
    Object.assign(this, { input, audio, protocol, write, canWrite, box, size, duration, onChange, spawnFn });
    this.pos = 0;
    this.playing = false;
    this.ended = false;
    this.muted = false;
    this.error = null;
    this.noSound = !audio;
    this.flip = 0;
    this.last = null;
  }

  play() {
    if (this.ended || this.pos >= this.duration - 0.2) this.pos = 0;
    this.ended = false;
    this.stopProcs();
    this.playing = true;
    this.startVideo(this.pos, false);
    this.startAudio(this.pos);
    this.onChange();
  }

  pause() {
    this.stopProcs();
    this.playing = false;
    this.onChange();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(delta) {
    this.pos = Math.max(0, Math.min(Math.max(0, this.duration - 0.5), this.pos + delta));
    this.ended = false;
    if (this.playing) this.play();
    else {
      this.stopProcs();
      this.startVideo(this.pos, true);
      this.onChange();
    }
  }

  toggleMute() {
    if (this.noSound) return;
    this.muted = !this.muted;
    if (this.muted) this.stopAudio();
    else if (this.playing) this.startAudio(this.pos);
    this.onChange();
  }

  startVideo(from, single) {
    const { w, h } = this.size;
    const kitty = this.protocol === 'kitty';
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      ...(single ? [] : ['-re']),
      ...this.input(from),
      '-an',
      '-vf',
      `fps=${FPS},scale=${w}:${h}`,
      ...(single ? ['-frames:v', '1'] : []),
      ...(kitty ? ['-f', 'rawvideo', '-pix_fmt', 'rgb24'] : ['-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '4']),
      'pipe:1',
    ];
    const proc = this.spawnFn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    let frames = 0;
    let stderr = '';
    const onFrame = (frame) => {
      if (proc !== this.proc) return;
      if (!single) {
        frames++;
        this.pos = Math.min(this.duration, from + frames / FPS);
      }
      this.show(Buffer.from(frame), single);
    };
    proc.stdout.on('data', kitty ? rawSplitter(w * h * 3, onFrame) : jpegSplitter(onFrame));
    proc.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-2000);
    });
    proc.on('error', (e) => {
      if (proc !== this.proc) return;
      this.proc = null;
      this.playing = false;
      this.error = e.code === 'ENOENT' ? 'Inline video needs ffmpeg. Install it, or press o to open the clip in your browser.' : e.message;
      this.onChange();
    });
    proc.on('close', (code) => {
      if (proc !== this.proc) return;
      this.proc = null;
      if (code === 0 && !single) {
        this.playing = false;
        this.ended = true;
        this.pos = this.duration;
        this.stopAudio();
      } else if (code !== 0) {
        this.playing = false;
        this.stopAudio();
        this.error = stderr.trim().split('\n').pop() || `ffmpeg stopped (exit ${code}).`;
      }
      this.onChange();
    });
  }

  startAudio(from) {
    if (this.noSound || this.muted) return;
    this.stopAudio();
    const args = this.audio(from);
    if (!args) return;
    const proc = this.spawnFn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-vn', ...args], { stdio: 'ignore' });
    this.audioProc = proc;
    proc.on('error', () => {
      this.noSound = true;
      this.onChange();
    });
  }

  stopAudio() {
    this.audioProc?.kill('SIGKILL');
    this.audioProc = null;
  }

  stopProcs() {
    const p = this.proc;
    this.proc = null;
    p?.kill('SIGKILL');
    this.stopAudio();
  }

  show(frame, force = false) {
    if (!force && !this.canWrite()) return;
    const { row, col, cols, rows } = this.box;
    let out = `\x1b[?2026h\x1b[${row + 1};${col + 1}H`;
    if (this.protocol === 'kitty') {
      const id = IDS[this.flip];
      this.flip = 1 - this.flip;
      out += kittyFrame(id, frame, this.size.w, this.size.h, cols, rows) + kittyDelete(IDS[this.flip]);
    } else {
      out += itermImage(frame, cols, rows);
    }
    this.write(`${out}\x1b[?2026l`);
    this.last = frame;
  }

  /** Draws the last frame again, for example after the text under it changed. */
  redraw() {
    if (this.last) this.show(this.last, true);
  }

  close() {
    this.stopProcs();
    this.playing = false;
    if (this.protocol === 'kitty') this.write(IDS.map(kittyDelete).join(''));
  }
}
