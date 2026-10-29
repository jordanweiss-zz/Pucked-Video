// Follow a player: pick someone and step through every stretch of the game they were in.
// Hockey AI's <run>_presence.json says when each tracked player was on screen; your tags and the
// AI's plays with that player fill in when there's no analysis. "Play all" plays just their
// stretches back to back, and "Save as reel" makes one video of them.
const Follow = {
  run: null, // the Hockey AI run (players + presence), when this game has one
  who: null, // { key, label, rosterId, aiIds: [] } being followed
  parts: [], // [[start, end]] stretches for `who`

  async load() {
    this.close();
    this.run = aiRunPath ? await window.api.loadAiRun(aiRunPath).catch(() => null) : null;
  },

  // Everyone there is something to follow for: your roster, and the players Hockey AI tracked.
  people() {
    const out = new Map();
    const team = Teams.get(gameTeamId);
    const add = (key, label, extra) => {
      const p = out.get(key) ?? { key, label, rosterId: null, aiIds: [] };
      if (extra.rosterId) p.rosterId = extra.rosterId;
      if (extra.aiId) p.aiIds.push(extra.aiId);
      out.set(key, p);
    };
    for (const p of team?.players ?? []) add(`r:${p.id}`, Teams.label(p), { rosterId: p.id });
    for (const t of tags) if (t.player) add(`r:${t.player.id}`, Teams.label(t.player), { rosterId: t.player.id });
    const teams = this.run?.teams ?? {};
    for (const p of this.run?.players?.players ?? []) {
      const mine = p.number && team?.players.find((x) => String(x.number) === String(p.number));
      if (mine) add(`r:${mine.id}`, Teams.label(mine), { rosterId: mine.id, aiId: p.player_id });
      else {
        const side = teams[p.team] ? ` (${teams[p.team]})` : '';
        add(`a:${p.player_id}`, p.number ? `#${p.number}${side}` : `Unnamed ${p.player_id}${side}`, { aiId: p.player_id });
      }
    }
    return [...out.values()].filter((p) => this.stretches(p).length);
  },

  stretches(p) {
    const parts = [];
    const presence = this.run?.presence?.schema_version === 1 ? this.run.presence.players ?? {} : {};
    for (const id of p.aiIds) for (const [a, b] of presence[id] ?? []) parts.push([a - 1, b + 1]);
    for (const t of tags) {
      if (t.status === 'rejected') continue;
      if ((p.rosterId && t.player?.id === p.rosterId) || (t.aiPlayerId && p.aiIds.includes(t.aiPlayerId))) {
        parts.push([t.time - t.before, t.time + t.after]);
      }
    }
    const d = media.duration || Infinity;
    parts.sort((x, y) => x[0] - y[0]);
    const merged = [];
    // Stretches a few seconds apart are one: the camera loses a player for a moment all the time.
    for (const [a, b] of parts.map(([a, b]) => [Math.max(0, a), Math.min(d, b)])) {
      const last = merged.at(-1);
      if (last && a <= last[1] + 3) last[1] = Math.max(last[1], b); else merged.push([a, b]);
    }
    return merged.filter(([a, b]) => b - a >= 1);
  },

  open() {
    if (!current) return alert('Open a game first.');
    const people = this.people();
    if (!people.length) {
      return alert(this.run ? 'Nobody to follow yet. Name players under AI players, or tag plays with a player.'
        : 'Tag plays with a player first, or analyze the game with Hockey AI to follow anyone it tracked.');
    }
    $('followWho').innerHTML = people.map((p) => `<option value="${esc(p.key)}">${esc(p.label)}</option>`).join('');
    if (this.who && people.some((p) => p.key === this.who.key)) $('followWho').value = this.who.key;
    $('followBar').hidden = false;
    this.pick();
  },

  pick() {
    this.who = this.people().find((p) => p.key === $('followWho').value) ?? null;
    this.parts = this.who ? this.stretches(this.who) : [];
    if (this.parts.length) this.go(0);
    this.render();
  },

  close() {
    this.who = null;
    this.parts = [];
    $('followBar').hidden = true;
    $('followPlay').checked = false;
    this.render();
  },

  // Which stretch the playhead is in (or the next one after it).
  index() {
    const t = media.currentTime + 0.05;
    const i = this.parts.findIndex(([, b]) => t < b);
    return i < 0 ? this.parts.length : i;
  },

  go(i) {
    if (!this.parts.length) return;
    const k = Math.max(0, Math.min(this.parts.length - 1, i));
    media.currentTime = this.parts[k][0];
    this.render();
  },

  step(dir) {
    const t = media.currentTime;
    const i = this.index();
    // "Back" from inside a stretch goes to its start first, like a music player.
    if (dir < 0) this.go(this.parts[i] && t - this.parts[i][0] > 2 ? i : i - 1);
    else this.go(this.parts[i] && t >= this.parts[i][0] - 0.05 ? i + 1 : i);
  },

  render() {
    const d = media.duration;
    $('followStrip').innerHTML = d && this.who ? this.parts.map(([a, b]) => `<i style="left:${(a / d) * 100}%;width:${Math.max(0.15, ((b - a) / d) * 100)}%"></i>`).join('') : '';
    if (!this.who) return;
    const total = this.parts.reduce((s, [a, b]) => s + b - a, 0);
    const i = this.index();
    const inside = this.parts[i] && media.currentTime >= this.parts[i][0] - 0.05;
    const where = !this.parts.length ? 'Nothing to show' : inside ? `Stretch ${i + 1} of ${this.parts.length}` : `${this.parts.length} stretches`;
    const source = this.run?.presence ? '' : ' · from tagged plays only';
    $('followInfo').textContent = `${where} · ${Math.floor(total / 60)} min ${String(Math.round(total % 60)).padStart(2, '0')} s in all${source}`;
  },

  // With "Play all" on, skip from the end of one stretch to the start of the next.
  onTime() {
    if (!this.who) return;
    this.render();
    if (!$('followPlay').checked || media.paused || clipEnd !== null) return;
    const t = media.currentTime;
    const i = this.index();
    if (i >= this.parts.length) { media.pause(); return; }
    if (t < this.parts[i][0] - 0.3) media.currentTime = this.parts[i][0];
  },

  async saveReel() {
    if (!Clips.canSave()) return alert('Reels can be made from game videos on your computer, not YouTube links.');
    if (!this.parts.length) return;
    const out = await window.api.saveVideoAs(`${Clips.base()} - ${this.who.label.replace(/[\\/:*?"<>|]/g, '')} shifts.mp4`);
    if (!out) return;
    Clips.start(this.parts.map(([start, end]) => ({ start, end, cropX: 0.5, label: this.who.label })), out, false, false);
  },

  wire() {
    $('followBtn').onclick = () => ($('followBar').hidden ? this.open() : this.close());
    $('followWho').onchange = () => this.pick();
    $('followPrev').onclick = () => this.step(-1);
    $('followNext').onclick = () => this.step(1);
    $('followClose').onclick = () => this.close();
    $('followSave').onclick = () => this.saveReel();
    $('followPlay').onchange = () => { if ($('followPlay').checked) { if (this.index() >= this.parts.length) this.go(0); media.play(); } };
  },
};
