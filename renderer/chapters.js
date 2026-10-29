// YouTube chapters: timestamp lines built from your tags, to paste into a video's description.
// YouTube only shows chapters when the first one is at 0:00, there are at least 3, and each is
// at least 10 seconds long, so the list is built to fit those rules.
const Chapters = {
  stamp(s) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  },

  open() {
    if (!current) return alert('Open a game first.');
    const counts = {};
    for (const t of tags.filter((x) => x.status !== 'rejected' && x.status !== 'suggested')) counts[t.label] = (counts[t.label] ?? 0) + 1;
    if (!Object.keys(counts).length) return alert('Tag some plays first.');
    const prev = new Set([...$('chTypes').querySelectorAll('input:checked')].map((c) => c.value));
    const skip = new Set(['Line change', 'Note', 'Faceoff']);
    $('chTypes').innerHTML = Object.entries(counts).map(([label, n]) => `<label><input type="checkbox" value="${esc(label)}"`
      + ` ${(prev.size ? prev.has(label) : !skip.has(label)) ? 'checked' : ''}> ${esc(label)} <span class="muted">${n}</span></label>`).join('');
    this.render();
    $('chDialog').showModal();
  },

  lines() {
    const types = new Set([...$('chTypes').querySelectorAll('input:checked')].map((c) => c.value));
    const gap = Math.max(10, Number($('chGap').value) || 10);
    const early = $('chEarly').checked;
    const picked = tags.filter((t) => types.has(t.label) && t.status !== 'rejected' && t.status !== 'suggested')
      .map((t) => ({ t, at: Math.max(0, early ? t.time - t.before : t.time) }))
      .sort((a, b) => a.at - b.at);
    // Plays closer together than the gap share one chapter, so every chapter is long enough.
    const chapters = [];
    for (const { t, at } of picked) {
      const name = [t.label, $('chPlayers').checked && t.player ? Teams.label(t.player) : '', $('chNotes').checked ? t.note : '']
        .filter(Boolean).join(' · ');
      const last = chapters.at(-1);
      if (last && at - last.at < gap) { if (!last.names.includes(name)) last.names.push(name); } else chapters.push({ at, names: [name] });
    }
    if (chapters[0]?.at < gap) chapters[0].at = 0; // a play near the start becomes the 0:00 chapter
    else chapters.unshift({ at: 0, names: [$('chStart').value.trim() || 'Start'] });
    return chapters.map((c) => `${this.stamp(c.at)} ${c.names.join(', ')}`);
  },

  render() {
    const lines = this.lines();
    $('chText').value = lines.join('\n');
    $('chNote').textContent = lines.length < 3
      ? 'YouTube needs at least 3 chapters. Pick more kinds of plays.'
      : `${lines.length} chapters. Paste them into the video's description on YouTube.`;
    $('chCopy').disabled = lines.length < 3;
  },

  wire() {
    $('chBtn').onclick = () => this.open();
    for (const id of ['chTypes', 'chGap', 'chEarly', 'chPlayers', 'chNotes', 'chStart']) $(id).oninput = () => this.render();
    $('chTypes').onchange = () => this.render();
    $('chCopy').onclick = async () => {
      await navigator.clipboard.writeText($('chText').value);
      $('chNote').textContent = 'Copied. Paste it into the video\'s description on YouTube.';
    };
  },
};
