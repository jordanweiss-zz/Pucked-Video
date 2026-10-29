// Hockey_AI from inside the app. Everything here follows Hockey_AI's docs/app_contract.md (v1):
// the app finds the game's files, writes the rink picks and play settings, runs each tool with
// Hockey_AI's own Python, and reads the "PROGRESS n" / "ERROR message" lines they print.
const { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { pathToFileURL } = require('url');
const { spawn, execFile } = require('child_process');

const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);
const mtime = (file) => (fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0);
const fileUrl = (file) => pathToFileURL(file).href;

// Hockey_AI's play filters live in <Hockey_AI>/config/events.json; the app edits them so the user never has to.
const aiEventsFile = (hai) => path.join(hai, 'config', 'events.json');

// Hockey_AI's own Python, from its virtual environment.
function aiPython(hai) {
  const venvs = ['.venv', 'venv'].flatMap((v) => [path.join(hai, v, 'Scripts', 'python.exe'), path.join(hai, v, 'bin', 'python')]);
  return venvs.find((p) => fs.existsSync(p)) ?? null;
}

// Every file Hockey_AI reads or writes for one game. XBotGo keeps its camera log in a hidden
// .data folder next to the video; Hockey_AI's output goes in <stem>_analysis next to it too.
function gameFiles(video) {
  const { dir, name } = path.parse(video);
  const out = path.join(dir, `${name}_analysis`);
  const base = path.join(out, name);
  return {
    video, out, base,
    track: path.join(dir, '.data', `${name}.track`),
    mark: path.join(dir, '.data', `${name}.mark`),
    picks: `${base}_picks.json`,
    camera: `${base}_camera.json`,
    calibCheck: `${base}_calib_check`,
    events: `${base}_events.json`,
    annotated: `${base}.mp4`,
    report: `${base}_report.json`,
    exportFile: `${base}_events_export.json`,
    players: `${base}_players.json`,
    pdf: `${base}_postgame.pdf`,
    html: `${base}_postgame.html`,
    checkpoint: `${base}_checkpoint.json`, // left by a step that stopped partway, so it can resume
  };
}

function loadAiRun(exportPath) {
  const data = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  if (data.schema_version !== 1 || !Array.isArray(data.events)) throw new Error('That file is not a Hockey_AI events export.');
  const base = exportPath.replace(/_events_export\.json$/, '');
  return {
    exportPath,
    base,
    // Thumbnail paths in the players file are relative to the run's folder.
    thumbBase: `${fileUrl(path.dirname(exportPath))}/`,
    data,
    players: readJson(`${base}_players.json`, null),
    presence: readJson(`${base}_presence.json`, null), // when each tracked player was on screen
    teams: readJson(`${base}_report.json`, null)?.summary?.teams ?? null,
  };
}

// Each game gets its own copy of the user's play settings, so a run always says which settings it used.
function writeGameEvents(hai, f) {
  fs.mkdirSync(f.out, { recursive: true });
  fs.copyFileSync(aiEventsFile(hai), f.events);
}

function calibOverlays(f) {
  if (!fs.existsSync(f.calibCheck)) return [];
  const jpgs = fs.readdirSync(f.calibCheck).filter((n) => /\.jpe?g$/i.test(n)).sort();
  // A few spread across the game is enough to see whether the lines sit on the rink.
  const pick = jpgs.length <= 4 ? jpgs : [0, 1, 2, 3].map((i) => jpgs[Math.round((i * (jpgs.length - 1)) / 3)]);
  return pick.map((n) => {
    const file = path.join(f.calibCheck, n);
    return { file, url: `${fileUrl(file)}?t=${mtime(file)}` }; // ?t= so a re-run's pictures aren't cached
  });
}

// Where a step that crashed or was stopped will pick up again: { step, resume_from_s } or null.
function checkpointOf(f) {
  try {
    const c = readJson(f.checkpoint, null);
    return c?.schema_version === 1 && Number.isFinite(c.resume_from_s) ? { step: c.step, resumeFrom: c.resume_from_s } : null;
  } catch { return null; }
}

