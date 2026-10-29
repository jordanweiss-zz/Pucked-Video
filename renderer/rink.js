// Rink setup: the user tells Hockey AI where rink markings are by picking a marking on a rink
// diagram and clicking the same spot in the video. Saved as <BASE>_picks.json entries of
// [frame, [ice_x_ft, ice_y_ft], [px, py]] (Hockey_AI app contract, section 5).
const SVG = 'http://www.w3.org/2000/svg';

const Rink = {
  // NHL template feet: x 0-200 left to right as the camera sees it, y 0 at the near boards.
  landmarks: [
    { id: 'goalL', name: 'Left goal (centre of the goal mouth)', x: 11, y: 42.5 },
    { id: 'goalR', name: 'Right goal (centre of the goal mouth)', x: 189, y: 42.5 },
    { id: 'centreDot', name: 'Centre faceoff dot', x: 100, y: 42.5 },
    { id: 'centreFar', name: 'Centre line at far boards', x: 100, y: 85 },
    { id: 'blueLFar', name: 'Left blue line at far boards', x: 75, y: 85 },
    { id: 'blueRFar', name: 'Right blue line at far boards', x: 125, y: 85 },
    { id: 'nLNear', name: 'Neutral dot, left near', x: 80, y: 20.5 },
    { id: 'nLFar', name: 'Neutral dot, left far', x: 80, y: 64.5 },
    { id: 'nRNear', name: 'Neutral dot, right near', x: 120, y: 20.5 },
    { id: 'nRFar', name: 'Neutral dot, right far', x: 120, y: 64.5 },
    { id: 'eLNear', name: 'End-zone dot, left near', x: 31, y: 20.5 },
    { id: 'eLFar', name: 'End-zone dot, left far', x: 31, y: 64.5 },
    { id: 'eRNear', name: 'End-zone dot, right near', x: 169, y: 20.5 },
    { id: 'eRFar', name: 'End-zone dot, right far', x: 169, y: 64.5 },
  ],
  picks: [],
  video: null, // path of the game these picks belong to
  selected: null,
  onDone: () => {},

  byCoords(ice) { return this.landmarks.find((l) => l.x === ice[0] && l.y === ice[1]); },
  fps: () => Math.round(1 / frameDuration) || 30,
  frameNow() { return Math.floor(video.currentTime * this.fps() + 0.001); },

  // What Hockey_AI needs before it can map the rink.
  check(picks = this.picks) {
    const ids = new Set(picks.map((p) => this.byCoords(p[1])?.id));
    const needs = [
      { ok: picks.length >= 8, text: `At least 8 points (${picks.length} so far)` },
      { ok: new Set(picks.map((p) => p[0])).size >= 3, text: 'Points on at least 3 different frames' },
      { ok: ids.has('goalL'), text: 'The left goal, on a frame panned to that end' },
      { ok: ids.has('goalR'), text: 'The right goal, on a frame panned to that end' },
      { ok: ids.has('centreDot') || ids.has('centreFar'), text: 'Centre ice (the centre dot or centre line)' },
    ];
    return { ok: needs.every((n) => n.ok), needs };
  },

  open(videoPath, picks, onDone) {
    this.video = videoPath;
    this.picks = picks.slice();
    this.selected = null;
    this.onDone = onDone;
    video.pause();
    $('tagsPanel').hidden = true;
    $('rinkPanel').hidden = false;
    $('rinkMarks').removeAttribute('hidden'); // an <svg> has no .hidden property
    this.drawMap();
    this.render();
  },

  close() {
    $('rinkPanel').hidden = true;
    $('rinkMarks').setAttribute('hidden', '');
    $('tagsPanel').hidden = false;
    this.onDone(this.picks);
  },

  get isOpen() { return !$('rinkPanel').hidden; },

  drawMap() {
    const sy = (y) => 85 - y; // the near boards are at the bottom, like in the video
    const line = (x, color, w = 1) => `<line x1="${x}" y1="0" x2="${x}" y2="85" stroke="${color}" stroke-width="${w}"/>`;
    const circle = (x, y, r, color) => `<circle cx="${x}" cy="${sy(y)}" r="${r}" fill="none" stroke="${color}" stroke-width="0.6"/>`;
    $('rinkMap').innerHTML = '<rect x="0" y="0" width="200" height="85" rx="28" fill="#e9eef3" stroke="#8b8f98" stroke-width="1"/>'
      + line(11, '#d33', 0.6) + line(189, '#d33', 0.6) + line(75, '#36c', 2) + line(125, '#36c', 2) + line(100, '#d33', 2)
      + circle(100, 42.5, 15, '#36c') + circle(31, 20.5, 15, '#d33') + circle(31, 64.5, 15, '#d33') + circle(169, 20.5, 15, '#d33') + circle(169, 64.5, 15, '#d33')
      + '<path d="M11 38.5 h-4 v8 h4" fill="none" stroke="#d33" stroke-width="0.8"/><path d="M189 38.5 h4 v8 h-4" fill="none" stroke="#d33" stroke-width="0.8"/>'
      + '<text x="100" y="92" font-size="4.5" text-anchor="middle" fill="#8b8f98">camera side</text>'
      + this.landmarks.map((l) => `<circle class="lm" data-lm="${l.id}" cx="${l.x}" cy="${sy(l.y)}" r="3.6"><title>${l.name}</title></circle>`).join('');
  },

  render() {
    const frame = this.frameNow();
    const picked = new Set(this.picks.map((p) => this.byCoords(p[1])?.id));
    const here = new Set(this.picks.filter((p) => p[0] === frame).map((p) => this.byCoords(p[1])?.id));
    for (const c of $('rinkMap').querySelectorAll('.lm')) {
      c.classList.toggle('sel', c.dataset.lm === this.selected);
      c.classList.toggle('picked', picked.has(c.dataset.lm));
      c.classList.toggle('here', here.has(c.dataset.lm));
    }
    const sel = this.landmarks.find((l) => l.id === this.selected);
    $('rinkPicking').textContent = sel ? `Now click the ${sel.name.toLowerCase()} in the video.` : 'Pick a marking on the rink to place it.';
    $('rinkNeeds').innerHTML = this.check().needs.map((n) => `<li class="${n.ok ? 'ok' : ''}">${n.ok ? '✓' : '○'} ${n.text}</li>`).join('');
    // Grouped by frame, so the user can jump back to a frame and see its points.
    const frames = [...new Set(this.picks.map((p) => p[0]))].sort((a, b) => a - b);
    $('rinkPicks').innerHTML = frames.map((f) => `<li><button class="link" data-frame="${f}">${fmt(f / this.fps())}${f === frame ? ' (showing)' : ''}</button><ul>`
      + this.picks.map((p, i) => (p[0] !== f ? '' : `<li>${esc(this.byCoords(p[1])?.name ?? `(${p[1]})`)}<button class="x" data-del-pick="${i}" title="Remove this point">×</button></li>`)).join('')
      + '</ul></li>').join('') || '<li class="muted">None yet</li>';
    this.drawMarks();
  },

  // Points on the frame being shown, drawn over the video. The overlay's viewBox is the video's own
  // pixel grid and it letterboxes the same way the video does, so pixels line up exactly.
  drawMarks() {
    const svg = $('rinkMarks');
    if (!video.videoWidth) return;
    svg.setAttribute('viewBox', `0 0 ${video.videoWidth} ${video.videoHeight}`);
    const frame = this.frameNow();
    svg.innerHTML = this.picks.map((p) => {
      if (p[0] !== frame) return '';
      const [px, py] = p[2];
      return `<circle cx="${px}" cy="${py}" r="9"/><text x="${px + 14}" y="${py - 10}">${esc(this.byCoords(p[1])?.name ?? '')}</text>`;
    }).join('');
  },

  place(e) {
    const lm = this.landmarks.find((l) => l.id === this.selected);
    if (!lm) { $('rinkPicking').textContent = 'Pick a marking on the rink first, then click it in the video.'; return; }
    video.pause();
    const svg = $('rinkMarks');
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
    if (pt.x < 0 || pt.y < 0 || pt.x > video.videoWidth || pt.y > video.videoHeight) return;
    const frame = this.frameNow();
    // One point per marking per frame: clicking again moves it.
    this.picks = this.picks.filter((p) => !(p[0] === frame && p[1][0] === lm.x && p[1][1] === lm.y));
    this.picks.push([frame, [lm.x, lm.y], [Math.round(pt.x), Math.round(pt.y)]]);
    this.selected = null;
    this.save();
    this.render();
  },

  save() { window.api.saveAiPicks(this.video, this.picks); },

  wire() {
    $('rinkMap').onclick = (e) => {
      const id = e.target.dataset?.lm;
      if (id) { this.selected = id === this.selected ? null : id; this.render(); }
    };
    $('rinkMarks').onclick = (e) => this.place(e);
    $('rinkPicks').onclick = (e) => {
      const { frame, delPick } = e.target.dataset;
      if (frame !== undefined) { video.pause(); video.currentTime = (Number(frame) + 0.5) / this.fps(); }
      if (delPick !== undefined) { this.picks.splice(Number(delPick), 1); this.save(); this.render(); }
    };
    $('rinkDone').onclick = () => this.close();
    video.addEventListener('seeked', () => this.isOpen && this.render());
    video.addEventListener('loadedmetadata', () => this.isOpen && this.drawMarks());
    video.addEventListener('timeupdate', () => this.isOpen && this.drawMarks());
  },
};
