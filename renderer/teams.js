// Teams & Rosters: a modal for adding teams and players (name + jersey number).
// Shared by every game; saved through window.api to teams.json in the app's data folder.
const Teams = {
  data: { teams: [] },
  selectedId: null,
  onChange: () => {},

  async load() {
    this.data = await window.api.loadTeams();
    this.data.teams ??= [];
  },

  save() {
    window.api.saveTeams(this.data);
    this.onChange();
  },

  get(id) { return this.data.teams.find((t) => t.id === id) ?? null; },

  newId: () => Math.random().toString(36).slice(2, 10),

  // "#13 Weiss", "#13" or "Weiss"
  label(p) { return [p.number ? `#${p.number}` : '', p.name].filter(Boolean).join(' '); },

  open() {
    this.selectedId ??= this.data.teams[0]?.id ?? null;
    this.render();
    $('teamsDialog').showModal();
  },

  render() {
    $('teamList').innerHTML = this.data.teams
      .map((t) => `<li data-id="${t.id}" class="${t.id === this.selectedId ? 'sel' : ''}">`
        + `<input class="team-name" data-rename="${t.id}" value="${esc(t.name)}"><span class="muted">${t.players.length}</span>`
        + `<button class="x" data-del-team="${t.id}" title="Remove team">×</button></li>`)
      .join('') || '<li class="muted">No teams yet</li>';
    const team = this.get(this.selectedId);
    $('rosterTitle').textContent = team ? `${team.name} roster` : 'Roster';
    $('playerForm').hidden = !team;
    $('playerList').innerHTML = team
      ? team.players
        .slice()
        .sort((a, b) => (Number(a.number) || 999) - (Number(b.number) || 999))
        .map((p) => `<li><input class="num" type="number" min="0" max="99" data-num="${p.id}" value="${esc(p.number ?? '')}" placeholder="#">`
          + `<input class="pname" data-pname="${p.id}" value="${esc(p.name ?? '')}" placeholder="Name">`
          + `<button class="x" data-del-player="${p.id}" title="Remove player">×</button></li>`)
        .join('') || '<li class="muted">No players yet</li>'
      : '<li class="muted">Add a team first</li>';
  },

  addTeam(name) {
    const team = { id: this.newId(), name, players: [] };
    this.data.teams.push(team);
    this.selectedId = team.id;
    this.save();
    this.render();
  },

  addPlayer(number, name) {
    const team = this.get(this.selectedId);
    if (!team) return;
    team.players.push({ id: this.newId(), number: number || null, name: name || '' });
    this.save();
    this.render();
  },

  wire() {
    $('teamsBtn').onclick = () => this.open();
    $('teamForm').onsubmit = (e) => {
      e.preventDefault();
      const name = $('teamName').value.trim();
      if (name) { this.addTeam(name); $('teamName').value = ''; }
    };
    $('playerForm').onsubmit = (e) => {
      e.preventDefault();
      const number = $('playerNum').value.trim();
      const name = $('playerName').value.trim();
      if (number || name) {
        this.addPlayer(number, name);
        $('playerNum').value = '';
        $('playerName').value = '';
        $('playerNum').focus();
      }
    };
    $('teamList').onclick = (e) => {
      const del = e.target.dataset.delTeam;
      if (del) {
        const team = this.get(del);
        if (confirm(`Remove ${team.name} and its ${team.players.length} players?`)) {
          this.data.teams = this.data.teams.filter((t) => t.id !== del);
          if (this.selectedId === del) this.selectedId = this.data.teams[0]?.id ?? null;
          this.save();
          this.render();
        }
        return;
      }
      const li = e.target.closest('li[data-id]');
      if (li && li.dataset.id !== this.selectedId) { this.selectedId = li.dataset.id; this.render(); }
    };
    $('teamList').onchange = (e) => {
      const team = this.get(e.target.dataset.rename);
      if (team && e.target.value.trim()) { team.name = e.target.value.trim(); this.save(); this.render(); }
    };
    $('playerList').onclick = (e) => {
      const id = e.target.dataset.delPlayer;
      if (!id) return;
      const team = this.get(this.selectedId);
      team.players = team.players.filter((p) => p.id !== id);
      this.save();
      this.render();
    };
    $('playerList').onchange = (e) => {
      const team = this.get(this.selectedId);
      const p = team?.players.find((x) => x.id === (e.target.dataset.num ?? e.target.dataset.pname));
      if (!p) return;
      if (e.target.dataset.num) p.number = e.target.value.trim() || null;
      else p.name = e.target.value.trim();
      this.save();
    };
  },
};
