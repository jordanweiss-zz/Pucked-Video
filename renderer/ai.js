// Hockey AI in the app: where Hockey_AI lives, its play filters (config/events.json), and
// importing a finished run's plays as suggested tags the user accepts or rejects.
const AI = {
  settings: {},

  // Hockey_AI's 7 play types, in the order the settings panel shows them.
  types: {
    shot_vs_pass: 'Shot or pass',
    odd_man_rush: 'Odd-man rush',
    zone_entry: 'Zone entry',
    breakout: 'Breakout',
    defensive_play: 'Defensive play',
    forecheck: 'Forecheck',
    missed_opportunity: 'Missed chance',
  },
  color: '#b48cff',
  config: null, // events.json as loaded

  async load() {
    this.settings = await window.api.loadSettings();
  },

  get dir() { return this.settings.hockeyAiDir ?? ''; },

  async setDir(dir) {
    this.settings.hockeyAiDir = dir;
    await window.api.saveSettings(this.settings);
  },

  async open() {
    $('aiDir').textContent = this.dir || 'Not set';
    await this.loadConfig();
    $('aiDialog').showModal();
  },

  async loadConfig() {
    this.config = null;
    $('aiTypes').innerHTML = '';
    $('aiStatus').textContent = '';
    if (!this.dir) { $('aiStatus').textContent = 'Choose your Hockey_AI folder to change its settings.'; return; }
    try {
      this.config = await window.api.loadAiEvents(this.dir);
    } catch (err) {
      $('aiStatus').textContent = `Couldn't read Hockey_AI's settings: ${err.message}`;
      return;
    }
    if (!this.config) { $('aiStatus').textContent = 'That folder has no config/events.json. Is it the Hockey_AI folder?'; return; }
    const c = this.config;
    const conf = (t) => c.min_confidence?.[t] ?? c.min_confidence?.default ?? 0.7;
    const cool = (t) => c.cooldown_sec?.[t] ?? c.cooldown_sec?.default ?? 10;
    $('aiTypes').innerHTML = Object.entries(this.types)
      .map(([t, label]) => `<tr data-type="${t}">`
        + `<td><label><input type="checkbox" data-k="enabled" ${c.enabled?.[t] !== false ? 'checked' : ''}> ${label}</label></td>`
        + `<td><input type="range" min="0" max="100" step="5" data-k="conf" value="${Math.round(conf(t) * 100)}"><span>${Math.round(conf(t) * 100)}%</span></td>`
        + `<td><input type="number" min="0" max="120" step="1" data-k="cool" value="${cool(t)}"> s</td></tr>`)
      .join('');
    $('aiGap').value = c.cooldown_sec?.global ?? 0;
  },

  // Write every per-type value explicitly, keeping any keys the panel doesn't know about.
  async saveConfig() {
    if (!this.config) return;
    const c = this.config;
    c.enabled ??= {}; c.min_confidence ??= {}; c.cooldown_sec ??= {};
    for (const row of $('aiTypes').querySelectorAll('tr')) {
      const t = row.dataset.type;
      c.enabled[t] = row.querySelector('[data-k=enabled]').checked;
      c.min_confidence[t] = Number(row.querySelector('[data-k=conf]').value) / 100;
      c.cooldown_sec[t] = Number(row.querySelector('[data-k=cool]').value) || 0;
    }
    c.cooldown_sec.global = Number($('aiGap').value) || 0;
    await window.api.saveAiEvents(this.dir, c);
    $('aiStatus').textContent = 'Saved. New settings apply to the next analysis.';
  },

  // Turn a run's events into suggested tags. Earlier suggestions that weren't accepted are replaced;
  // accepted and rejected ones are kept, so a re-import never brings back a play you rejected.
  importRun(run, gameTeam) {
    const roster = gameTeam?.players ?? [];
    const key = (type, time) => `${type}@${time.toFixed(1)}`;
    const before = new Set(tags.filter((t) => t.status === 'suggested').map((t) => key(t.aiType, t.time)));
    const kept = tags.filter((t) => !(t.source === 'ai' && t.status === 'suggested'));
    const existing = new Set(kept.filter((t) => t.source === 'ai').map((t) => key(t.aiType, t.time)));
    const fresh = run.data.events
      .filter((e) => !existing.has(key(e.type, e.time_s)))
      .map((e) => {
        const p = e.player ? roster.find((x) => String(x.number) === String(e.player)) : null;
        return {
          label: this.types[e.type] ?? e.type,
          time: e.time_s, // already in seconds of the source recording
          before: 6,
          after: 4,
          color: this.color,
          source: 'ai',
          status: 'suggested',
          aiType: e.type,
          confidence: e.confidence,
          note: e.description ?? '',
          ...(p ? { player: { id: p.id, number: p.number, name: p.name } } : {}),
        };
      });
    tags = kept.concat(fresh).sort((a, b) => a.time - b.time);
    return { added: fresh.filter((t) => !before.has(key(t.aiType, t.time))).length, toReview: fresh.length };
  },

  wire() {
    $('aiBtn').onclick = () => this.open();
    $('aiPickDir').onclick = async () => {
      const dir = await window.api.pickFolder('Choose your Hockey_AI folder');
      if (!dir) return;
      await this.setDir(dir);
      $('aiDir').textContent = dir;
      await this.loadConfig();
    };
    $('aiTypes').oninput = (e) => {
      if (e.target.dataset.k === 'conf') e.target.nextElementSibling.textContent = `${e.target.value}%`;
    };
    $('aiSave').onclick = () => this.saveConfig();
  },
};
