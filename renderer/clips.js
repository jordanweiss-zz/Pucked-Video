// Clips and highlight reels: fine-tune a tag's clip window, save one clip, or join the plays
// you pick into a reel. The cutting is done by ffmpeg in the main process (clips.js).
const Clips = {
  saving: false,

  label: (t) => [t.label, t.player ? Teams.label(t.player) : ''].filter(Boolean).join(' · '),

  window(t) {
    const end = t.time + t.after;
    return { start: Math.max(0, t.time - t.before), end: media.duration ? Math.min(media.duration, end) : end };
  },

  canSave: () => Boolean(current?.path),

  // The clip controls under the tag you're working on.
  row(t, i) {
    return `<div class="clip-row">Clip <input type="number" min="0" max="30" step="1" data-before="${i}" value="${t.before}" title="Seconds before the tag"> s before,`
      + ` <input type="number" min="0" max="30" step="1" data-after="${i}" value="${t.after}" title="Seconds after the tag"> s after`
      + ` <button data-preview="${i}" title="Play this clip">▶</button>`
      + (this.canSave() ? ` <button data-save="${i}" title="Save this clip as an MP4">Save clip</button>` : '') + '</div>';
  },

  onRowClick(e) {
    const { preview, save } = e.target.dataset;
    if (preview !== undefined) playClip(Number(preview));
    if (save !== undefined) this.saveTag(tags[Number(save)]);
  },

  onRowChange(e) {
    const { before, after } = e.target.dataset;
    const t = tags[Number(before ?? after)];
    if (!t) return;
    const v = Math.max(0, Math.min(30, Number(e.target.value) || 0));
    if (before !== undefined) t.before = v; else t.after = v;
    e.target.value = v;
    save();
  },

  // "VID_..._01_01" from the open video, for default file names next to it.
  base() {
    const p = current.path;
    return p.replace(/\.[^.\\/]+$/, '');
  },

  stamp: (s) => `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, '0')}s`,

  async saveTag(t) {
    if (!this.canSave()) return alert('Clips can be saved from game videos on your computer, not YouTube links.');
    const out = await window.api.saveVideoAs(`${this.base()} - ${t.label} ${this.stamp(t.time)}.mp4`);
    if (out) this.start([{ ...this.window(t), label: this.label(t) }], out, true);
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
    $('reelDialog').showModal();
  },

  reelClips() {
    const types = new Set([...$('reelTypes').querySelectorAll('input:checked')].map((c) => c.value));
    const player = $('reelPlayer').value;
    const picked = this.reelPool().filter((t) => types.has(t.label) && (!player || t.player?.id === player));
    // Plays whose clips overlap become one clip, so nothing is shown twice.
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

  renderReel() {
    const clips = this.reelClips();
    const secs = clips.reduce((a, c) => a + c.end - c.start, 0);
    $('reelSummary').textContent = clips.length ? `${clips.length} clip${clips.length === 1 ? '' : 's'}, ${Math.floor(secs / 60)} min ${Math.round(secs % 60)} s long.` : 'No plays picked.';
    $('reelSave').disabled = !clips.length || this.saving;
  },

  async saveReel() {
    const clips = this.reelClips();
    const player = $('reelPlayer').selectedOptions[0];
    const name = $('reelPlayer').value ? `${player.textContent} highlights` : 'Highlights';
    const out = await window.api.saveVideoAs(`${this.base()} - ${name}.mp4`);
    if (!out) return;
    $('reelDialog').close();
    this.start(clips, out, $('reelOverlay').checked);
  },

  // The play name as a PNG (base64) sized for the video: white text on a dark box.
  overlayImage(text) {
    const h = video.videoHeight || 1080;
    const size = Math.round(h / 22);
    const pad = Math.round(size * 0.45);
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const font = `600 ${size}px "Segoe UI", system-ui, sans-serif`;
    ctx.font = font;
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

  async start(clips, out, overlay) {
    if (overlay) clips = clips.map((c) => ({ ...c, overlay: c.label ? this.overlayImage(c.label) : null }));
    const res = await window.api.exportClips({ video: current.path, clips, out });
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
    $('reelBtn').onclick = () => this.openReel();
    $('reelTypes').onchange = () => this.renderReel();
    $('reelPlayer').onchange = () => this.renderReel();
    $('reelSuggested').onchange = () => this.renderReel();
    $('reelSave').onclick = () => this.saveReel();
    $('exportCancel').onclick = () => window.api.cancelClips();
    $('exportShow').onclick = () => window.api.showFile(this.out);
    $('exportClose').onclick = () => { $('exportToast').hidden = true; };
  },
};
