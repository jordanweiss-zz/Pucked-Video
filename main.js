const { app, BrowserWindow, dialog, ipcMain } = require('electron');
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

// Tags are saved next to the video as <video>.tags.json.
ipcMain.handle('tags:load', (_e, videoPath) => {
  const file = `${videoPath}.tags.json`;
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

ipcMain.handle('tags:save', (_e, videoPath, data) => {
  fs.writeFileSync(`${videoPath}.tags.json`, JSON.stringify(data, null, 2));
  return true;
});

ipcMain.handle('ffmpeg:check', () => new Promise((resolve) => {
  execFile(ffmpegPath, ['-version'], (err, stdout) => {
    resolve(err ? { ok: false, error: err.message } : { ok: true, version: stdout.split('\n')[0] });
  });
}));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
