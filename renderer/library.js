// The game library: every game in the folders you pick, newest first, with what's been done to it.
// Click a game to review it. The folders are kept in the app's settings.
const Library = {
  games: [],

  get folders() { return AI.settings.libraryFolders ?? []; },

  async setFolders(list) {
    AI.settings.libraryFolders = list;
    await window.api.saveSettings(AI.settings);
  },

  async open() {
    // First time: start with the folder of the game that's open, if there is one.
    if (!this.folders.length && current?.path) await this.setFolders([current.path.replace(/[\\/][^\\/]*$/, '')]);
    $('libraryDialog').showModal();
    await this.scan();
  },

  async scan() {
    this.renderFolders();
    if (!this.folders.length) {
      this.games = [];
      $('libCount').textContent = '';
      $('libGrid').innerHTML = '<p class="muted">Add the folder where you keep your game videos, for example C:\\Videos.</p>';
      return;
    }
    $('libGrid').innerHTML = '<p class="muted">Looking for games…</p>';
    this.games = await window.api.scanLibrary(this.folders);
    this.render();
    this.loadThumbs();
  },

  renderFolders() {
    $('libFolders').innerHTML = this.folders.length
      ? this.folders.map((f, i) => `<span class="lib-folder">${esc(f)} <button class="link" data-remove="${i}" title="Stop looking here">×</button></span>`).join(' ')
      : '<span class="muted">No folders yet</span>';
  },

  when(g) {
    const d = new Date(g.date);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  },

  // Hockey AI's latest run on the game, when it isn't simply finished.
  progress(g) {
    const p = g.progress;
    const pct = p?.percent != null ? ` ${Math.floor(p.percent)}%` : '';
    if (p?.state === 'running') return `<span class="badge new" title="${p.etaS ? `About ${Analyze.dur(p.etaS)} left` : ''}">Analyzing${pct}</span>`;
    if (p?.state === 'stopped') return `<span class="badge warn" title="Open the game and start Hockey AI again to carry on">Stopped at${pct || ' ?'}</span>`;
    if (p?.state === 'failed') return `<span class="badge warn" title="${esc(p.message || '')}">AI run failed</span>`;
    return '';
  },

  render() {
    const shown = $('libAnalyzed').checked ? this.games.filter((g) => g.analyzed) : this.games;
    $('libCount').textContent = `${shown.length} game${shown.length === 1 ? '' : 's'}`;
    $('libGrid').innerHTML = shown.length ? shown.map((g) => {
      const i = this.games.indexOf(g);
      const badges = [
        this.progress(g),
        g.analyzed && '<span class="badge ok">Analyzed</span>',
        g.ai?.canUpdate && '<span class="badge new" title="Newer numbers can be made from the saved analysis, without the graphics card">Update available</span>',
        g.tags && `<span class="badge">${g.tags} tag${g.tags === 1 ? '' : 's'}</span>`,
        g.toReview && `<span class="badge">${g.toReview} to review</span>`,
      ].filter(Boolean).join('');
      return `<button class="lib-game" data-game="${i}" title="${esc(g.path)}">
        <span class="lib-cover">${g.cover ? `<img src="${esc(g.cover)}" alt="">` : ''}</span>
        <strong>${esc(g.title || g.name)}</strong>
        <span class="muted">${esc(this.when(g))}${g.duration ? ` · ${fmt(g.duration)}` : ''}</span>
        <span class="lib-badges">${badges}</span>
      </button>`;
    }).join('') : '<p class="muted">No games found in these folders.</p>';
  },

  // Games without an XBotGo thumbnail get one frame from the video, one at a time.
  async loadThumbs() {
    for (const [i, g] of this.games.entries()) {
      if (g.cover || !$('libraryDialog').open) continue;
      g.cover = await window.api.libraryThumb(g.path).catch(() => null);
      const img = $('libGrid').querySelector(`[data-game="${i}"] .lib-cover`);
      if (img && g.cover) img.innerHTML = `<img src="${esc(g.cover)}" alt="">`;
    }
  },

  wire() {
    $('libraryBtn').onclick = () => this.open();
    $('libAnalyzed').onchange = () => this.render();
    $('libAdd').onclick = async () => {
      const dir = await window.api.pickFolder('Choose a folder with game videos');
      if (!dir || this.folders.includes(dir)) return;
      await this.setFolders([...this.folders, dir]);
      await this.scan();
    };
    $('libFolders').onclick = async (e) => {
      if (e.target.dataset.remove === undefined) return;
      await this.setFolders(this.folders.filter((_, i) => i !== Number(e.target.dataset.remove)));
      await this.scan();
    };
    $('libGrid').onclick = async (e) => {
      const card = e.target.closest('[data-game]');
      if (!card) return;
      const g = this.games[Number(card.dataset.game)];
      const file = await window.api.openVideoPath(g.path);
      if (!file) return alert(`${g.path} isn't there any more.`);
      $('libraryDialog').close();
      await showGame(file);
    };
  },
};
