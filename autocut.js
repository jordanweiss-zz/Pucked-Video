// Finding the dead time in a game (Auto-Cut) and saving a condensed copy without it.
// Two things point at stoppages: the referee's whistle in the sound, and the XBotGo camera
// holding still (its .track log has the pan angle about 20 times a second).
// The renderer turns those into cut parts with the user's settings; this file only measures.
const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

// --- Camera movement from the XBotGo .track log ---

// How far the camera turned in each second of the video, in degrees (null where the log has a gap).
function trackMotion(videoPath) {
  const { dir, name } = path.parse(videoPath);
  const file = path.join(dir, '.data', `${name}.track`);
  if (!fs.existsSync(file)) return null;
  const re = /^UTC(\d+):(\d+):([\d.]+).*?Frame\d+ Yaw(-?[\d.]+)/;
  const lo = [];
  const hi = [];
  let t0 = null;
  for (const line of fs.readFileSync(file, 'latin1').split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    let t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    t0 ??= t;
    if (t < t0) t += 86400; // the game went past midnight
    const s = Math.floor(t - t0);
    const yaw = Number(m[4]);
    lo[s] = Math.min(lo[s] ?? yaw, yaw);
    hi[s] = Math.max(hi[s] ?? yaw, yaw);
  }
  return Array.from({ length: hi.length }, (_, s) => (hi[s] === undefined ? null : Number((hi[s] - lo[s]).toFixed(2))));
}

// --- Whistles in the sound ---

const RATE = 16000;
const N = 1024; // 64 ms per frame
const HOP = 512; // a frame every 32 ms
const BAND = [Math.round((2000 * N) / RATE), Math.round((4500 * N) / RATE)]; // where whistles ring

// In-place radix-2 FFT on re/im arrays of length N.
function fft(re, im) {
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

const hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));

// For each 32 ms frame: how much one pitch in the whistle band stands out (tone) and how loud the band is.
// A whistle is a loud, steady, high pitch; skates, sticks and the crowd spread over many pitches.
function frameScore(buf, re, im) {
  for (let i = 0; i < N; i++) { re[i] = buf[i] * hann[i]; im[i] = 0; }
  fft(re, im);
  let peak = 0, peakBin = 0, sum = 0, all = 0;
  for (let k = 1; k < N / 2; k++) {
    const p = re[k] * re[k] + im[k] * im[k];
    all += p;
    if (k >= BAND[0] && k <= BAND[1]) {
      sum += p;
      if (p > peak) { peak = p; peakBin = k; }
    }
  }
  // Count the peak with its neighbours: a whistle's pitch wobbles across a bin or two.
  const near = peak + (re[peakBin - 1] ** 2 + im[peakBin - 1] ** 2) + (re[peakBin + 1] ** 2 + im[peakBin + 1] ** 2);
  const mean = (sum - near) / (BAND[1] - BAND[0] - 2) || 1e-12;
  return { tone: near / 3 / mean, share: all ? sum / all : 0, band: sum, hz: (peakBin * RATE) / N };
}

// Read the sound with ffmpeg and score every frame. Returns per-frame arrays.
function scanSound(videoPath, onProgress, job) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-nostats', '-i', videoPath, '-vn', '-sn', '-ac', '1', '-ar', String(RATE),
      '-f', 'f32le', 'pipe:1'], { windowsHide: true });
    job.child = child;
    const tone = [], share = [], band = [], hz = [];
    const re = new Float64Array(N), im = new Float64Array(N);
    let carry = new Float32Array(0);
    let duration = 0, err = '', frames = 0;
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-4000);
      const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(String(d));
      if (m) duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    });
    child.stdout.on('data', (d) => {
      // Samples can be split across chunks, so keep what's left over for the next one.
      const bytes = Buffer.concat([Buffer.from(carry.buffer, carry.byteOffset, carry.byteLength), d]);
      const n = Math.floor(bytes.length / 4);
      const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + n * 4));
      let i = 0;
      for (; i + N <= samples.length; i += HOP) {
        const s = frameScore(samples.subarray(i, i + N), re, im);
        tone.push(s.tone); share.push(s.share); band.push(s.band); hz.push(s.hz);
        frames += 1;
      }
      carry = samples.slice(i);
      if (duration && frames % 300 === 0) onProgress(Math.min(1, (frames * HOP) / RATE / duration));
    });
    child.on('close', (code) => {
      job.child = null;
      if (job.cancelled) reject(new Error('cancelled'));
      else if (code === 0) resolve({ tone, share, band, hz, duration });
      // A video with no sound: nothing to listen to, so only the camera log is used.
      else if (/does not contain any stream|matches no streams/.test(err)) resolve({ tone, share, band, hz, duration, silent: true });
      else reject(new Error(err.trim().split('\n').pop() || `ffmpeg stopped (exit code ${code})`));
    });
  });
}