function gameStatus(hai, video) {
  const f = gameFiles(video);
  const picks = readJson(f.picks, []);
  return {
    files: f,
    python: hai ? Boolean(aiPython(hai)) : false,
    hasTrack: fs.existsSync(f.track),
    hasMark: fs.existsSync(f.mark),
    picks,
    calibrated: fs.existsSync(f.camera),
    analyzed: fs.existsSync(f.report),
    // Nothing left to run unless the user changes the rink points.
    upToDate: fs.existsSync(f.report) && fs.existsSync(f.players) && mtime(f.picks) <= mtime(f.camera),
    hasExport: fs.existsSync(f.exportFile),
    report: fs.existsSync(f.pdf) ? f.pdf : fs.existsSync(f.html) ? f.html : null,
    teams: readJson(f.report, null)?.summary?.teams ?? null,
    checkpoint: checkpointOf(f),
    overlays: calibOverlays(f),
  };
}

// --- Running the tools ------------------------------------------------------------------------
// One job at a time: Hockey_AI's analysis uses the GPU, and two DirectML jobs at once can hang it.
let job = null;
let child = null;
let blocker = null;

// The job as the window sees it (its steps' skip and args functions stay here).
const jobView = () => (job ? JSON.parse(JSON.stringify(job)) : null);
const send = () => {
  const view = jobView();
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ai:job', view);
};

function killChild() {
  if (!child) return;
  // Hockey_AI can start helper processes, so stop the whole tree on Windows.
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  else child.kill('SIGTERM');
}

// Run one tool, reporting its progress, and resolve with its exit code.
function runTool(hai, step, args) {
  return new Promise((resolve) => {
    const py = aiPython(hai);
    child = spawn(py, ['-u', ...args], { cwd: hai, windowsHide: true });
    step.startedAt = Date.now();
    const log = (line) => {
      job.log.push(line);
      if (job.log.length > 300) job.log.shift();
    };
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const p = line.match(/^PROGRESS\s+([\d.]+)/);
      if (p) { step.pct = Math.min(100, Number(p[1])); send(); return; }
      const r = line.match(/^RESUMING\s+([\d.]+)/);
      if (r) step.resumedFrom = Number(r[1]);
      const err = line.match(/^ERROR\s+(.*)/);
      if (err) step.error = err[1];
      log(line);
    });
    readline.createInterface({ input: child.stderr }).on('line', log);
    child.on('error', (e) => { step.error = `Couldn't start Hockey_AI's Python: ${e.message}`; });
    child.on('close', (code) => { child = null; resolve(code ?? 1); });
  });
}

// Steps run in order, and a step whose result is already on disk (and newer than its input) is skipped,
// so starting again after a cancel or a crash picks up where it left off. Skipping is decided when the
// step's turn comes, because an earlier step that re-ran makes the later ones out of date.
async function runJob(hai, kind, video, steps, onDone) {
  job = { kind, video, steps, state: 'running', startedAt: Date.now(), log: [], error: null };
  blocker = powerSaveBlocker.start('prevent-app-suspension'); // an overnight run shouldn't stop when the PC sleeps
  send();
  for (const step of steps) {
    if (step.skip?.()) { step.status = 'skipped'; send(); continue; }
    step.status = 'running';
    step.pct = 0;
    send();
    const code = await runTool(hai, step, step.args());
    if (job.state === 'cancelled' || code === 130) { step.status = 'cancelled'; job.state = 'cancelled'; break; }
    if (code !== 0) {
      step.status = 'failed';
      job.state = 'failed';
      job.error = friendlyError(step.error) ?? `${step.label} stopped unexpectedly (exit code ${code}).`;
      job.fixable = code === 2;
      break;
    }
    step.status = 'done';
    step.pct = 100;
    send();
  }
  if (job.state === 'running') {
    job.state = 'done';
    try { onDone?.(); } catch (e) { job.error = e.message; }
  }
  job.finishedAt = Date.now();
  powerSaveBlocker.stop(blocker);
  blocker = null;
  send();
}

