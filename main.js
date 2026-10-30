const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');
const hockeyAi = require('./hockey-ai');
const clips = require('./clips');
const autocut = require('./autocut');

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

// Hockey_AI is a folder with config/events.json and main.py in it. Look in the usual places, so the
// user doesn't have to know where it went.
const isHockeyAi = (dir) => Boolean(dir) && fs.existsSync(path.join(dir, 'config', 'events.json')) && fs.existsSync(path.join(dir, 'main.py'));
ipcMain.handle('ai:dir:check', (_e, dir) => {
  if (isHockeyAi(dir)) return dir;
  // Picked the folder one level up, or a download that unzipped into Hockey_AI-main\Hockey_AI-main.
  for (const sub of ['Hockey_AI', 'Hockey_AI-main', 'hockey_ai']) if (dir && isHockeyAi(path.join(dir, sub))) return path.join(dir, sub);
  return null;
});
ipcMain.handle('ai:dir:find', () => {
  const home = app.getPath('home');
  const spots = ['Projects', 'Documents', 'Desktop', 'Downloads', '', 'source/repos', 'Documents/GitHub', 'GitHub'];
  for (const s of spots) {
    for (const name of ['Hockey_AI', 'Hockey_AI-main', 'hockey_ai']) {
      const d = path.join(home, s, name);
      if (isHockeyAi(d)) return d;
      if (isHockeyAi(path.join(d, name))) return path.join(d, name);
    }
  }
  return null;
});

ipcMain.handle('folder:pick', async (_e, title) => {
  const { canceled, filePaths } = await dialog.showOpenDialog({ title, properties: ['openDirectory'] });
  return canceled ? null : filePaths[0];
});

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

hockeyAi.register();
clips.register();
autocut.register();

app.whenReady().then(() => {
  allowYouTubeEmbeds();
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
