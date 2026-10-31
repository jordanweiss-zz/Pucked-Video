// Drawing on the video for coaching: pen, arrows, lines and circles on a paused frame.
// Drawings are kept per frame in the game's tags file and come back whenever you pause on that
// frame. "Save picture" writes the frame with the drawing on it as a PNG.
const Draw = {
  drawings: [], // [{ time, shapes: [{ tool, color, points: [[x, y], ...] }] }], in video pixels
  tool: 'arrow',
  color: '#ffd33d',
  active: false,
  shape: null, // the one being drawn

  colors: ['#ffd33d', '#ff4d4f', '#ffffff', '#3e8bff', '#3ddc84'],

  frameTime: () => Math.round(video.currentTime / frameDuration) * frameDuration,
  sameFrame: (a, b) => Math.abs(a - b) < frameDuration / 2,
  here() { return this.drawings.find((d) => this.sameFrame(d.time, video.currentTime)); },

  load(saved) { this.drawings = saved ?? []; this.render(); },

  get width() { return Math.max(3, Math.round((video.videoHeight || 1080) / 160)); },

  // SVG for one shape, in the video's own pixel grid.
  shapeSvg(s) {
    const w = this.width;
    const stroke = `stroke="${s.color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
    const [a, b = a] = [s.points[0], s.points.at(-1)];
    if (s.tool === 'pen') return `<polyline points="${s.points.map((p) => p.join(',')).join(' ')}" ${stroke}/>`;
    if (s.tool === 'circle') {
      return `<ellipse cx="${(a[0] + b[0]) / 2}" cy="${(a[1] + b[1]) / 2}" rx="${Math.abs(b[0] - a[0]) / 2}" ry="${Math.abs(b[1] - a[1]) / 2}" ${stroke}/>`;
    }
    let svg = `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" ${stroke}/>`;
    if (s.tool === 'arrow') {
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const len = w * 5;
      const head = [ang - 0.45, ang + 0.45].map((t) => [b[0] - len * Math.cos(t), b[1] - len * Math.sin(t)]);
      svg += `<polyline points="${head[0].join(',')} ${b.join(',')} ${head[1].join(',')}" ${stroke}/>`;
    }
    return svg;
  },

  shapes() { return (this.here()?.shapes ?? []).concat(this.shape ? [this.shape] : []); },

  render() {
    const svg = $('drawLayer');
    if (!video.videoWidth || current?.path === undefined) { svg.setAttribute('hidden', ''); return; }
    svg.setAttribute('viewBox', `0 0 ${video.videoWidth} ${video.videoHeight}`);
    const show = this.active || (video.paused && this.here());
    svg.toggleAttribute('hidden', !show);
    svg.classList.toggle('active', this.active);
    svg.innerHTML = show ? this.shapes().map((s) => this.shapeSvg(s)).join('') : '';
    renderMarkers();
  },

  // Timeline marks for frames with drawings.
  markers(d) {
    return this.drawings.map((x) => `<i class="drawn" style="left:${(x.time / d) * 100}%" data-drawing="${x.time}" title="${fmt(x.time)} drawing"></i>`).join('');
  },

  open() {
    if (!current?.path) return alert('Drawing works on game videos from your computer, not YouTube links.');
    video.pause();
    this.active = true;
    $('drawBar').hidden = false;
    this.renderBar();
    this.render();
  },

  close() {
    this.active = false;
    this.shape = null;
    $('drawBar').hidden = true;
    this.render();
  },

  renderBar() {
    for (const b of $('drawBar').querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === this.tool);
    $('drawColors').innerHTML = this.colors.map((c) => `<button data-color="${c}" class="${c === this.color ? 'on' : ''}" style="--c:${c}" title="Colour"></button>`).join('');
  },

  point(e) {
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform($('drawLayer').getScreenCTM().inverse());
    return [Math.round(Math.max(0, Math.min(video.videoWidth, p.x))), Math.round(Math.max(0, Math.min(video.videoHeight, p.y)))];
  },

  down(e) {
    if (!this.active) return;
    video.pause();
    $('drawLayer').setPointerCapture(e.pointerId);
    this.shape = { tool: this.tool, color: this.color, points: [this.point(e)] };
  },

  move(e) {
    if (!this.shape) return;
    const p = this.point(e);
    if (this.shape.tool === 'pen') this.shape.points.push(p); else this.shape.points[1] = p;
    this.render();
  },

  up() {
    if (!this.shape) return;
    const s = this.shape;
    this.shape = null;
    if (s.points.length < 2) { this.render(); return; }
    let d = this.here();
    if (!d) { d = { time: this.frameTime(), shapes: [] }; this.drawings.push(d); this.drawings.sort((a, b) => a.time - b.time); }
    d.shapes.push(s);
    this.render();
    save();
  },

  undo() {
    const d = this.here();
    if (!d) return;
    d.shapes.pop();
    if (!d.shapes.length) this.drawings = this.drawings.filter((x) => x !== d);
    this.render();
    save();
  },

  clear() {
    this.drawings = this.drawings.filter((x) => x !== this.here());
    this.render();
    save();
  },

  // The drawing alone as a transparent PNG the size of the video; the server puts the frame under it.
  async drawingPng(shapes = this.shapes()) {
    const w = video.videoWidth, h = video.videoHeight;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${shapes.map((s) => this.shapeSvg(s)).join('')}</svg>`;
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/png').split(',')[1];
  },

  async savePicture() {
    const base = current.path.replace(/\.[^.\\/]+$/, '');
    const t = video.currentTime;
    const out = await window.api.savePictureAs(`${base} - ${Clips.stamp(t)}.png`);
    if (!out) return;
    const res = await window.api.saveFrame({ video: current.path, time: t, overlay: await this.drawingPng(), out });
    if (!res.ok) alert(`Couldn't save the picture: ${res.error}`);
    else window.api.showFile(out);
  },

  wire() {
    const layer = $('drawLayer');
    layer.addEventListener('pointerdown', (e) => this.down(e));
    layer.addEventListener('pointermove', (e) => this.move(e));
    layer.addEventListener('pointerup', () => this.up());
    layer.addEventListener('pointercancel', () => this.up());
    $('drawBtn').onclick = () => (this.active ? this.close() : this.open());
    $('drawBar').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tool) { this.tool = b.dataset.tool; this.renderBar(); }
      if (b.dataset.color) { this.color = b.dataset.color; this.renderBar(); }
      if (b.id === 'drawUndo') this.undo();
      if (b.id === 'drawClear') this.clear();
      if (b.id === 'drawSave') this.savePicture();
      if (b.id === 'drawDone') this.close();
    };
    for (const ev of ['seeked', 'pause', 'play', 'loadedmetadata']) video.addEventListener(ev, () => this.render());
  },
};
