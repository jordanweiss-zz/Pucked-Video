// The Pucked Video window. All the work happens in the Python server (server/); this file sets up
// Python the first time, starts the server, and shows its screens in a window. It also offers the
// computer's own file dialogs to the screens (preload.js), which a browser can't.
const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

// ffmpeg-static ships its own ffmpeg; the server uses it too.
const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
const isWin = process.platform === 'win32';

let server = null;
let setupWin = null;

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
    resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr || err?.message || '') });
  });
});

// A small window that says what's happening while Python is set up the first time.
function showSetup(text) {
  if (!setupWin) {
    setupWin = new BrowserWindow({ width: 520, height: 220, resizable: false, title: 'Pucked Video', show: true });
    setupWin.removeMenu();
  }
  const html = `<body style="font:15px system-ui;margin:32px;color:#222"><h3 style="margin:0 0 12px">Pucked Video</h3><p>${text}</p></body>`;
  setupWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

// Python 3.10 or newer that's already on the computer, to make the app's own copy from.
async function findPython() {
  const tries = isWin ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];
  for (const [cmd, pre] of tries) {
    const r = await run(cmd, [...pre, '-c', 'import sys; print(sys.version_info >= (3, 10))']);
    if (r.ok && r.stdout.trim() === 'True') return [cmd, pre];
  }
  return null;
}

// The app keeps its own Python environment in its data folder, made once and refreshed when
// server/requirements.txt changes. Returns that environment's python, or null if it couldn't.
async function ensurePython() {
  const dir = path.join(app.getPath('userData'), 'python');
  const py = isWin ? path.join(dir, 'Scripts', 'python.exe') : path.join(dir, 'bin', 'python');
  const reqs = path.join(__dirname, 'server', 'requirements.txt');
  const want = crypto.createHash('sha1').update(fs.readFileSync(reqs)).digest('hex');
  const stamp = path.join(dir, 'pucked-requirements.sha1');
  if (fs.existsSync(py) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === want) return py;

  if (!fs.existsSync(py)) {
    showSetup('Setting up for the first time. This takes a minute or two…');
    const base = await findPython();
    if (!base) {
      const choice = await dialog.showMessageBox({
        type: 'error', buttons: ['Get Python', 'Quit'], defaultId: 0,
        message: 'Pucked Video needs Python 3.10 or newer.',
        detail: 'Install it from python.org (tick "Add python.exe to PATH" on Windows), then open Pucked Video again.',
      });
      if (choice.response === 0) shell.openExternal('https://www.python.org/downloads/');
      return null;
    }
    const made = await run(base[0], [...base[1], '-m', 'venv', dir]);
    if (!made.ok) return failSetup(made.stderr);
  }
  showSetup('Installing what Pucked Video needs. This takes a minute or two the first time…');
  const pip = await run(py, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', reqs]);
  if (!pip.ok) return failSetup(pip.stderr);
  fs.writeFileSync(stamp, want);
  return py;
}

async function failSetup(detail) {
  await dialog.showMessageBox({ type: 'error', message: "Pucked Video couldn't finish setting up.", detail: detail.trim().split('\n').slice(-6).join('\n') });
  return null;
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const healthy = (port) => new Promise((resolve) => {
  http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1000 }, (res) => { res.resume(); resolve(res.statusCode === 200); })
    .on('error', () => resolve(false)).on('timeout', function onTimeout() { this.destroy(); resolve(false); });
});

// Start the server and wait until it answers. Its messages go to server.log in the data folder.
async function startServer(py) {
  const port = await freePort();
  const log = fs.createWriteStream(path.join(app.getPath('userData'), 'server.log'));
  server = spawn(py, ['-m', 'server', '--port', String(port)], {
    cwd: __dirname,
    windowsHide: true,
    env: {
      ...process.env,
      PUCKED_DATA_DIR: app.getPath('userData'),
      PUCKED_APP_DIR: __dirname,
      PUCKED_FFMPEG: ffmpegPath,
      PYTHONDONTWRITEBYTECODE: '1', // the app's folder can be read-only once installed
      PYTHONUNBUFFERED: '1',
    },
  });
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  server.on('exit', () => { server = null; });
  for (let i = 0; i < 150; i++) {
    if (!server) break;
    if (await healthy(port)) return port;
    await new Promise((r) => { setTimeout(r, 200); });
  }
  await dialog.showMessageBox({ type: 'error', message: "Pucked Video's server didn't start.", detail: `See ${path.join(app.getPath('userData'), 'server.log')}` });
  return null;
}

function createWindow(port) {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Pucked Video',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
}

// --- The computer's own dialogs, for the screens -------------------------------------------------

ipcMain.handle('native:pick-file', async (e, { title, filters, defaultPath } = {}) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    title, defaultPath, filters, properties: ['openFile'],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('native:pick-folder', async (e, title) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title, properties: ['openDirectory'] });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('native:save-file', async (e, { title, filters, defaultPath } = {}) => {
  const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), { title, defaultPath, filters });
  return canceled ? null : filePath;
});

ipcMain.handle('native:open-path', (_e, file) => shell.openPath(file));
ipcMain.handle('native:show-item', (_e, file) => shell.showItemInFolder(file));

// YouTube refuses to embed without a Referer (player error 153), so make sure its requests have one.
function allowYouTubeEmbeds() {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://www.youtube.com/*', 'https://*.ytimg.com/*', 'https://*.googlevideo.com/*'] },
    (details, callback) => {
      details.requestHeaders.Referer ??= 'https://pucked.video/';
      callback({ requestHeaders: details.requestHeaders });
    },
  );
}

let port = null;

app.whenReady().then(async () => {
  allowYouTubeEmbeds();
  const py = await ensurePython();
  port = py && await startServer(py);
  if (!port) { app.quit(); return; }
  createWindow(port);
  // Only now, so there's never a moment with no window (which would quit the app).
  setupWin?.destroy();
  setupWin = null;
});

// Hockey AI runs keep going after the window closes; only the server stops.
app.on('will-quit', () => {
  if (!server) return;
  // On Windows the environment's python.exe starts the real Python as its own child, so stop both.
  if (isWin) execFile('taskkill', ['/pid', String(server.pid), '/T', '/F'], () => {});
  else server.kill();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (port && BrowserWindow.getAllWindows().length === 0) createWindow(port); });
