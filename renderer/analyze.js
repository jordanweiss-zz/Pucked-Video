// Analyze game: runs Hockey_AI on the open game from start to finish (rink mapping, finding plays,
// reading jersey numbers) with a progress bar, then brings the plays in as suggestions.
const Analyze = {
  status: null, // what's already on disk for the open game (ai:game)
  job: null, // the running or last job, from the main process

  plays: (k) => `${k} play${k === 1 ? '' : 's'}`,

  dur(sec) {
    const m = Math.round(sec / 60);
    return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${Math.max(1, m)} min`;
  },

  isLocalGame: () => Boolean(current?.path),

  async refreshStatus() {
    this.status = this.isLocalGame() ? await window.api.aiGame(AI.dir || null, current.path) : null;
  },

  async open() {
    if (!this.isLocalGame()) return alert('Open a game video from your computer first. Hockey AI can\'t analyze YouTube links.');
    await this.refreshStatus();
    this.job = await window.api.getAiJob();
    this.render();
    if (!$('analyzeDialog').open) $('analyzeDialog').showModal();
  },

  // Overall progress, weighting each step by how long it takes.
  overall(job) {
    const steps = job.steps.filter((s) => s.status !== 'skipped');
    const total = steps.reduce((a, s) => a + s.weight, 0) || 1;
    return steps.reduce((a, s) => a + s.weight * ((s.status === 'done' ? 100 : s.pct ?? 0) / 100), 0) / total * 100;
  },

  // Time left on the current step, from how fast it has gone so far, plus the estimate for the steps after it.
  timeLeft(job) {
    const i = job.steps.findIndex((s) => s.status === 'running');
    const s = job.steps[i];
    if (!s || !s.pct || s.pct < 1) return null;
    const perWeight = ((Date.now() - s.startedAt) / 1000) * (100 / s.pct) / s.weight;
    const rest = job.steps.slice(i + 1).reduce((a, x) => a + x.weight, 0);
    return ((Date.now() - s.startedAt) / 1000) * ((100 - s.pct) / s.pct) + rest * perWeight;
  },

  render() {
    const st = this.status;
    const job = this.job?.video === current?.path ? this.job : null;
    const otherJob = this.job?.state === 'running' && !job ? this.job : null;
    const running = job?.state === 'running';
    const rinkOk = st.calibrated || Rink.check(st.picks).ok;
    const hdOk = !video.videoWidth || (video.videoWidth === 1920 && video.videoHeight === 1080);

    const hours = (media.duration || 0) / 3600;
    const work = hours * ((st.calibrated ? 0 : 1) + (st.analyzed ? 0 : 4.5) + 0.75);
    $('anIntro').textContent = otherJob
      ? `Hockey AI is working on another game (${otherJob.video.split(/[\\/]/).pop()}). Only one game can be analyzed at a time.`
      : `Hockey AI watches the whole game on your graphics card. For this game that takes about ${this.dur(work * 3600)}, so start it before bed. Your PC stays awake while it runs, and you can keep using the app.`;

    const need = (ok, text, fix) => `<li class="${ok ? 'ok' : ''}">${ok ? '✓' : '○'} ${text}${!ok && fix ? ` ${fix}` : ''}</li>`;
    $('anNeeds').innerHTML = need(Boolean(AI.dir) && st.python, AI.dir ? (st.python ? 'Hockey_AI is set up' : 'Hockey_AI has no Python set up in that folder') : 'Choose your Hockey_AI folder', '<button class="link" data-fix="settings">Hockey AI settings…</button>')
      + need(st.hasTrack, st.hasTrack ? 'XBotGo camera log found' : 'No XBotGo camera log next to this video (the hidden .data folder)')
      + (hdOk ? '' : need(false, `Unsupported resolution: Hockey AI needs 1920×1080 video, and this one is ${video.videoWidth}×${video.videoHeight}`))
      + need(rinkOk, st.calibrated ? 'Rink mapped' : rinkOk ? `Rink set up (${st.picks.length} points)` : `Set up the rink (${st.picks.length} of at least 8 points)`, '<button class="link" data-fix="rink">Set up rink…</button>');

    const steps = job?.steps ?? [
      { label: 'Map the rink', status: st.calibrated ? 'skipped' : 'pending' },
      { label: 'Find the plays (uses the graphics card)', status: st.analyzed ? 'skipped' : 'pending' },
      { label: 'Read jersey numbers', status: 'pending' },
      { label: 'Pick the plays to show', status: 'pending' },
    ];
    const icon = { pending: '○', running: '✱', done: '✓', skipped: '✓', failed: '✗', cancelled: '–' };
    $('anSteps').innerHTML = steps.map((s) => `<li class="${s.status}">${icon[s.status] ?? '○'} ${s.label}`
      + (s.status === 'running' ? ` <span class="muted">${Math.floor(s.pct ?? 0)}%${s.resumedFrom ? `, carried on from ${fmt(s.resumedFrom)}` : ''}</span>` : '')
      + (s.status === 'skipped' ? ' <span class="muted">already done</span>' : '') + '</li>').join('');

    const pct = job ? (job.state === 'done' ? 100 : this.overall(job)) : 0;
    $('anBar').style.width = `${pct}%`;
    const left = running ? this.timeLeft(job) : null;
    const cp = running ? null : st.checkpoint;
    const where = cp ? `${cp.step === 'calibrate' ? 'Mapping the rink' : 'Finding the plays'} stopped at ${fmt(cp.resumeFrom)} of the game` : '';
    $('anStatus').textContent = cp && job?.state !== 'done' ? `${where}. Resume carries on from there, so nothing done so far is lost.`
      : !job ? (st.upToDate ? 'This game is analyzed. Change the rink points to run it again.' : '')
      : running ? `${Math.floor(pct)}% done${left ? ` · about ${this.dur(left)} left` : ''}`
        : job.state === 'done' ? (job.kind === 'report' ? 'The report is ready.' : `Done in ${this.dur((job.finishedAt - job.startedAt) / 1000)}. The plays are in your tag list to review.`)
          : job.state === 'cancelled' ? 'Stopped. Start again to carry on where it stopped.' : '';
    $('anError').hidden = job?.state !== 'failed';
    $('anError').textContent = job?.error ? `${job.error}${job.fixable ? '' : ' (Details has more.)'}` : '';

    $('anStart').hidden = running || (st.upToDate && !cp && !['failed', 'cancelled'].includes(job?.state));
    $('anStart').disabled = Boolean(otherJob) || !(AI.dir && st.python && st.hasTrack && rinkOk && hdOk);
    $('anStart').textContent = cp ? `Resume from ${fmt(cp.resumeFrom)}` : job?.state === 'cancelled' || job?.state === 'failed' ? 'Start again' : 'Start analysis';
    $('anFresh').hidden = !cp || running;
    $('anFresh').disabled = $('anStart').disabled;
    $('anCancel').hidden = !running;
    $('anRink').disabled = running;
    $('anLog').textContent = (job?.log ?? []).join('\n');

    $('anCheck').hidden = !st.overlays.length;
    $('anOverlays').innerHTML = st.overlays.map((o, i) => `<img src="${esc(o.url)}" alt="Rink lines over a video frame" title="Click to open full size" data-overlay="${i}">`).join('');

    // Always shown, so the report choices can be found; they work once the game is analyzed.
    $('anReport').classList.toggle('waiting', !st.analyzed);
    $('repWaiting').hidden = st.analyzed;
    this.renderTeams(st);
    this.renderReportChoices(st);
    $('repMake').disabled = running || Boolean(otherJob) || !st.analyzed;
    $('repOpen').hidden = !st.report;
  },

  // Game setup: each team's name, jersey colour and home team, saved with the game for Hockey AI.
  renderTeams(st) {
    const colors = ['', ...(st.teamColors ?? [])];
    const label = (c) => (c ? c.replace('_', ' ').replace(/^./, (x) => x.toUpperCase()) : 'Jersey colour…');
    for (const id of ['teamColorA', 'teamColorB']) {
      if ($(id).options.length !== colors.length) $(id).innerHTML = colors.map((c) => `<option value="${c}">${label(c)}</option>`).join('');
    }
    // Fill the fields once per game, so typing isn't undone by a progress update.
    if (this.teamsFor !== st.files.video) {
      this.teamsFor = st.files.video;
      const g = st.gameTeams ?? {};
      $('repTeamA').value = g.team_a?.name ?? st.teams?.team_a ?? '';
      $('repTeamB').value = g.team_b?.name ?? st.teams?.team_b ?? '';
      $('teamColorA').value = g.team_a?.color ?? '';
      $('teamColorB').value = g.team_b?.color ?? '';
      const home = g.team_a?.home ? 'team_a' : g.team_b?.home ? 'team_b' : '';
      for (const r of document.querySelectorAll('input[name=homeTeam]')) r.checked = r.value === home;
      $('teamsStatus').textContent = '';
    }
    $('teamsWarn').hidden = !st.teamCheck?.ambiguous;
  },

  async saveTeams() {
    const home = document.querySelector('input[name=homeTeam]:checked')?.value;
    const team = (k, name, color) => ({ name: $(name).value.trim(), color: $(color).value, home: home === k });
    const res = await window.api.saveGameTeams(AI.dir || null, current.path,
      { team_a: team('team_a', 'repTeamA', 'teamColorA'), team_b: team('team_b', 'repTeamB', 'teamColorB') });
    if (!res.ok) return alert(res.error);
    $('teamsStatus').textContent = res.updating ? 'Saved. Hockey AI is updating the game with them (no graphics card needed).' : 'Saved.';
    if (res.updating) this.job = await window.api.getAiJob();
    await this.refreshStatus();
    this.render();
  },

  // Report choices: which team it's about, and which players get their own pages.
  async renderReportChoices(st) {
    const names = { team_a: $('repTeamA').value.trim() || st.teams?.team_a || 'Team A', team_b: $('repTeamB').value.trim() || st.teams?.team_b || 'Team B' };
    const focus = $('repFocus').value || 'both';
    $('repFocus').innerHTML = `<option value="both">Both teams</option><option value="team_a">${esc(names.team_a)}</option><option value="team_b">${esc(names.team_b)}</option>`;
    $('repFocus').value = focus;
    if (this.repRun !== st.files.exportFile) {
      this.repRun = st.files.exportFile;
      const run = st.hasExport ? await window.api.loadAiRun(st.files.exportFile).catch(() => null) : null;
      this.repPlayers = (run?.players?.players ?? []).filter((p) => p.number)
        .sort((a, b) => a.team.localeCompare(b.team) || Number(a.number) - Number(b.number));
    }
    const shown = this.repPlayers.filter((p) => focus === 'both' || p.team === focus);
    const picked = new Set([...$('repPlayers').querySelectorAll('input:checked')].map((c) => c.value));
    const team = Teams.get(gameTeamId);
    const who = (p) => {
      const r = team?.players.find((x) => String(x.number) === String(p.number));
      return `${r ? Teams.label(r) : `#${p.number}`} <span class="muted">${esc(names[p.team] ?? '')}</span>`;
    };
    $('repPlayers').innerHTML = shown.length
      ? shown.map((p) => `<label><input type="checkbox" value="${esc(p.player_id)}" ${picked.has(p.player_id) ? 'checked' : ''}> ${who(p)}</label>`).join('')
      : `<span class="muted">${st.analyzed ? 'No named players yet. Name them under AI players.' : 'The players Hockey AI finds will be listed here.'}</span>`;
    $('repPlayersNote').textContent = picked.size ? `Player pages for the ${picked.size} you ticked.` : 'Nobody ticked, so every player gets a page.';
  },

  renderBadge() {
    const j = this.job;
    $('aiJobBadge').hidden = !j || j.state !== 'running';
    if (j?.state === 'running') $('aiJobBadge').textContent = `Hockey AI ${Math.floor(this.overall(j))}%`;
  },

  async start(fresh = false) {
    if (fresh && !confirm('Throw away what was already done and analyze the whole game again from the start?')) return;
    const res = await window.api.analyzeGame(AI.dir, current.path, { fresh, render: $('anRender').checked });
    if (!res.ok) return alert(res.error);
    this.job = await window.api.getAiJob();
    this.render();
  },

  // A finished analysis of the open game comes straight into the tag list.
  async importFinished() {
    await this.refreshStatus();
    if (!this.status?.hasExport) return null;
    return importAiRun(await window.api.loadAiRun(this.status.files.exportFile));
  },

  // Opening a game that Hockey AI already analyzed brings its plays in, once.
  async gameOpened() {
    if (!this.isLocalGame()) return;
    await this.refreshStatus();
    if (this.status.hasExport && !aiRunPath) {
      const { added } = await this.importFinished();
      if (added) $('aiCount').textContent = `${this.plays(added)} from Hockey AI to review`;
    }
  },

  async onJob(job) {
    const was = this.job?.state;
    this.job = job;
    this.renderBadge();
    if (was === 'running' && job.state === 'done' && (job.kind === 'analyze' || job.kind === 'derive') && job.video === current?.path) {
      const res = await this.importFinished();
      if (res && !$('analyzeDialog').open) alert(`Hockey AI finished. ${res.added ? `It added ${this.plays(res.added)} for you to review.` : 'It found no new plays.'}`);
    }
    if (job.state !== 'running' && this.isLocalGame()) await this.refreshStatus();
    if ($('analyzeDialog').open && this.status) this.render();
    GameData.onJob(job);
  },

  wire() {
    window.api.onAiJob((job) => this.onJob(job));
    // Keep the time-left estimate moving between progress lines.
    setInterval(() => { if (this.job?.state === 'running' && $('analyzeDialog').open && this.status) this.render(); }, 15000);
    $('aiAnalyze').onclick = () => this.open();
    $('aiJobBadge').onclick = () => this.open();
    $('anStart').onclick = () => this.start();
    $('anFresh').onclick = () => this.start(true);
    $('anRender').checked = Boolean(AI.settings.aiRender);
    $('anRender').onchange = () => { AI.settings.aiRender = $('anRender').checked; window.api.saveSettings(AI.settings); };
    $('repFocus').onchange = () => this.renderReportChoices(this.status);
    $('teamsSave').onclick = () => this.saveTeams();
    $('repPlayers').onchange = () => this.renderReportChoices(this.status);
    $('anCancel').onclick = async () => {
      if (confirm('Stop the analysis? Starting it again later carries on where it stopped.')) await window.api.cancelAiJob();
    };
    const openRink = () => {
      $('analyzeDialog').close();
      Rink.open(current.path, this.status.picks, () => this.open());
    };
    $('anRink').onclick = openRink;
    $('anNeeds').onclick = (e) => {
      if (e.target.dataset.fix === 'rink') openRink();
      if (e.target.dataset.fix === 'settings') { $('analyzeDialog').close(); AI.open(); }
    };
    $('anDetails').onclick = () => { $('anLog').hidden = !$('anLog').hidden; };
    $('anOverlays').onclick = (e) => { if (e.target.dataset.overlay) window.api.openFile(this.status.overlays[e.target.dataset.overlay].file); };
    $('repMake').onclick = async () => {
      const res = await window.api.makeReport(AI.dir, current.path, {
        title: $('repTitle').value.trim(), teamA: $('repTeamA').value.trim(), teamB: $('repTeamB').value.trim(),
        focusTeam: $('repFocus').value || 'both',
        players: [...$('repPlayers').querySelectorAll('input:checked')].map((c) => c.value),
      });
      if (!res.ok) return alert(res.error);
      this.job = await window.api.getAiJob();
      this.render();
    };
    $('repOpen').onclick = () => window.api.openFile(this.status.report);
  },
};
