// Auto-Cut: find the stoppages in a game and cut them out, for a condensed game you can watch in
// less time. The app listens for the referee's whistle (play stops) and watches the XBotGo camera
// (it holds still on the faceoff dot until the puck drops). Your tagged plays are never cut.
const AutoCut = {
  scan: null, // { whistles: [{ time, length, strength, hz }], duration } from the sound, saved with the game
  motion: null, // degrees the camera turned in each second, from the XBotGo log
  busy: false,

  sensitivity: { low: 30, normal: 18, high: 12 }, // how clear a whistle's tone must be

  get opts() {
    AI.settings.autocut ??= {};
    const o = AI.settings.autocut;
    o.keepAfter ??= 2; o.keepBefore ??= 3; o.sens ??= 'normal'; o.still ??= true; o.stillMin ??= 20; o.stop ??= 30; o.skip ??= false;
    return o;
  },

  async load(saved) {
    this.scan = saved ?? null;
    this.motion = current?.path ? await window.api.loadCameraMotion(current.path) : null;
    this.render();
  },

  whistles() {
    const min = this.sensitivity[this.opts.sens] ?? 18;
    return (this.scan?.whistles ?? []).filter((w) => w.strength >= min);
  },

  // When play starts again after a whistle: the camera holds still on the faceoff dot, and play is
  // back on when it starts to move after that. Without the camera log, use the usual stoppage length.
  resume(after, limit) {
    const m = this.motion;
    const fallback = Math.min(limit, after + this.opts.stop);
    if (!m) return fallback;
    for (let s = Math.ceil(after + 3); s < Math.min(limit, after + 90, m.length); s++) {
      let still = 0;
      while (s + still < m.length && m[s + still] !== null && m[s + still] < 0.5) still++;
      if (still >= 3) return Math.min(limit, s + still);
      s += still;
    }
    return fallback;
  },

  // The parts to cut, as [[start, end]] in seconds.
  cuts() {
    const o = this.opts;
    const d = media.duration || this.scan?.duration || 0;
    if (!d || (!this.scan && !this.motion)) return [];
    let cuts = [];
    const ws = this.whistles();
    ws.forEach((w, i) => {
      const end = w.time + w.length;
      const next = ws[i + 1]?.time ?? d;
      cuts.push([end + o.keepAfter, this.resume(end, next) - o.keepBefore]);
    });
    // The camera holding still for a long time: a timeout, an injury or the break between periods.
    if (o.still && this.motion) {
      const m = this.motion;
      for (let s = 0; s < m.length; s++) {
        let n = 0;
        while (s + n < m.length && (m[s + n] === null || m[s + n] < 0.5)) n++;
        if (n >= o.stillMin) cuts.push([s + o.keepAfter, s + n - o.keepBefore]);
        s += n;
      }
    }
    // Never cut into a play you tagged.
    for (const t of tags.filter((x) => x.status !== 'rejected' && x.status !== 'suggested')) {
      const a = t.time - t.before, b = t.time + t.after;
      cuts = cuts.flatMap(([s, e]) => (e <= a || s >= b ? [[s, e]] : [[s, a], [b, e]]));
    }
    cuts = cuts.map(([s, e]) => [Math.max(0, s), Math.min(d, e)]).filter(([s, e]) => e - s >= 4).sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const c of cuts) {
      const last = merged.at(-1);
      if (last && c[0] <= last[1]) last[1] = Math.max(last[1], c[1]); else merged.push(c.slice());
    }
    return merged;
  },

  keep(cuts = this.cuts()) {
    const d = media.duration || this.scan?.duration;
    const keep = [];
    let at = 0;
    for (const [s, e] of cuts) { if (s > at) keep.push([at, s]); at = e; }
    if (d - at > 0.5) keep.push([at, d]);
    return keep;
  },

  // The cut parts, shaded on the timeline.
  render() {
    const d = media.duration;
    const show = d && (this.scan || this.motion) && ($('cutDialog').open || this.opts.skip);
    $('cutStrip').innerHTML = show ? this.cuts().map(([s, e]) => `<i style="left:${(s / d) * 100}%;width:${((e - s) / d) * 100}%"></i>`).join('')
      + (this.scan ? this.whistles().map((w) => `<b style="left:${(w.time / d) * 100}%" title="${fmt(w.time)} whistle"></b>`).join('') : '') : '';
  },

  // While watching with "skip" on, jump over the cut parts.
  onTime() {
    if (!this.opts.skip || media.paused || clipEnd !== null) return;
    const t = media.currentTime;
    const c = this.cuts().find(([s, e]) => t >= s && t < e - 0.3);
    if (c) media.currentTime = c[1];
  },

  changed() {
    window.api.saveSettings(AI.settings);
    this.renderDialog();
    this.render();
  },

  open() {
    if (!current?.path) return alert('Auto-Cut works on game videos from your computer, not YouTube links.');
    const o = this.opts;
    $('cutKeepAfter').value = o.keepAfter;
    $('cutKeepBefore').value = o.keepBefore;
    $('cutSens').value = o.sens;
    $('cutStill').checked = o.still;
    $('cutStillMin').value = o.stillMin;
    $('cutStop').value = o.stop;
    $('cutSkip').checked = o.skip;
    $('cutDialog').showModal();
    this.renderDialog();
    this.render();
  },

  renderDialog() {
    const d = media.duration || 0;
    const cuts = this.cuts();
    const cut = cuts.reduce((a, [s, e]) => a + e - s, 0);
    const mins = (s) => `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s`;
    $('cutFind').textContent = this.scan ? 'Listen again' : 'Find the stoppages';
    $('cutFind').hidden = this.busy;
    $('cutCamera').textContent = this.motion ? 'Uses the XBotGo camera log to see when play starts again.'
      : 'No XBotGo camera log next to this video, so each stoppage is taken to last about the time below.';
    $('cutStopRow').hidden = Boolean(this.motion);
    $('cutStillRow').hidden = !this.motion;
    $('cutSummary').textContent = !this.scan && !this.motion ? 'Click "Find the stoppages" first. It reads the sound of the game, which takes a minute or two.'
      : `${this.scan?.silent ? 'This video has no sound, so only the camera is used. ' : this.scan ? `${this.whistles().length} whistles heard. ` : ''}Cuts ${cuts.length} part${cuts.length === 1 ? '' : 's'}, ${mins(cut)} in all, so the game goes from ${mins(d)} to ${mins(d - cut)}.`;
    $('cutSave').disabled = !cuts.length || this.busy;
  },

  async find() {
    this.busy = true;
    $('cutProgress').hidden = false;
    $('cutBar').style.width = '0%';
    $('cutStatus').textContent = 'Listening for whistles…';
    this.renderDialog();
    const res = await window.api.scanDeadTime(current.path);
    this.busy = false;
    $('cutProgress').hidden = true;
    if (res.ok) {
      this.scan = { whistles: res.whistles, duration: res.duration, silent: res.silent };
      this.motion = res.motion;
      save();
    } else if (!res.cancelled) alert(`Couldn't read the sound: ${res.error}`);
    this.changed();
  },

  async saveVideo() {
    const keep = this.keep();
    const out = await window.api.saveVideoAs(`${Clips.base()} - condensed.mp4`);
    if (!out) return;
    this.busy = true;
    this.renderDialog();
    $('cutProgress').hidden = false;
    $('cutBar').style.width = '0%';
    $('cutStatus').textContent = 'Saving the condensed game…';
    const res = await window.api.saveCondensed({ video: current.path, keep, out });
    this.busy = false;
    $('cutProgress').hidden = true;
    this.renderDialog();
    if (res.ok) {
      $('cutSummary').textContent = `Saved ${out.split(/[\\/]/).pop()}.`;
      window.api.showFile(out);
    } else if (!res.cancelled) alert(`Couldn't save it: ${res.error}`);
  },

  wire() {
    $('cutBtn').onclick = () => this.open();
    $('cutFind').onclick = () => this.find();
    $('cutSave').onclick = () => this.saveVideo();
    $('cutCancel').onclick = () => window.api.cancelAutoCut();
    $('cutDialog').addEventListener('close', () => this.render());
    const num = (id, key, lo, hi) => {
      $(id).onchange = () => {
        const v = Math.max(lo, Math.min(hi, Number($(id).value) || 0));
        $(id).value = v;
        this.opts[key] = v;
        this.changed();
      };
    };
    num('cutKeepAfter', 'keepAfter', 0, 15);
    num('cutKeepBefore', 'keepBefore', 0, 15);
    num('cutStillMin', 'stillMin', 8, 300);
    num('cutStop', 'stop', 5, 120);
    $('cutSens').onchange = () => { this.opts.sens = $('cutSens').value; this.changed(); };
    $('cutStill').onchange = () => { this.opts.still = $('cutStill').checked; this.changed(); };
    $('cutSkip').onchange = () => { this.opts.skip = $('cutSkip').checked; this.changed(); };
    window.api.onAutoCutProgress((s) => { $('cutBar').style.width = `${s.pct}%`; });
  },
};
