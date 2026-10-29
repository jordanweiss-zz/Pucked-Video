// Clips and highlight reels: fine-tune a tag's clip window, save one clip, or join the plays
// you pick into a reel. The cutting is done by ffmpeg in the main process (clips.js).
const Clips = {
  saving: false,

  label: (t) => [t.label, t.player ? Teams.label(t.player) : ''].filter(Boolean).join(' · '),

  window(t) {
    const end = t.time + t.after;
    return { start: Math.max(0, t.time - t.before), end: media.duration ? Math.min(media.duration, end) : end, cropX: t.cropX ?? 0.5 };
  },

  canSave: () => Boolean(current?.path),

  // Longest a clip can reach either side of its tag, in seconds.
  maxSide: 120,

  // The clip controls under the tag you're working on. The clip's start and end can also be
  // dragged on the timeline, or set from where the video is (I and O).
  span(t) {
    const w = this.window(t);
    return `${fmt(w.start)} to ${fmt(w.end)} (${Math.round(w.end - w.start)} s)`;
  },

  row(t, i) {
    return `<div class="clip-row">Clip <input type="number" min="0" max="${this.maxSide}" step="1" data-before="${i}" value="${t.before}" title="Seconds before the tag"> s before,`
      + ` <input type="number" min="0" max="${this.maxSide}" step="1" data-after="${i}" value="${t.after}" title="Seconds after the tag"> s after`
      + ` <button data-preview="${i}" title="Play this clip">▶</button>`
      + `<span class="clip-span">${this.span(t)}</span>`
      + ` <button data-in="${i}" title="Start the clip where the video is now (I)">Start here</button>`
      + ` <button data-out="${i}" title="End the clip where the video is now (O)">End here</button>`
      + (this.canSave() ? ` <button data-save="${i}" title="Save this clip as an MP4">Save clip</button>`
        + ` <button data-save9="${i}" title="Save a vertical (9:16) copy for phones and social media">Save 9:16</button>`
        + ` <button data-frame="${i}" class="${Crop.tag === t ? 'on' : ''}" title="Choose which part of the picture the 9:16 copy shows">Frame 9:16</button>` : '') + '</div>';
  },

  // Move the clip's start or end to a time in the video, keeping the tag inside the clip.
  setEdge(t, edge, time) {
    if (edge === 'start') t.before = Math.round(Math.max(0, Math.min(this.maxSide, t.time - time)) * 10) / 10;
    else t.after = Math.round(Math.max(0, Math.min(this.maxSide, time - t.time)) * 10) / 10;
  },

  setHere(edge) {
    const t = focusTag;
    if (!t) return;
    this.setEdge(t, edge, media.currentTime);
    renderTags();
    save();
  },

  onRowClick(e) {
    const { preview, save, save9, frame } = e.target.dataset;
    if (preview !== undefined) playClip(Number(preview));
    if (save !== undefined) this.saveTag(tags[Number(save)], false);
    if (save9 !== undefined) this.saveTag(tags[Number(save9)], true);
    if (frame !== undefined) { Crop.toggle(tags[Number(frame)]); renderTags(); }
    if (e.target.dataset.in !== undefined) this.setHere('start');
    if (e.target.dataset.out !== undefined) this.setHere('end');
  },

  onRowChange(e) {
    const { before, after } = e.target.dataset;
    const t = tags[Number(before ?? after)];
    if (!t) return;
    const v = Math.max(0, Math.min(this.maxSide, Number(e.target.value) || 0));
    if (before !== undefined) t.before = v; else t.after = v;
    e.target.value = v;
    // Not a full re-render: the list is mid-change and the field may still have focus.
    e.target.closest('.clip-row').querySelector('.clip-span').textContent = this.span(t);
    this.renderBand();
    save();
  },

  // The selected tag's clip as a band on the timeline, with handles to drag its start and end.
  renderBand() {
    const band = $('clipBand');
    const t = focusTag;
    const d = media.duration;
    if (!t || !d || !tags.includes(t) || !visible(t)) { band.hidden = true; return; }
    const w = this.window(t);
    band.hidden = false;
    band.style.left = `${(w.start / d) * 100}%`;
    band.style.width = `${((w.end - w.start) / d) * 100}%`;
    band.title = `Clip ${fmt(w.start)} to ${fmt(w.end)}. Drag the ends to change it.`;
  },

  wireBand() {
    const band = $('clipBand');
    let drag = null;
    const timeAt = (e) => {
      const r = band.parentElement.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * media.duration;
    };
    band.addEventListener('pointerdown', (e) => {
      const edge = e.target.dataset.edge;
      if (!edge || !focusTag) return;
      drag = { edge, t: focusTag };
      media.pause();
      stopClip();
      band.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });
    band.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const time = timeAt(e);
      this.setEdge(drag.t, drag.edge, time);
      media.currentTime = drag.edge === 'start' ? drag.t.time - drag.t.before : drag.t.time + drag.t.after; // show the frame you're on
      this.renderBand();
    });
    band.addEventListener('pointerup', () => {
      if (!drag) return;
      drag = null;
      renderTags();
      save();
    });
  },

  // "VID_..._01_01" from the open video, for default file names next to it.
  base() {
    const p = current.path;
    return p.replace(/\.[^.\\/]+$/, '');
  },

  stamp: (s) => `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, '0')}s`,

  async saveTag(t, vertical) {
    if (!this.canSave()) return alert('Clips can be saved from game videos on your computer, not YouTube links.');
    const out = await window.api.saveVideoAs(`${this.base()} - ${t.label} ${this.stamp(t.time)}${vertical ? ' 9x16' : ''}.mp4`);
    if (out) this.start([{ ...this.window(t), label: this.label(t) }], out, true, vertical);
  },

  // --- Reels ---
  reelPool() {
    return tags.filter((t) => t.status !== 'rejected' && (t.status !== 'suggested' || $('reelSuggested').checked));
  },

  openReel() {
    if (!this.canSave()) return alert('Reels can be made from game videos on your computer, not YouTube links.');
    if (!tags.length) return alert('Tag some plays first.');
    const counts = {};
    for (const t of tags.filter((x) => x.status !== 'rejected')) counts[t.label] = (counts[t.label] ?? 0) + 1;
    const prev = new Set([...$('reelTypes').querySelectorAll('input:checked')].map((c) => c.value));
    // Line changes and notes are rarely highlights, so they start unticked.
    const skip = new Set(['Line change', 'Note']);
    $('reelTypes').innerHTML = Object.entries(counts).map(([label, n]) => `<label><input type="checkbox" value="${esc(label)}"`
      + ` ${(prev.size ? prev.has(label) : !skip.has(label)) ? 'checked' : ''}> ${esc(label)} <span class="muted">${n}</span></label>`).join('');
    const players = new Map(tags.filter((t) => t.player).map((t) => [t.player.id, t.player]));
    $('reelPlayer').innerHTML = '<option value="">Everyone</option>'
      + [...players.values()].sort((a, b) => (Number(a.number) || 999) - (Number(b.number) || 999))
        .map((p) => `<option value="${esc(p.id)}">${esc(Teams.label(p))}</option>`).join('');
    this.renderReel();
    this.renderLogo();
    $('reelVertical').onchange();
    $('reelDialog').showModal();
  },

  // Plays whose clips overlap become one clip, so nothing is shown twice.
  merge(picked) {
    const clips = [];
    for (const t of picked.slice().sort((a, b) => a.time - b.time)) {
      const w = this.window(t);
      const last = clips.at(-1);
      if (last && w.start <= last.end + 0.5) {
        last.end = Math.max(last.end, w.end);
        if (!last.label.split(' + ').includes(this.label(t))) last.label += ` + ${this.label(t)}`;
      } else clips.push({ ...w, label: this.label(t) });
    }
    return clips;
  },

  // How good a play is for an automatic reel: what kind of play, how sure the AI is, a named
  // player, other plays close by, and how much the camera was moving (rushes make it swing).
  weights: { Goal: 10, Highlight: 6, Save: 6, Shot: 5, 'Odd-man rush': 5, Penalty: 4, 'Shot or pass': 3, Faceoff: 1, 'Line change': 0, Note: 0 },
  score(t, pool) {
    let s = (this.weights[t.label] ?? 3) * (t.status === 'suggested' ? t.confidence ?? 0.5 : 1);
    if (t.player) s *= 1.3;
    s += 0.5 * pool.filter((x) => x !== t && Math.abs(x.time - t.time) < 15).length;
    const m = AutoCut.motion;
    if (m) {
      const w = this.window(t);
      const secs = m.slice(Math.floor(w.start), Math.ceil(w.end)).filter((x) => x !== null);
      if (secs.length) s += Math.min(2, secs.reduce((a, b) => a + b, 0) / secs.length / 4);
    }
    return s;
  },

  // The best plays that fit in about `secs` seconds, shown in game order.
  best(picked, secs) {
    const ranked = picked.map((t) => ({ t, s: this.score(t, picked) })).sort((a, b) => b.s - a.s);
    const chosen = [];
    const length = (list) => this.merge(list).reduce((a, c) => a + c.end - c.start, 0);
    for (const { t, s } of ranked) {
      if (s <= 0) break;
      if (length([...chosen, t]) <= secs + 5) chosen.push(t);
    }
    return chosen;
  },

  reelClips() {
    const types = new Set([...$('reelTypes').querySelectorAll('input:checked')].map((c) => c.value));
    const player = $('reelPlayer').value;
    const picked = this.reelPool().filter((t) => types.has(t.label) && (!player || t.player?.id === player));
    const secs = Number($('reelLength').value);
    return this.merge(secs ? this.best(picked, secs) : picked);
  },

  // Auto highlights: every kind of play, AI plays too, cut down to the best two minutes.
  openAuto() {
    $('reelLength').value = '120';
    $('reelSuggested').checked = tags.some((t) => t.status === 'suggested');
    this.openReel();
  },

  renderReel() {
    const clips = this.reelClips();
    const secs = clips.reduce((a, c) => a + c.end - c.start, 0);
    $('reelSummary').textContent = clips.length ? `${clips.length} clip${clips.length === 1 ? '' : 's'}, ${Math.floor(secs / 60)} min ${Math.round(secs % 60)} s long.` : 'No plays picked.';
    $('reelSave').disabled = !clips.length || this.saving;
  },

  async saveReel() {
    const clips = this.reelClips();
    const player = $('reelPlayer').selectedOptions[0];
    const name = `${$('reelPlayer').value ? `${player.textContent} highlights` : 'Highlights'}${Number($('reelLength').value) ? ` best ${$('reelLength').selectedOptions[0].dataset.short}` : ''}`;
    const vertical = $('reelVertical').checked;
    const out = await window.api.saveVideoAs(`${this.base()} - ${name}${vertical ? ' 9x16' : ''}.mp4`);
    if (!out) return;
    $('reelDialog').close();
    this.start(clips, out, $('reelOverlay').checked, vertical);
  },

  // --- Logo, kept in the app's settings so every clip and reel can use it ---
  get logo() {
    AI.settings.logo ??= { file: null, on: false, corner: 'tr', size: 12, opacity: 0.85 };
    return AI.settings.logo;
  },

  saveLogo() { window.api.saveSettings(AI.settings); },

  renderLogo() {
    const l = this.logo;
    $('logoName').textContent = l.file ? l.file.split(/[\\/]/).pop() : 'No logo chosen';
    $('logoOn').checked = Boolean(l.on && l.file);
    $('logoOn').disabled = !l.file;
    $('logoCorner').value = l.corner;
    $('logoSize').value = l.size;
    $('logoOpacity').value = Math.round(l.opacity * 100);
    $('logoPreview').hidden = !l.file;
    if (l.file) $('logoPreview').src = `file:///${encodeURI(l.file.replace(/\\/g, '/').replace(/^\/+/, '')).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
  },

  // What every clip in one export looks like: shape, output height and logo.
  look(vertical) {
    const outW = vertical ? 1080 : video.videoWidth || 1920;
    const outH = vertical ? 1920 : video.videoHeight || 1080;
    const l = this.logo;
    return {
      vertical, outW, outH,
      logo: l.on && l.file ? { file: l.file, corner: l.corner, opacity: l.opacity, width: Math.round((outW * l.size) / 100) } : null,
    };
  },

  // The play name as a PNG (base64) sized for the clip: white text on a dark box, never wider than the picture.
  overlayImage(text, outW, outH) {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    let size = Math.round(outH / (outH > outW ? 34 : 22));
    let font = `600 ${size}px "Segoe UI", system-ui, sans-serif`;
    ctx.font = font;
    const fit = (outW * 0.9) / (ctx.measureText(text).width + size);
    if (fit < 1) { size = Math.floor(size * fit); font = `600 ${size}px "Segoe UI", system-ui, sans-serif`; ctx.font = font; }
    const pad = Math.round(size * 0.45);
    c.width = Math.ceil(ctx.measureText(text).width + pad * 2);
    c.height = Math.ceil(size * 1.3 + pad * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.roundRect(0, 0, c.width, c.height, pad);
    ctx.fill();
    ctx.font = font;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, pad, c.height / 2);
    return c.toDataURL('image/png').split(',')[1];
  },

  async start(clips, out, overlay, vertical = false) {
    const look = this.look(vertical);
    if (overlay) clips = clips.map((c) => ({ ...c, overlay: c.label ? this.overlayImage(c.label, look.outW, look.outH) : null }));
    const res = await window.api.exportClips({ video: current.path, clips, out, look });
    if (!res.ok) return alert(res.error);
    this.saving = true;
    this.out = out;
    this.toast({ state: 'running', pct: 0, clip: 1, clips: clips.length });
  },

  toast(s) {
    $('exportToast').hidden = false;
    const running = s.state === 'running';
    $('exportBar').style.width = `${s.state === 'done' ? 100 : s.pct ?? 0}%`;
    $('exportText').textContent = running
      ? (s.clips > 1 ? `Saving the reel: clip ${s.clip} of ${s.clips}, ${Math.floor(s.pct)}%` : `Saving the clip: ${Math.floor(s.pct)}%`)
      : s.state === 'done' ? `Saved ${s.out.split(/[\\/]/).pop()}`
        : s.state === 'cancelled' ? 'Stopped.' : `Couldn't save it: ${s.error}`;
    $('exportCancel').hidden = !running;
    $('exportShow').hidden = s.state !== 'done';
    $('exportClose').hidden = running;
  },

  wire() {
    window.api.onClipsProgress((s) => {
      if (s.state !== 'running') this.saving = false;
      this.toast(s);
    });
    this.wireBand();
    $('reelBtn').onclick = () => { $('reelLength').value = '0'; this.openReel(); };
    $('reelTypes').onchange = () => this.renderReel();
    $('reelPlayer').onchange = () => this.renderReel();
    $('reelSuggested').onchange = () => this.renderReel();
    $('reelLength').onchange = () => this.renderReel();
    $('autoBtn').onclick = () => this.openAuto();
    $('reelSave').onclick = () => this.saveReel();
    $('reelVertical').onchange = () => { $('reelSoft').hidden = !$('reelVertical').checked || (video.videoHeight || 1080) > 1080; };
    $('reelWide').onchange = $('reelVertical').onchange;
    $('logoPick').onclick = async () => {
      const file = await window.api.pickLogo();
      if (!file) return;
      Object.assign(this.logo, { file, on: true });
      this.saveLogo();
      this.renderLogo();
    };
    $('logoOn').onchange = () => { this.logo.on = $('logoOn').checked; this.saveLogo(); };
    $('logoCorner').onchange = () => { this.logo.corner = $('logoCorner').value; this.saveLogo(); };
    $('logoSize').onchange = () => { this.logo.size = Number($('logoSize').value); this.saveLogo(); };
    $('logoOpacity').onchange = () => { this.logo.opacity = Number($('logoOpacity').value) / 100; this.saveLogo(); };
    $('exportCancel').onclick = () => window.api.cancelClips();
    $('exportShow').onclick = () => window.api.showFile(this.out);
    $('exportClose').onclick = () => { $('exportToast').hidden = true; };
  },
};