// Whistle times from the frame scores. A whistle is at least ~0.3 s of a clear tone that is
// louder than the usual rink noise around it.
function findWhistles({ tone, share, band, hz }) {
  const sec = HOP / RATE;
  // The usual band loudness over the last ~10 s, so a loud crowd doesn't count as a whistle.
  const floor = [];
  const win = Math.round(10 / sec);
  const sorted = [];
  for (let i = 0; i < band.length; i += win) {
    const part = band.slice(i, i + win).slice().sort((a, b) => a - b);
    sorted.push(part[Math.floor(part.length / 2)] || 1e-12);
  }
  for (let i = 0; i < band.length; i++) floor.push(sorted[Math.floor(i / win)]);
  const out = [];
  let start = -1, strength = 0, pitch = 0;
  for (let i = 0; i <= tone.length; i++) {
    const on = i < tone.length && tone[i] > 12 && share[i] > 0.2 && band[i] > floor[i] * 3
      && (start < 0 || Math.abs(hz[i] - pitch) < 250);
    if (on) {
      if (start < 0) { start = i; strength = 0; pitch = hz[i]; }
      strength = Math.max(strength, tone[i]);
    } else if (start >= 0) {
      const len = (i - start) * sec;
      if (len >= 0.3) out.push({ time: Number((start * sec).toFixed(2)), length: Number(len.toFixed(2)), strength: Math.round(strength), hz: Math.round(pitch) });
      start = -1;
    }
  }
  // Two blasts close together are one whistle.
  return out.filter((w, i) => i === 0 || w.time - (out[i - 1].time + out[i - 1].length) > 1.5);
}

// --- Saving a condensed game: the kept parts joined without encoding (fast, no quality loss) ---

function saveCondensed(win, job, { video, keep, out }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pucked-condensed-'));
  const file = video.replace(/'/g, "'\\''");
  fs.writeFileSync(path.join(cwd, 'list.txt'), keep.map(([a, b]) => `file '${file}'\ninpoint ${a.toFixed(3)}\noutpoint ${b.toFixed(3)}`).join('\n'));
  const total = keep.reduce((s, [a, b]) => s + b - a, 0);
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-map', '0:v:0', '-map', '0:a:0?',
      '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', out], { cwd, windowsHide: true });
    job.child = child;
    let err = '';
    child.stdout.on('data', (d) => {
      const m = String(d).match(/out_time_us=(\d+)/g);
      if (m) send(win, { state: 'saving', pct: Math.min(100, (Number(m.at(-1).split('=')[1]) / 1e6 / total) * 100) });
    });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('close', (code) => {
      job.child = null;
      fs.rmSync(cwd, { recursive: true, force: true });
      if (job.cancelled) reject(new Error('cancelled'));
      else if (code === 0) resolve();
      else reject(new Error(err.trim().split('\n').pop() || `ffmpeg stopped (exit code ${code})`));
    });
  });
}

let job = null; // { child, cancelled }

function send(win, state) {
  if (win && !win.isDestroyed()) win.webContents.send('autocut:progress', state);
}

function register() {
  ipcMain.handle('xbotgo:motion', (_e, video) => trackMotion(video));

  ipcMain.handle('autocut:scan', async (e, video) => {
    if (job) return { ok: false, error: 'Already working on it.' };
    const win = BrowserWindow.fromWebContents(e.sender);
    job = { child: null, cancelled: false };
    try {
      const sound = await scanSound(video, (f) => send(win, { state: 'scanning', pct: f * 100 }), job);
      return { ok: true, whistles: findWhistles(sound), duration: sound.duration, silent: Boolean(sound.silent), motion: trackMotion(video) };
    } catch (err) {
      return err.message === 'cancelled' ? { ok: false, cancelled: true } : { ok: false, error: err.message };
    } finally {
      job = null;
    }
  });

  ipcMain.handle('autocut:save', async (e, opts) => {
    if (job) return { ok: false, error: 'Already working on it.' };
    const win = BrowserWindow.fromWebContents(e.sender);
    job = { child: null, cancelled: false };
    try {
      await saveCondensed(win, job, opts);
      return { ok: true };
    } catch (err) {
      return err.message === 'cancelled' ? { ok: false, cancelled: true } : { ok: false, error: err.message };
    } finally {
      job = null;
    }
  });

  ipcMain.handle('autocut:cancel', () => {
    if (!job) return false;
    job.cancelled = true;
    job.child?.kill();
    return true;
  });
}

module.exports = { register, findWhistles, trackMotion };
