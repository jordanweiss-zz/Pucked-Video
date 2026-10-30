// How the screens talk to Pucked Video's server. Every call is POST /api/<name> with its arguments
// as a JSON list, and progress arrives as Server-Sent Events. The Electron window adds window.native
// (preload.js) for the computer's own file dialogs; in a plain browser the dialogs ask for a path.
(() => {
  async function call(name, ...args) {
    const res = await fetch(`/api/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pucked': '1' },
      body: JSON.stringify({ args }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || body.detail || `The server said ${res.status}`);
    return body.result ?? null;
  }

  // One event stream for every kind of progress; the browser reconnects it on its own.
  const listeners = {};
  const on = (channel, fn) => { (listeners[channel] ??= []).push(fn); };
  const stream = new EventSource('/api/events');
  stream.onmessage = (e) => {
    const { channel, data } = JSON.parse(e.data);
    for (const fn of listeners[channel] ?? []) fn(data);
  };

  const native = window.native ?? null;
  let lastDir = ''; // the open game's folder, where a plain browser saves by default

  const ask = (title, suggestion = '') => {
    const p = prompt(`${title}\n\nType or paste the full path:`, suggestion);
    return p?.trim().replace(/^"(.*)"$/, '$1') || null;
  };
  const pickFile = (title, filters, defaultPath) => (native ? native.pickFile({ title, filters, defaultPath }) : ask(title, defaultPath));
  const saveFile = (title, filters, defaultPath) => {
    if (native) return native.saveFile({ title, filters, defaultPath });
    const full = defaultPath && !/[\\/]/.test(defaultPath) && lastDir ? `${lastDir}${lastDir.includes('\\') ? '\\' : '/'}${defaultPath}` : defaultPath;
    return ask(title, full);
  };
  const VIDEO = [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'mkv'] }];

  // The address the screens use to show a file from the computer the server runs on.
  const fileUrl = (file) => `/files/${encodeURI(file.replace(/\\/g, '/').replace(/^\/+/, '')).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;

  window.api = {
    fileUrl,
    async openVideo() {
      const file = await pickFile('Open a game video', VIDEO);
      if (!file) return null;
      const info = await call('video:info', file);
      if (!info) { alert(`Couldn't find ${file}.`); return null; }
      lastDir = info.path.replace(/[\\/][^\\/]*$/, '');
      return info;
    },
    listSports: () => call('sports:list'),
    loadTags: (key) => call('tags:load', key),
    saveTags: (key, data) => call('tags:save', key, data),
    loadXbotgoMarks: (videoPath) => call('xbotgo:marks', videoPath),
    loadTeams: () => call('teams:load'),
    saveTeams: (data) => call('teams:save', data),
    loadSettings: () => call('settings:load'),
    saveSettings: (data) => call('settings:save', data),
    pickFolder: (title) => (native ? native.pickFolder(title) : ask(title)),
    checkAiDir: (dir) => call('ai:dir:check', dir),
    findAiDir: () => call('ai:dir:find'),
    loadAiEvents: (dir) => call('ai:events:load', dir),
    async pickAiResults(defaultPath) {
      const file = await pickFile('Choose the AI results for this game', [{ name: 'Hockey_AI results', extensions: ['json'] }], defaultPath);
      return file ? window.api.loadAiRun(file) : null;
    },
    async loadAiRun(exportPath) {
      const run = await call('ai:run:load', exportPath);
      run.thumbBase = new URL(run.thumbBase, location.href).href; // players.js resolves thumbnails against it
      return run;
    },
    saveAiPlayers: (base, data) => call('ai:players:save', base, data),
    refilterAi: (hai, base, startOffset) => call('ai:refilter', hai, base, startOffset),
    aiGame: (hai, video) => call('ai:game', hai, video),
    saveAiPicks: (video, picks) => call('ai:picks:save', video, picks),
    analyzeGame: (hai, video, opts) => call('ai:analyze', hai, video, opts),
    makeReport: (hai, video, opts) => call('ai:report', hai, video, opts),
    getAiJob: () => call('ai:job:get'),
    cancelAiJob: () => call('ai:job:cancel'),
    onAiJob: (fn) => on('ai:job', fn),
    openFile: (file) => (native ? native.openPath(file) : window.open(fileUrl(file), '_blank')),
    saveVideoAs: (defaultPath) => saveFile('Save video', [{ name: 'MP4 video', extensions: ['mp4'] }], defaultPath),
    exportClips: (opts) => call('clips:export', opts),
    cancelClips: () => call('clips:cancel'),
    pickLogo: () => pickFile('Choose your team logo', [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]),
    savePictureAs: (defaultPath) => saveFile('Save picture', [{ name: 'PNG picture', extensions: ['png'] }], defaultPath),
    saveFrame: (opts) => call('frame:save', opts),
    // A plain browser can't open a folder window, so it opens the file itself.
    showFile: (file) => (native ? native.showItem(file) : window.open(fileUrl(file), '_blank')),
    onClipsProgress: (fn) => on('clips:progress', fn),
    loadCameraMotion: (video) => call('xbotgo:motion', video),
    scanDeadTime: (video) => call('autocut:scan', video),
    saveCondensed: (opts) => call('autocut:save', opts),
    cancelAutoCut: () => call('autocut:cancel'),
    onAutoCutProgress: (fn) => on('autocut:progress', fn),
    checkFfmpeg: () => call('ffmpeg:check'),
  };
})();
