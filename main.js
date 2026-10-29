const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');

// ffmpeg-static ships inside the asar archive; the binary has to be read from the unpacked copy.
const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Pucked Video',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// Videos are played straight from disk via file:// URLs, so 30 GB files never get copied or uploaded.
ipcMain.handle('video:open', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'mkv'] }],
  });
  if (canceled) return null;
  const filePath = filePaths[0];
  return { path: filePath, url: pathToFileURL(filePath).href, size: fs.statSync(filePath).size };
});

ipcMain.handle('sports:list', () => {
  const dir = path.join(__dirname, 'sports');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
});

// Tags for a local video are saved next to it as <video>.tags.json. YouTube videos have no
// file of their own, so theirs go in the app's data folder under youtube/<id>.tags.json.
function tagsFile(key) {
  const yt = key.match(/^youtube:([\w-]{11})$/);
  if (!yt) return `${key}.tags.json`;
  const dir = path.join(app.getPath('userData'), 'youtube');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${yt[1]}.tags.json`);
}

ipcMain.handle('tags:load', (_e, key) => {
  const file = tagsFile(key);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
});

// XBotGo keeps a hidden .data folder next to each recording. Its .mark file lists the
// highlight-button presses as [{ type: 'start' | 'click', time: <seconds> }].
ipcMain.handle('xbotgo:marks', (_e, videoPath) => {
  const { dir, name } = path.parse(videoPath);
  const file = path.join(dir, '.data', `${name}.mark`);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
      .filter((m) => m.type === 'click' && Number.isFinite(m.time))
      .map((m) => m.time);
  } catch {
    return [];
  }
});

ipcMain.handle('tags:save', (_e, key, data) => {
  fs.writeFileSync(tagsFile(key), JSON.stringify(data, null, 2));
  return true;
});

// Teams and rosters are shared by every game, so they live in the app's data folder.
const teamsFile = () => path.join(app.getPath('userData'), 'teams.json');

ipcMain.handle('teams:load', () => {
  const file = teamsFile();
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { teams: [] };
});

ipcMain.handle('teams:save', (_e, data) => {
  fs.writeFileSync(teamsFile(), JSON.stringify(data, null, 2));
  return true;
});

// App settings (e.g. where Hockey_AI lives) are kept in settings.json in the app's data folder.
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);

ipcMain.handle('settings:load', () => readJson(settingsFile(), {}));
ipcMain.handle('settings:save', (_e, data) => {
  fs.writeFileSync(settingsFile(), JSON.stringify(data, null, 2));
  return true;
});

ipcMain.handle('folder:pick', async (_e, title) => {
  const { canceled, filePaths } = await dialog.showOpenDialog({ title, properties: ['openDirectory'] });
  return canceled ? null : filePaths[0];
});

// Hockey_AI's play filters live in <Hockey_AI>/config/events.json; the app edits them so the user never has to.
const aiEventsFile = (dir) => path.join(dir, 'config', 'events.json');
ipcMain.handle('ai:events:load', (_e, dir) => readJson(aiEventsFile(dir), null));
ipcMain.handle('ai:events:save', (_e, dir, data) => {
  fs.writeFileSync(aiEventsFile(dir), JSON.stringify(data, null, 2));
  return true;
});

// Pick a finished run's <base>_events_export.json and return it with its roster file, if there is one.
ipcMain.handle('ai:import:pick', async (_e, defaultPath) => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Choose the AI results for this game',
    defaultPath,
    properties: ['openFile'],
    filters: [{ name: 'Hockey_AI results', extensions: ['json'] }],
  });
  if (canceled) return null;
  return loadAiRun(filePaths[0]);
});

function loadAiRun(exportPath) {
  const data = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  if (data.schema_version !== 1 || !Array.isArray(data.events)) throw new Error('That file is not a Hockey_AI events export.');
  const base = exportPath.replace(/_events_export\.json$/, '');
  // Thumbnail paths in the players file are relative to the run's folder.
  const thumbBase = `${pathToFileURL(path.dirname(exportPath)).href}/`;
  return { exportPath, base, thumbBase, data, players: readJson(`${base}_players.json`, null) };
}
ipcMain.handle('ai:run:load', (_e, exportPath) => loadAiRun(exportPath));

// The user's fixes to the run's players are saved with source "user", which later runs never overwrite.
ipcMain.handle('ai:players:save', (_e, base, data) => {
  fs.writeFileSync(`${base}_players.json`, JSON.stringify(data, null, 2));
  return true;
});

// Re-filter a saved run so its plays pick up new names and settings. CPU only and quick, so it can't clash with a GPU job.
ipcMain.handle('ai:refilter', (_e, dir, base) => runAiPython(dir, ['scripts/filter_events.py', base, '--write']));

// Hockey_AI's own Python, from its virtual environment when it has one.
function aiPython(dir) {
  const venvs = ['.venv', 'venv'].flatMap((v) => [path.join(dir, v, 'Scripts', 'python.exe'), path.join(dir, v, 'bin', 'python')]);
  return venvs.find((p) => fs.existsSync(p)) ?? (process.platform === 'win32' ? 'python' : 'python3');
}

function runAiPython(dir, args) {
  return new Promise((resolve) => {
    execFile(aiPython(dir), args, { cwd: dir, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, _stdout, stderr) => {
      if (!err) return resolve({ ok: true });
      const lines = String(stderr || err.message).trim().split('\n');
      resolve({ ok: false, error: lines.slice(-3).join('\n') });
    });
  });
}

ipcMain.handle('ffmpeg:check', () => new Promise((resolve) => {
  execFile(ffmpegPath, ['-version'], (err, stdout) => {
    resolve(err ? { ok: false, error: err.message } : { ok: true, version: stdout.split('\n')[0] });
  });
}));

// A page loaded from file:// sends no Referer, and YouTube refuses to embed without one
// (player error 153), so give YouTube requests one.
function allowYouTubeEmbeds() {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://www.youtube.com/*', 'https://*.ytimg.com/*', 'https://*.googlevideo.com/*'] },
    (details, callback) => {
      details.requestHeaders.Referer ??= 'https://pucked.video/';
      callback({ requestHeaders: details.requestHeaders });
    },
  );
}

app.whenReady().then(() => {
  allowYouTubeEmbeds();
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
