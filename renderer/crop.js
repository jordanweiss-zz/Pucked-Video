// Framing a vertical (9:16) clip: a window the height of the picture that you drag left or right
// over the paused video. Where it sits is kept on the tag as cropX (0 = left edge, 1 = right edge).
const Crop = {
  tag: null, // the tag being framed
  drag: null, // { dx } while dragging, the grab point's offset from the window's left edge

  size() {
    const vw = video.videoWidth, vh = video.videoHeight;
    return { vw, vh, cw: Math.floor((vh * 9) / 32) * 2 };
  },

  toggle(t) {
    if (this.tag === t) { this.close(); return; }
    this.tag = t;
    if (t.cropX === undefined) t.cropX = 0.5;
    video.currentTime = t.time;
    video.pause();
    this.render();
  },

  close() {
    this.tag = null;
    this.drag = null;
    this.render();
  },

  render() {
    const svg = $('cropLayer');
    const { vw, vh, cw } = this.size();
    if (!this.tag || !vw || !tags.includes(this.tag)) { this.tag = null; svg.setAttribute('hidden', ''); svg.innerHTML = ''; return; }
    const x = (vw - cw) * this.tag.cropX;
    svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
    svg.removeAttribute('hidden');
    const line = Math.max(3, Math.round(vh / 200));
    svg.innerHTML = `<rect x="0" y="0" width="${x}" height="${vh}" class="crop-dim"/>`
      + `<rect x="${x + cw}" y="0" width="${vw - x - cw}" height="${vh}" class="crop-dim"/>`
      + `<rect x="${x}" y="${line / 2}" width="${cw}" height="${vh - line}" class="crop-box" stroke-width="${line}"/>`
      + `<text x="${vw / 2}" y="${vh - vh / 20}" class="crop-hint" font-size="${vh / 30}">Drag to frame the 9:16 clip · Esc when done</text>`;
  },

  pointX(e) {
    return new DOMPoint(e.clientX, e.clientY).matrixTransform($('cropLayer').getScreenCTM().inverse()).x;
  },

  move(e) {
    const { vw, cw } = this.size();
    const x = Math.max(0, Math.min(vw - cw, this.pointX(e) - this.drag.dx));
    this.tag.cropX = vw > cw ? Number((x / (vw - cw)).toFixed(3)) : 0.5;
    this.render();
  },

  wire() {
    const svg = $('cropLayer');
    svg.addEventListener('pointerdown', (e) => {
      if (!this.tag) return;
      const { vw, cw } = this.size();
      const left = (vw - cw) * this.tag.cropX;
      const px = this.pointX(e);
      // Grabbing outside the window moves its centre to where you clicked.
      this.drag = { dx: px >= left && px <= left + cw ? px - left : cw / 2 };
      svg.setPointerCapture(e.pointerId);
      this.move(e);
      e.preventDefault();
    });
    svg.addEventListener('pointermove', (e) => { if (this.drag) this.move(e); });
    svg.addEventListener('pointerup', () => { if (this.drag) { this.drag = null; save(); } });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.tag) { this.close(); renderTags(); e.stopPropagation(); }
    }, true);
    video.addEventListener('loadedmetadata', () => this.close());
  },
};
