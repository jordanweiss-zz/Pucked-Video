// Game data: the numbers Hockey AI saved for the open game (team totals, goals, each player's skating),
// read from its files without running the analysis again. "Update analysis" re-derives them from the
// saved first pass when a newer Hockey AI or new play settings can make better ones (CPU only).
const GameData = {
  data: null,

  num: (n, digits = 0) => (Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: digits }) : '–'),
  mins: (s) => (Number.isFinite(s) ? fmt(s) : '–'),

  teamName(team) {
    const names = this.data?.teams ?? {};
    return names[team] ?? (team === 'team_a' ? 'Team A' : team === 'team_b' ? 'Team B' : 'Unknown team');
  },

  async open() {
    if (!current?.path) return alert('Open a game video from your computer first.');
    $('gameDataDialog').showModal();
    await this.load();
  },

  async load() {
    this.data = await window.api.aiGameData(current.path);
    this.render();
  },

  render() {
    const d = this.data;
    const sh = d.shifts;
    $('gdIntro').textContent = !d.analyzed
      ? 'Hockey AI hasn\'t analyzed this game yet. Use Analyze game first.'
      : sh ? 'From the saved analysis. Nothing is re-run to show these.'
        : 'This game was analyzed before Hockey AI saved skating numbers. Update analysis makes them from the saved results, if it can.';
    this.renderUpdate();
    this.renderTeams();
    this.renderGoals();
    $('gdPlayersSec').hidden = !sh?.players;
    if (sh?.players) {
      const periods = [...new Set(Object.values(sh.players).flatMap((p) => (p.shifts ?? []).map((s) => s.period)))].filter((p) => p != null).sort();
      const keep = $('gdPeriod').value;
      $('gdPeriod').innerHTML = '<option value="">Whole game</option>' + periods.map((p) => `<option value="${esc(p)}">Period ${esc(p)}</option>`).join('');
      $('gdPeriod').value = periods.map(String).includes(keep) ? keep : '';
      this.renderPlayers();
    }
  },

  renderUpdate(job = Analyze.job) {
    const u = this.data?.update;
    const mine = job?.kind === 'derive' && job.video === current?.path;
    const running = mine && job.state === 'running';
    $('gdUpdate').hidden = !(u?.canUpdate || u?.needsGpu || running);
    $('gdUpdateBtn').hidden = !u?.canUpdate || running;
    $('gdUpdateText').textContent = running
      ? `Updating from the saved analysis… ${Math.floor(Analyze.overall(job))}%`
      : u?.canUpdate
        ? `Newer numbers can be made from the saved analysis (${u.stale.join(', ')}). It takes a minute or two and doesn't need the graphics card.`
        : u?.needsGpu ? 'Some numbers need the game to be analyzed again with the graphics card.' : '';
  },

  renderTeams() {
    const sh = this.data.shifts;
    const goals = this.data.goals ?? [];
    const teams = ['team_a', 'team_b'];
    if (!sh?.teams && !goals.length) { $('gdTeams').innerHTML = ''; return; }
    const t = (team) => sh?.teams?.[team] ?? {};
    const row = (label, f) => `<tr><th>${label}</th>${teams.map((team) => `<td>${f(team)}</td>`).join('')}</tr>`;
    $('gdTeams').innerHTML = `<h3>Teams</h3><table class="gd-table"><thead><tr><th></th>${teams.map((team) => `<th>${esc(this.teamName(team))}</th>`).join('')}</tr></thead><tbody>
      ${row('Goals', (team) => goals.filter((g) => g.team === team).length)}
      ${sh?.teams ? row('Distance skated', (team) => `${this.num((t(team).distance_ft ?? NaN) / 5280, 1)} mi`) : ''}
      ${sh?.teams ? row('Sprints', (team) => this.num(t(team).sprints)) : ''}
      ${sh?.teams ? row('Time on camera', (team) => this.mins(t(team).observed_s)) : ''}
      ${Object.entries(this.data.eventCounts ?? {}).filter(([type]) => type !== 'goal').map(([type, c]) => row(esc(AI.types[type] ?? type), (team) => c[team] ?? 0)).join('')}
    </tbody></table>`;
  },

  renderGoals() {
    const goals = this.data.goals ?? [];
    $('gdGoals').innerHTML = goals.length ? `<h3>Goals</h3><ul class="gd-goals">${goals.map((g) => `<li><button class="link" data-seek="${g.window_start_s ?? g.time_s}">${fmt(g.time_s)}</button> ${esc(this.teamName(g.team))}${g.player ? ` · #${esc(g.player)}` : ''}</li>`).join('')}</ul>` : '';
  },

  // One player's numbers over the shifts in the chosen period. Shifts are stretches where the number
  // was readable, so counts and ice time are minimums.
  sum(p, period) {
    const shifts = (p.shifts ?? []).filter((s) => !period || String(s.period) === period);
    const add = (k) => shifts.reduce((a, s) => a + (s[k] ?? 0), 0);
    const zones = {};
    for (const s of shifts) for (const [z, v] of Object.entries(s.zones_s ?? {})) zones[z] = (zones[z] ?? 0) + v;
    const time = add('duration_s');
    return {
      shifts: shifts.length,
      toi: add('toi_clock_s') || time,
      distance: add('distance_ft'),
      top: Math.max(0, ...shifts.map((s) => s.top_speed_mph ?? 0)),
      avg: time ? shifts.reduce((a, s) => a + (s.avg_speed_mph ?? 0) * (s.duration_s ?? 0), 0) / time : NaN,
      sprints: add('sprints'),
      zones,
      first: shifts[0]?.start_s,
    };
  },

  renderPlayers() {
    const period = $('gdPeriod').value;
    const unnamed = $('gdUnnamed').checked;
    const rows = Object.entries(this.data.shifts.players)
      .filter(([, p]) => unnamed || p.number != null)
      .map(([id, p]) => ({ id, p, s: this.sum(p, period) }))
      .filter((r) => r.s.shifts)
      .sort((a, b) => b.s.toi - a.s.toi);
    const zoneKeys = [...new Set(rows.flatMap((r) => Object.keys(r.s.zones)))];
    $('gdPlayers').innerHTML = `<thead><tr><th>Player</th><th>Team</th><th title="At least">Shifts</th><th title="At least">Ice time</th><th>Distance</th><th>Top speed</th><th>Avg speed</th><th>Sprints</th>${zoneKeys.map((z) => `<th>${esc(z[0].toUpperCase() + z.slice(1))} zone</th>`).join('')}</tr></thead><tbody>${rows.map(({ id, p, s }) => `<tr data-seek="${s.first ?? ''}" title="Click to watch their first shift">
      <td>${p.number != null ? `#${esc(p.number)}` : `<span class="muted">${esc(id)}</span>`}</td><td>${esc(this.teamName(p.team))}</td>
      <td>${s.shifts}+</td><td>${this.mins(s.toi)}+</td><td>${this.num(s.distance)} ft</td><td>${this.num(s.top, 1)} mph</td><td>${this.num(s.avg, 1)} mph</td><td>${this.num(s.sprints)}</td>
      ${zoneKeys.map((z) => `<td>${this.mins(s.zones[z])}</td>`).join('')}</tr>`).join('')}</tbody>`;
  },

  onJob(job) {
    if (job?.kind !== 'derive' || !$('gameDataDialog').open || job.video !== current?.path) return;
    if (job.state === 'running') this.renderUpdate(job);
    else if (job.state === 'failed') { this.renderUpdate(job); alert(job.error ?? 'Updating the analysis failed.'); }
    else this.load();
  },

  wire() {
    $('gameDataBtn').onclick = () => this.open();
    $('gdUnnamed').onchange = () => this.renderPlayers();
    $('gdPeriod').onchange = () => this.renderPlayers();
    $('gdUpdateBtn').onclick = async () => {
      const res = await window.api.updateAnalysis(AI.dir, current.path);
      if (!res.ok) return alert(res.error);
      Analyze.job = await window.api.getAiJob();
      this.renderUpdate(Analyze.job);
    };
    $('gameDataDialog').onclick = (e) => {
      const t = e.target.closest('[data-seek]');
      if (!t || t.dataset.seek === '') return;
      media.currentTime = Number(t.dataset.seek);
      $('gameDataDialog').close();
    };
  },
};