// Hockey_AI's ERROR lines are shown as they are, except ones with a plainer way to say them.
function friendlyError(msg) {
  const res = msg?.match(/--lens is for 1920x1080 video, this video is (\d+x\d+)/);
  if (res) return `Unsupported resolution: Hockey AI only works on 1920×1080 XBotGo video for now, and this video is ${res[1].replace('x', '×')}.`;
  return msg;
}

// Steps 1-4 of the contract. Weights are hours of work per hour of video, for the progress bar and estimate.
// Re-running a step's same command resumes from its checkpoint; `fresh` throws that away and starts over.
function analyzeSteps(f, startOffset, fresh = false) {
  const off = String(startOffset);
  const restart = fresh ? ['--fresh'] : [];
  return [
    {
      id: 'calibrate', label: 'Map the rink', weight: 1,
      skip: () => fs.existsSync(f.camera) && mtime(f.picks) <= mtime(f.camera),
      // After the user edits picks, only the rink placement is re-fitted, which takes seconds.
      args: () => ['scripts/calibrate_xbotgo.py', '-i', f.video, '--track', f.track, '--start-offset', off,
        '--picks', f.picks, '--fit-rink-length', '--step', '5', '-o', f.camera, '--debug-dir', f.calibCheck,
        ...(fs.existsSync(f.camera) ? ['--reuse', f.camera] : []), ...restart],
    },
    {
      id: 'analyze', label: 'Find the plays (uses the graphics card)', weight: 4.5,
      skip: () => fs.existsSync(f.report) && mtime(f.report) > mtime(f.camera),
      args: () => ['main.py', '-i', f.video, '-o', f.annotated, '--gpu', '--xbotgo-track', f.track, '--start-offset', off,
        '--camera-calib', f.camera, '--event-config', f.events, ...restart],
    },
    {
      id: 'players', label: 'Read jersey numbers', weight: 0.75,
      // Re-running it keeps every player the user already named, but there's no need after a resume.
      skip: () => mtime(f.players) > mtime(f.report),
      args: () => ['scripts/name_players.py', f.base, '--video', f.video, '--start-offset', off, '--event-config', f.events],
    },
    {
      id: 'filter', label: 'Pick the plays to show', weight: 0.02,
      args: () => ['scripts/filter_events.py', f.base, '--start-offset', off, '--config', f.events, '--write',
        ...(fs.existsSync(f.mark) ? ['--mark', f.mark] : [])],
    },
  ];
}

function checkReady(hai, f) {
  if (!hai) return 'Choose your Hockey_AI folder in Hockey AI settings first.';
  if (!aiPython(hai)) return 'That Hockey_AI folder has no Python set up (.venv is missing).';
  if (!fs.existsSync(aiEventsFile(hai))) return 'That folder has no config/events.json. Is it the Hockey_AI folder?';
  if (job?.state === 'running') return 'Hockey AI is already working on a game. Wait for it to finish or cancel it.';
  return null;
}

