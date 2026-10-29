// AI players: the players a Hockey_AI run tracked (<base>_players.json). Jersey numbers read by the
// AI are only guesses, so the user confirms or fixes them here; fixes are saved with source "user".
const AiPlayers = {
  run: null,
  edits: {}, // player_id -> number typed or confirmed in this sitting
  shown: {}, // player_id -> which thumbnail is showing

  // The run names each team by its jersey colors, e.g. "dark/black/gold".
  teamName(team) { return this.run?.teams?.[team] ?? ({ team_a: 'Team A', team_b: 'Team B' })[team] ?? 'Unknown team'; },
  teamColor: (team) => ({ team_a: '#e0a030', team_b: '#e8e8ea' })[team] ?? '#3a3f4a',

  async open(exportPath) {
    try {
      this.run = await window.api.loadAiRun(exportPath);
    } catch (err) {
      return alert(`Couldn't open the AI results: ${err.message}`);
    }
    if (!this.run.players?.players?.length) return alert('This run has no player list yet. Hockey AI makes one when it names players.');
    this.edits = {};
    this.shown = {};
    $('aiPlayersStatus').textContent = '';
    this.render();
    $('aiPlayersDialog').showModal();
  },

  needsNumber: (p) => !p.number || p.source !== 'user',

  render() {
    const all = this.run.players.players.slice().sort((a, b) => (b.seconds_tracked ?? 0) - (a.seconds_tracked ?? 0));
    const todo = $('aiPlayersTodo').checked;
    const list = all.filter((p) => !todo || this.needsNumber(p) || p.player_id in this.edits);
    const left = all.filter((p) => this.needsNumber(p) && !(p.player_id in this.edits)).length;
    $('aiPlayersCount').textContent = `${left} of ${all.length} still need a number`;
    const roster = Teams.get(gameTeamId)?.players ?? [];
    $('aiPlayerGrid').innerHTML = list.map((p) => {
      const id = p.player_id;
      const number = id in this.edits ? this.edits[id] : (p.number ?? '');
      const thumbs = p.thumbnails ?? [];
      const img = thumbs.length
        ? `<img data-thumb="${esc(id)}" src="${esc(new URL(thumbs[(this.shown[id] ?? 0) % thumbs.length], this.run.thumbBase).href)}" title="Click for another picture (${thumbs.length})">`
        : '<div class="noimg muted">No picture</div>';
      const guess = p.source === 'auto' && p.number && !(id in this.edits)
        ? `<span class="guess">AI guess ${Math.round((p.number_confidence ?? 0) * 100)}%</span> <button class="ok" data-confirm="${esc(id)}" title="The AI read it right">✓</button>`
        : '';
      const who = roster.find((r) => number && String(r.number) === String(number));
      return `<div class="ai-player ${id in this.edits ? 'changed' : ''}" style="--c:${this.teamColor(p.team)}">${img}`
        + `<div class="muted">${this.teamName(p.team)} · on screen ${fmtDuration(p.seconds_tracked ?? 0)}</div>`
        + `<div class="row-form">${guess}</div>` // before the number box, so Tab goes from box to box
        + `<input class="num" type="number" min="0" max="99" placeholder="#" data-num="${esc(id)}" value="${esc(number)}">`
        + `<div class="who">${who ? esc(who.name) : ''}</div></div>`;
    }).join('') || '<p class="muted">Every player has a number.</p>';
  },

  // Write the fixes back, re-filter the run so its plays carry the new numbers, then refresh the tags.
  async save() {
    const ids = Object.keys(this.edits);
    if (!ids.length) { $('aiPlayersStatus').textContent = 'Nothing to save.'; return; }
    for (const p of this.run.players.players) {
      if (!(p.player_id in this.edits)) continue;
      p.number = this.edits[p.player_id] || null;
      p.source = 'user';
    }
    await window.api.saveAiPlayers(this.run.base, this.run.players);
    this.edits = {};
    $('aiPlayersStatus').textContent = 'Saved. Updating the plays…';
    const res = await refreshAiPlays();
    this.run = await window.api.loadAiRun(this.run.exportPath);
    $('aiPlayersStatus').textContent = res.ok ? `Saved ${ids.length} player${ids.length === 1 ? '' : 's'}.`
      : `Saved, but updating the plays failed: ${res.error}`;
    this.render();
  },

  wire() {
    $('aiPlayersTodo').onchange = () => this.render();
    $('aiPlayersSave').onclick = () => this.save();
    $('aiPlayerGrid').onclick = (e) => {
      const { thumb, confirm } = e.target.dataset;
      if (thumb) { this.shown[thumb] = (this.shown[thumb] ?? 0) + 1; this.render(); }
      if (confirm) {
        this.edits[confirm] = this.run.players.players.find((p) => p.player_id === confirm).number;
        this.render();
      }
    };
    $('aiPlayerGrid').onchange = (e) => {
      const id = e.target.dataset.num;
      if (id === undefined) return;
      this.edits[id] = e.target.value.trim();
      // Update just this card so Tab still moves on to the next player.
      const card = e.target.closest('.ai-player');
      card.classList.add('changed');
      card.querySelector('.guess')?.remove();
      card.querySelector('[data-confirm]')?.remove();
      const who = (Teams.get(gameTeamId)?.players ?? []).find((r) => this.edits[id] && String(r.number) === this.edits[id]);
      card.querySelector('.who').textContent = who?.name ?? '';
    };
  },
};

const fmtDuration = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`);
