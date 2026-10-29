// The game library: every game video in the folders you pick, with what the app knows about each
// one (the XBotGo thumbnail and date, your tags, whether Hockey AI has analyzed it).
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');

const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

const VIDEO = /\.(mp4|mov|m4v|mkv)$/i;
// Folders the app or Hockey AI writes into, which never hold games of their own.
const SKIP = /(^\.|_analysis$|_players$|_calib_check$|^node_modules$|^\$RECYCLE\.BIN$|^System Volume Information$)/i;

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

function findVideos(dir, depth, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0 && !SKIP.test(e.name)) findVideos(full, depth - 1, out); }
    else if (e.isFile() && VIDEO.test(e.name) && !/ - (condensed|highlights)| 9x16\.mp4$/i.test(e.name)) out.push(full);
    if (out.length >= 2000) return;
  }
}

// Saved clips and reels sit next to the games, so tell them apart: a game is long, or has an
// XBotGo .data folder or a tags file.
function game(file) {
  const { dir, name } = path.parse(file);
  const st = fs.statSync(file);
  const vdata = readJson(path.join(dir, '.data', `${name}.vdata`));
  const cover = path.join(dir, '.data', `${name}.cover`);
  const saved = readJson(`${file}.tags.json`);
  const tags = (saved?.tags ?? []).filter((t) => t.status !== 'rejected' && t.status !== 'suggested');
  const counts = {};
  for (const t of tags) counts[t.label] = (counts[t.label] ?? 0) + 1;
  const ai = path.join(dir, `${name}_analysis`, name);
  const pdf = `${ai}_postgame.pdf`;
  const date = vdata?.file_time ? vdata.file_time.replace(' ', 'T') : /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.test(name)
    ? name.replace(/.*?(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2}).*/, '$1-$2-$3T$4:$5:$6') : new Date(st.mtimeMs).toISOString();
  return {
    path: file,
    name,
    title: saved?.title ?? '',
    date,
    size: st.size,
    duration: vdata?.duration ?? null,
    xbotgo: Boolean(vdata),
    cover: fs.existsSync(cover) ? pathToFileURL(cover).href : null,
    tags: tags.length,
    counts,
    toReview: (saved?.tags ?? []).filter((t) => t.status === 'suggested').length,
    sport: saved?.sport ?? null,
    teamId: saved?.teamId ?? null,
    analyzed: fs.existsSync(`${ai}_report.json`),
    report: fs.existsSync(pdf) ? pdf : null,
    hasTags: Boolean(saved),
  };
}

function scan(folders) {
  const files = [];
  for (const f of folders) findVideos(f, 3, files);
  return [...new Set(files)].map((f) => { try { return game(f); } catch { return null; } })
    .filter((g) => g && (g.xbotgo || g.hasTags || g.size > 500 * 1024 * 1024))
    .sort((a, b) => b.date.localeCompare(a.date));
}

// A picture for a game without an XBotGo thumbnail: one frame a few minutes in, kept in the app's data folder.
function thumb(file) {
  const dir = path.join(app.getPath('userData'), 'thumbs');
  fs.mkdirSync(dir, { recursive: true });
  const st = fs.statSync(file);
  const out = path.join(dir, `${crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex')}.jpg`);
  if (fs.existsSync(out)) return Promise.resolve(pathToFileURL(out).href);
  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-hide_banner', '-y', '-ss', '180', '-i', file, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', out],
      { windowsHide: true, timeout: 30000 }, (err) => {
        if (!err && fs.existsSync(out)) return resolve(pathToFileURL(out).href);
        // Shorter than 3 minutes: take the first frame instead.
        execFile(ffmpegPath, ['-hide_banner', '-y', '-i', file, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', out],
          { windowsHide: true, timeout: 30000 }, (err2) => resolve(!err2 && fs.existsSync(out) ? pathToFileURL(out).href : null));
      });
  });
}

function register() {
  ipcMain.handle('library:scan', (_e, folders) => scan(folders.filter((f) => fs.existsSync(f))));
  ipcMain.handle('library:thumb', (_e, file) => thumb(file).catch(() => null));
  ipcMain.handle('library:title', (_e, file, title) => {
    const tf = `${file}.tags.json`;
    const saved = readJson(tf) ?? { tags: [] };
    saved.title = title;
    fs.writeFileSync(tf, JSON.stringify(saved, null, 2));
    return true;
  });
  ipcMain.handle('video:open-path', (_e, file) => {
    if (!fs.existsSync(file)) return null;
    return { path: file, url: pathToFileURL(file).href, size: fs.statSync(file).size };
  });
}

module.exports = { register };