function register() {
  ipcMain.handle('ai:events:load', (_e, hai) => readJson(aiEventsFile(hai), null));
  ipcMain.handle('ai:events:save', (_e, hai, data) => {
    fs.writeFileSync(aiEventsFile(hai), JSON.stringify(data, null, 2));
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
  ipcMain.handle('ai:run:load', (_e, exportPath) => loadAiRun(exportPath));

  // The user's fixes to the run's players are saved with source "user", which later runs never overwrite.
  ipcMain.handle('ai:players:save', (_e, base, data) => {
    fs.writeFileSync(`${base}_players.json`, JSON.stringify(data, null, 2));
    return true;
  });

  // Re-pick a saved run's plays with the current settings and player names. CPU only and takes seconds.
  ipcMain.handle('ai:refilter', (_e, hai, base, startOffset) => new Promise((resolve) => {
    const py = hai && aiPython(hai);
    if (!py) return resolve({ ok: false, error: 'Choose your Hockey_AI folder in Hockey AI settings first.' });
    const events = `${base}_events.json`;
    fs.copyFileSync(aiEventsFile(hai), events);
    const args = ['-u', 'scripts/filter_events.py', base, '--start-offset', String(startOffset ?? 0), '--config', events, '--write'];
    execFile(py, args, { cwd: hai, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true });
      const line = String(stdout).split('\n').find((l) => l.startsWith('ERROR '));
      resolve({ ok: false, error: line ? line.slice(6) : String(stderr || err.message).trim().split('\n').pop() });
    });
  }));

  ipcMain.handle('ai:game', (_e, hai, video) => gameStatus(hai, video));

  // Rink landmarks the user clicked: [frame, [ice_x_ft, ice_y_ft], [px, py]] per contract section 5.
  ipcMain.handle('ai:picks:save', (_e, video, picks) => {
    const f = gameFiles(video);
    fs.mkdirSync(f.out, { recursive: true });
    fs.writeFileSync(f.picks, JSON.stringify(picks, null, 2));
    return true;
  });

  ipcMain.handle('ai:job:get', () => jobView());
  ipcMain.handle('ai:job:cancel', () => {
    if (job?.state !== 'running') return false;
    job.state = 'cancelled';
    killChild();
    send();
    return true;
  });

  ipcMain.handle('ai:analyze', (_e, hai, video, opts = {}) => {
    const f = gameFiles(video);
    const problem = checkReady(hai, f)
      ?? (!fs.existsSync(f.track) ? `There's no XBotGo camera log next to this video (.data\\${path.basename(f.track)}).` : null)
      ?? (!fs.existsSync(f.picks) && !fs.existsSync(f.camera) ? 'Set up the rink first.' : null);
    if (problem) return { ok: false, error: problem };
    writeGameEvents(hai, f);
    if (opts.fresh) fs.rmSync(f.checkpoint, { force: true });
    runJob(hai, 'analyze', video, analyzeSteps(f, 0, Boolean(opts.fresh)));
    return { ok: true };
  });

  // Step 5: the printable post-game report, opened when it's ready.
  ipcMain.handle('ai:report', (_e, hai, video, opts = {}) => {
    const f = gameFiles(video);
    const problem = checkReady(hai, f) ?? (!fs.existsSync(f.report) ? 'Analyze the game first.' : null);
    if (problem) return { ok: false, error: problem };
    writeGameEvents(hai, f);
    const args = ['scripts/game_report.py', f.base, '--video', f.video, '--start-offset', '0', '--camera-calib', f.camera,
      '--event-config', f.events, ...(fs.existsSync(f.mark) ? ['--mark', f.mark] : [])];
    if (opts.teamA) args.push('--team-a', opts.teamA);
    if (opts.teamB) args.push('--team-b', opts.teamB);
    if (opts.title) args.push('--title', opts.title);
    if (opts.focusTeam) args.push('--focus-team', opts.focusTeam);
    if (opts.players?.length) args.push('--players', opts.players.join(','));
    const steps = [{ id: 'report', label: 'Make the post-game report', weight: 1, args: () => args }];
    runJob(hai, 'report', video, steps, () => {
      const out = fs.existsSync(f.pdf) ? f.pdf : f.html;
      if (fs.existsSync(out)) shell.openPath(out);
    });
    return { ok: true };
  });

  ipcMain.handle('ai:open', (_e, file) => shell.openPath(file));

  // Closing the app stops a running analysis, so ask first.
  app.on('browser-window-created', (_e, win) => {
    win.on('close', (e) => {
      if (job?.state !== 'running') return;
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['Keep running', 'Quit and stop it'],
        defaultId: 0,
        message: 'Hockey AI is still analyzing a game.',
        detail: 'Quitting stops it. Starting it again later resumes where it stopped.',
      });
      if (choice === 0) e.preventDefault();
      else { job.state = 'cancelled'; killChild(); }
    });
  });
}

module.exports = { register };
