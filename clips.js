// Saving clips and highlight reels with the bundled ffmpeg. Each clip is cut from the game video and
// re-encoded (so it starts exactly where the user said), on the graphics card when it can be,
// then a reel joins the clips without encoding them again.
const { BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');

const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

// Hardware H.264 encoders to try first (AMD, Apple, NVIDIA, Intel), then the CPU one, which always works.
const ENCODERS = [
  { name: 'h264_amf', args: ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cbr', '-b:v', '10M'] },
  { name: 'h264_videotoolbox', args: ['-c:v', 'h264_videotoolbox', '-b:v', '10M'] },
  { name: 'h264_nvenc', args: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', '10M'] },
  { name: 'h264_qsv', args: ['-c:v', 'h264_qsv', '-b:v', '10M'] },
  { name: 'libx264', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'] },
];

let encoder = null;

// The first encoder that can really encode a frame on this computer. Listing isn't enough:
// a build can include h264_amf on a PC without an AMD card.
async function pickEncoder() {
  if (encoder) return encoder;
  for (const enc of ENCODERS) {
    const ok = await new Promise((resolve) => {
      execFile(ffmpegPath, ['-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=0.1', '-frames:v', '1',
        ...enc.args, '-f', 'null', '-'], { windowsHide: true, timeout: 15000 }, (err) => resolve(!err));
    });
    if (ok) { encoder = enc; return enc; }
  }
  throw new Error('ffmpeg could not encode video on this computer.');
}

let job = null; // { child, cancelled }

function send(win, state) {
  if (!win.isDestroyed()) win.webContents.send('clips:progress', state);
}

// Cut one clip to `out`, reporting progress from 0 to 1 through onProgress.
// The play name is drawn by the app as a picture (not every ffmpeg build can draw text) and laid over
// the first 4 seconds of the clip.
function encodeClip(cwd, video, clip, out, onProgress) {
  const dur = Math.max(0.1, clip.end - clip.start);
  const input = ['-ss', clip.start.toFixed(3), '-i', video];
  let videoArgs = ['-map', '0:v:0', '-vf', 'format=yuv420p'];
  if (clip.overlay) {
    fs.writeFileSync(path.join(cwd, `label${clip.i}.png`), Buffer.from(clip.overlay, 'base64'));
    input.push('-i', `label${clip.i}.png`);
    videoArgs = ['-filter_complex', "[0:v][1:v]overlay=x=H/30:y=H-h-H/30:enable='lt(t,4)',format=yuv420p[v]", '-map', '[v]'];
  }
  const args = ['-hide_banner', '-y', ...input, '-t', dur.toFixed(3), ...videoArgs, '-map', '0:a:0?', ...encoder.args,
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats', out];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { cwd, windowsHide: true });
    job.child = child;
    let err = '';
    child.stdout.on('data', (d) => {
      const m = String(d).match(/out_time_us=(\d+)/g);
      if (m) onProgress(Math.min(1, Number(m.at(-1).split('=')[1]) / 1e6 / dur));
    });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('close', (code) => {
      job.child = null;
      if (job.cancelled) reject(new Error('cancelled'));
      else if (code === 0) resolve();
      else reject(new Error(err.trim().split('\n').pop() || `ffmpeg stopped (exit code ${code})`));
    });
  });
}

// Join clips that all came from the same encoder without encoding again.
function joinClips(cwd, files, out) {
  fs.writeFileSync(path.join(cwd, 'list.txt'), files.map((f) => `file '${f}'`).join('\n'));
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy',
      '-movflags', '+faststart', out], { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _o, stderr) => {
      if (err) reject(new Error(String(stderr).trim().split('\n').pop() || err.message));
      else resolve();
    });
  });
}

async function exportClips(win, { video, clips, out }) {
  job = { child: null, cancelled: false };
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pucked-clips-'));
  try {
    await pickEncoder();
    const total = clips.reduce((a, c) => a + (c.end - c.start), 0);
    let doneSec = 0;
    const files = [];
    for (const [i, clip] of clips.entries()) {
      const file = clips.length === 1 ? out : path.join(cwd, `clip${i}.mp4`);
      const len = clip.end - clip.start;
      await encodeClip(cwd, video, { ...clip, i }, file, (f) => {
        send(win, { state: 'running', pct: ((doneSec + f * len) / total) * 100, clip: i + 1, clips: clips.length, encoder: encoder.name });
      });
      doneSec += len;
      files.push(`clip${i}.mp4`);
    }
    if (clips.length > 1) await joinClips(cwd, files, out);
    send(win, { state: 'done', out, encoder: encoder.name });
  } catch (e) {
    send(win, e.message === 'cancelled' ? { state: 'cancelled' } : { state: 'failed', error: e.message });
  } finally {
    job = null;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function register() {
  ipcMain.handle('clips:save-as', async (e, defaultPath) => {
    const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
      title: 'Save video', defaultPath, filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    return canceled ? null : filePath;
  });

  ipcMain.handle('clips:export', (e, opts) => {
    if (job) return { ok: false, error: 'A clip is already being saved. Wait for it to finish.' };
    exportClips(BrowserWindow.fromWebContents(e.sender), opts);
    return { ok: true };
  });

  ipcMain.handle('clips:cancel', () => {
    if (!job) return false;
    job.cancelled = true;
    job.child?.kill();
    return true;
  });

  ipcMain.handle('frame:save-as', async (e, defaultPath) => {
    const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
      title: 'Save picture', defaultPath, filters: [{ name: 'PNG picture', extensions: ['png'] }],
    });
    return canceled ? null : filePath;
  });

  // One frame of the game with the user's drawing laid over it.
  ipcMain.handle('frame:save', (_e, { video, time, overlay, out }) => new Promise((resolve) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pucked-frame-'));
    fs.writeFileSync(path.join(cwd, 'drawing.png'), Buffer.from(overlay, 'base64'));
    execFile(ffmpegPath, ['-hide_banner', '-y', '-ss', time.toFixed(3), '-i', video, '-i', 'drawing.png',
      '-filter_complex', '[0:v][1:v]overlay', '-frames:v', '1', out], { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _o, stderr) => {
      fs.rmSync(cwd, { recursive: true, force: true });
      resolve(err ? { ok: false, error: String(stderr).trim().split('\n').pop() || err.message } : { ok: true });
    });
  }));

  ipcMain.handle('clips:show', (_e, file) => shell.showItemInFolder(file));
}

module.exports = { register };
