// Review clips: record yourself going through a play. Press Record, then play, pause, slow it down,
// step frames and draw as usual while you talk. The video is made the way you showed it: your voice,
// the drawings on the frames you paused on, and the game's own sound turned down underneath.
// It's saved as an MP4 next to the game, and can go straight to your YouTube channel.
const Review = {
  tag: null, // the play being reviewed, or null when started from where the video is
  rec: null, // while recording: { recorder, chunks, stream, segs, cur, t0, timer }
  take: null, // the last recording: { segs, voice: Blob | null, ext, secs }
  saved: null, // the file the last review was saved to
  saving: false,
  maxSecs: 20 * 60,

  // --- Recording ---------------------------------------------------------------------------

  open(tag = null) {
    if (!current?.path) return alert('Review clips can be made from game videos on your computer, not YouTube links.');
    if (this.rec) return;
    this.tag = tag;
    media.pause();
    stopClip();
    if (tag) {
      focusTag = tag;
      media.currentTime = Clips.window(tag).start;
      renderTags();
    }
    $('revBar').hidden = false;
    this.renderBar();
  },

  close() {
    if (this.rec) this.stop(true);
    $('revBar').hidden = true;
  },

  renderBar() {
    const on = Boolean(this.rec);
    $('revRec').textContent = on ? '■ Stop' : '● Record';
    $('revRec').classList.toggle('rec', on);
    $('revBar').classList.toggle('recording', on);
    $('revTime').textContent = on ? fmt((performance.now() - (this.rec.t0 ?? performance.now())) / 1000) : '';
    const w = this.tag && Clips.window(this.tag);
    $('revHint').textContent = on
      ? 'Recording. Play, pause, slow it down and draw while you talk. Press Stop when you\'re done.'
      : `${w ? `${this.tag.label} at ${fmt(this.tag.time)}, ${fmt(w.start)} to ${fmt(w.end)}. ` : ''}Press Record, then talk through the play.`;
  },

  // What's on screen now: the video playing, or one frame held with whatever is drawn on it.
  shapesNow: () => (media.paused ? Draw.here()?.shapes ?? [] : []),
  snapshot(now) {
    const t = media.currentTime;
    if (media.paused || video.seeking) {
      const shapes = this.shapesNow().map((s) => ({ ...s, points: s.points.slice() }));
      return { kind: 'hold', at: t, shapes, key: JSON.stringify(shapes), since: now };
    }
    return { kind: 'play', from: t, last: t, lastAt: now, rate: media.playbackRate, since: now };
  },

  // Called about 25 times a second while recording. A new segment starts whenever what's on screen
  // changes in a way the video has to show: play, pause, a jump, a new speed, a drawing.
  sample() {
    const rec = this.rec;
    const now = performance.now();
    const c = rec.cur;
    const t = media.currentTime;
    let changed;
    if (c.kind === 'hold') {
      changed = (!media.paused && !video.seeking) || Math.abs(t - c.at) > frameDuration / 2 || JSON.stringify(this.shapesNow()) !== c.key;
    } else {
      const expect = c.last + ((now - c.lastAt) / 1000) * c.rate;
      changed = media.paused || video.seeking || media.playbackRate !== c.rate || t < c.last - 0.05 || t > expect + 0.5;
      if (!changed) { c.last = t; c.lastAt = now; }
    }
    if (changed) {
      this.end(c, now);
      rec.cur = this.snapshot(now);
    }
    // Stop at the end of the play's clip, so you can talk over the last frame.
    const w = this.tag && Clips.window(this.tag);
    if (w && !media.paused && t >= w.end) media.pause();
    if ((now - rec.t0) / 1000 > this.maxSecs) this.stop();
    $('revTime').textContent = fmt((now - rec.t0) / 1000);
  },

  // Finish segment c at `now` and add it to the recording.
  end(c, now) {
    const segs = this.rec.segs;
    const wall = (now - c.since) / 1000;
    let seg = c.kind === 'hold'
      ? { kind: 'hold', at: c.at, shapes: c.shapes, key: c.key, wall }
      : { kind: 'play', from: c.from, to: c.last, wall };
    if (seg.kind === 'play' && seg.to - seg.from < 0.02) seg = { kind: 'hold', at: seg.from, shapes: [], key: '[]', wall };
    const prev = segs.at(-1);
    // A blink-long segment (a click, a scrub) or the same held frame again just makes the one before longer,
    // so the picture keeps time with the voice.
    if (prev && (wall < 0.1 || (seg.kind === 'hold' && prev.kind === 'hold' && prev.at === seg.at && prev.key === seg.key))) {
      prev.wall += wall;
      return;
    }
    segs.push(seg);
  },

  async start() {
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      if (!confirm(`Pucked Video couldn't use your microphone (${e.message}).\n\nRecord without your voice? The drawings and slow motion are still saved.`)) return;
    }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((x) => window.MediaRecorder?.isTypeSupported(x));
    const rec = { stream, chunks: [], segs: [], muted: video.muted, type };
    this.rec = rec;
    // The game's sound is mixed in afterwards, so keep it out of the microphone.
    video.muted = true;
    const go = () => {
      rec.t0 = performance.now();
      rec.cur = this.snapshot(rec.t0);
      rec.timer = setInterval(() => this.sample(), 40);
      this.renderBar();
    };
    if (stream) {
      rec.recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      rec.recorder.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
      rec.recorder.onstart = go;
      rec.recorder.start(1000);
      this.meter(stream);
    } else go();
    this.renderBar();
  },

  // A small level meter, so you can see the microphone hears you.
  meter(stream) {
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const tick = () => {
      if (!this.rec) { ctx.close(); $('revLevel').style.width = '0'; return; }
      an.getByteTimeDomainData(buf);
      const peak = buf.reduce((m, v) => Math.max(m, Math.abs(v - 128)), 0) / 128;
      $('revLevel').style.width = `${Math.min(100, peak * 140)}%`;
      requestAnimationFrame(tick);
    };
    tick();
  },

  async stop(discard = false) {
    const rec = this.rec;
    if (!rec) return;
    clearInterval(rec.timer);
    if (rec.cur) this.end(rec.cur, performance.now());
    media.pause();
    const voice = rec.recorder ? await new Promise((resolve) => {
      rec.recorder.onstop = () => resolve(new Blob(rec.chunks, { type: rec.recorder.mimeType || rec.type || 'audio/webm' }));
      rec.recorder.stop();
    }) : null;
    rec.stream?.getTracks().forEach((tr) => tr.stop());
    video.muted = rec.muted;
    this.rec = null;
    this.renderBar();
    if (discard) return;
    const secs = rec.segs.reduce((a, s) => a + s.wall, 0);
    if (secs < 1) return alert('That recording was too short. Press Record and talk through the play.');
    this.take = { segs: rec.segs, voice, ext: /mp4/.test(voice?.type ?? '') ? '.m4a' : '.webm', secs };
    this.saved = null;
    this.openDialog();
  },

  // --- Saving ------------------------------------------------------------------------------

  defaultTitle() {
    const t = this.tag;
    return t ? `${Clips.label(t)} ${fmt(t.time)}` : `Review ${fmt(this.take.segs[0]?.from ?? this.take.segs[0]?.at ?? 0)}`;
  },

  openDialog() {
    const { segs, secs, voice } = this.take;
    const held = segs.filter((s) => s.kind === 'hold' && s.shapes.length).length;
    const slow = segs.some((s) => s.kind === 'play' && (s.to - s.from) / s.wall < 0.9);
    $('revSummary').textContent = `${fmt(secs)} long${held ? `, ${held} drawing${held === 1 ? '' : 's'}` : ''}${slow ? ', with slow motion' : ''}${voice ? '' : ', no voice'}.`;
    $('revTitle').value = this.defaultTitle();
    $('revDesc').value = this.tag?.note ?? '';
    $('revGame').value = String(AI.settings.reviewGameVolume ?? 0.25);
    this.progress(null);
    this.renderShare();
    $('revDialog').showModal();
  },

  toBase64: (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  }),

  async save() {
    const take = this.take;
    if (!take || this.saving) return;
    const name = $('revTitle').value.trim().replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80) || 'Review';
    const out = await window.api.saveVideoAs(`${Clips.base()} - Review ${name}.mp4`);
    if (!out) return;
    // Each different drawing becomes one picture, laid over the frame it was drawn on.
    const pictures = new Map();
    const segments = [];
    for (const s of take.segs) {
      if (s.kind === 'play') { segments.push({ kind: 'play', from: s.from, to: s.to, wall: s.wall }); continue; }
      let drawing = null;
      if (s.shapes.length) {
        if (!pictures.has(s.key)) pictures.set(s.key, { i: pictures.size, png: await Draw.drawingPng(s.shapes) });
        drawing = pictures.get(s.key).i;
      }
      segments.push({ kind: 'hold', at: s.at, wall: s.wall, drawing });
    }
    const gameVolume = Number($('revGame').value);
    AI.settings.reviewGameVolume = gameVolume;
    window.api.saveSettings(AI.settings);
    const res = await window.api.exportReview({
      video: current.path, out, w: video.videoWidth || 1920, h: video.videoHeight || 1080,
      fps: Math.max(24, Math.min(60, Math.round(1 / frameDuration))), segments,
      drawings: [...pictures.values()].map((p) => p.png),
      voice: take.voice ? await this.toBase64(take.voice) : null, voiceExt: take.ext, gameVolume,
    });
    if (!res.ok) return alert(res.error);
    this.saving = true;
    this.out = out;
    this.progress({ state: 'running', pct: 0 });
  },

  progress(s) {
    $('revProgress').hidden = !s;
    $('revSave').disabled = this.saving;
    $('revAgain').disabled = this.saving;
    if (!s) return;
    const running = s.state === 'running';
    $('revBar2').style.width = `${s.state === 'done' ? 100 : s.pct ?? 0}%`;
    $('revStatus').textContent = running ? `Making the video: ${Math.floor(s.pct)}%`
      : s.state === 'done' ? `Saved ${s.out.split(/[\\/]/).pop()}`
        : s.state === 'cancelled' ? 'Stopped.' : `Couldn't make the video: ${s.error}`;
    $('revCancel').hidden = !running;
    $('revShow').hidden = s.state !== 'done';
  },

  onProgress(s) {
    if (s.state !== 'running') this.saving = false;
    if (s.state === 'done') { this.saved = s.out; this.renderShare(); }
    this.progress(s);
  },

  // --- YouTube -----------------------------------------------------------------------------

  yt: { configured: false, connected: false },

  async refreshYouTube() {
    try { this.yt = await window.api.youtubeStatus(); } catch { /* the server will say why on upload */ }
    this.renderShare();
    YouTubeSetup.render();
  },

  renderShare() {
    const { configured, connected } = this.yt;
    $('revShare').hidden = !this.saved;
    $('revYtSetup').hidden = configured && connected;
    $('revYtSetup').textContent = configured ? 'Connect YouTube…' : 'Set up YouTube…';
    $('revYtNote').textContent = connected ? '' : configured
      ? 'Sign in to your YouTube channel once, and uploads go straight from here.'
      : 'Set up YouTube once (about 10 minutes) and review clips upload straight from here.';
    $('revYtForm').hidden = !connected;
  },

  async upload() {
    const res = await window.api.youtubeUpload({
      file: this.saved, title: $('revTitle').value.trim(), description: $('revDesc').value.trim(), privacy: $('revPrivacy').value,
    });
    if (!res.ok) return alert(res.error);
    this.onUpload({ state: 'running', pct: 0 });
  },

  onUpload(s) {
    $('revYtProgress').hidden = false;
    const running = s.state === 'running';
    $('revYtBar').style.width = `${s.state === 'done' ? 100 : s.pct ?? 0}%`;
    $('revYtUpload').disabled = running;
    $('revYtCancel').hidden = !running;
    $('revYtStatus').textContent = running ? `Uploading to YouTube: ${Math.floor(s.pct)}%`
      : s.state === 'done' ? 'Uploaded. YouTube may take a few minutes to finish processing it.'
        : s.state === 'cancelled' ? 'Upload stopped.' : `Couldn't upload it: ${s.error}`;
    $('revYtDone').hidden = s.state !== 'done';
    if (s.state !== 'done') return;
    this.link = s.url;
    $('revYtLink').value = s.url;
    const names = { private: 'Private (only you)', unlisted: 'Unlisted (anyone with the link)', public: 'Public' };
    $('revYtPrivacy').textContent = s.privacy === s.asked ? `Who can watch: ${names[s.privacy]}.`
      : `YouTube made it ${names[s.privacy] ?? s.privacy}, not ${names[s.asked]}. Google keeps uploads from a new, unreviewed Google project private. See step 6 in YouTube setup, or use "Upload it myself" for now.`;
  },

  wire() {
    $('revBtn').onclick = () => ($('revBar').hidden ? this.open(focusTag) : this.close());
    $('revRec').onclick = () => (this.rec ? this.stop() : this.start());
    $('revClose').onclick = () => this.close();
    $('revSave').onclick = () => this.save();
    $('revAgain').onclick = () => { $('revDialog').close(); this.open(this.tag); };
    $('revCancel').onclick = () => window.api.cancelReview();
    $('revShow').onclick = () => window.api.showFile(this.out);
    $('revYtSetup').onclick = () => YouTubeSetup.open();
    $('revYtUpload').onclick = () => this.upload();
    $('revYtCancel').onclick = () => window.api.cancelYoutube();
    $('revYtCopy').onclick = () => { navigator.clipboard.writeText(this.link); $('revYtCopy').textContent = 'Copied'; setTimeout(() => { $('revYtCopy').textContent = 'Copy link'; }, 1500); };
    $('revYtOpen').onclick = () => window.api.openExternal(this.link);
    $('revYtSelf').onclick = () => { window.api.openExternal('https://www.youtube.com/upload'); window.api.showFile(this.saved); };
    $('revPrivacy').onchange = () => { AI.settings.reviewPrivacy = $('revPrivacy').value; window.api.saveSettings(AI.settings); };
    $('revPrivacy').value = AI.settings.reviewPrivacy ?? 'unlisted';
    window.api.onReviewProgress((s) => this.onProgress(s));
    window.api.onYoutubeProgress((s) => this.onUpload(s));
    window.api.onYoutubeStatus(() => this.refreshYouTube());
    YouTubeSetup.wire();
    this.refreshYouTube();
  },
};

// The one-time YouTube setup: Google needs every copy of the app to have its own (free) Google Cloud
// "Desktop app" client. The steps and links are on screen; nothing to type into files.
const YouTubeSetup = {
  open() {
    this.render();
    $('ytDialog').showModal();
  },

  render() {
    const { configured, connected, clientId } = Review.yt;
    $('ytClientState').textContent = configured ? `Using client ${clientId.split('-')[0]}…` : 'Not set up yet.';
    $('ytConnect').disabled = !configured;
    $('ytConnect').textContent = connected ? 'Connect a different account' : 'Connect YouTube';
    $('ytState').textContent = connected ? 'YouTube is connected.' : configured ? 'Not connected yet.' : '';
    $('ytState').classList.toggle('ok', connected);
    $('ytDisconnect').hidden = !connected;
  },

  async useFile() {
    const file = await window.api.pickYoutubeClient();
    if (!file) return;
    await this.setup({ file });
  },

  async setup(opts) {
    try {
      Review.yt = await window.api.youtubeSetup(opts);
    } catch (e) {
      return alert(e.message);
    }
    $('ytId').value = '';
    $('ytSecret').value = '';
    Review.renderShare();
    this.render();
  },

  async connect() {
    try {
      const { url } = await window.api.youtubeConnect(location.origin);
      window.api.openExternal(url);
      $('ytState').textContent = 'Finish signing in on the Google page that just opened, then come back here.';
    } catch (e) {
      alert(e.message);
    }
  },

  wire() {
    $('ytDialog').addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="https://"]');
      if (!a) return;
      e.preventDefault();
      window.api.openExternal(a.href);
    });
    $('ytFile').onclick = () => this.useFile();
    $('ytPaste').onclick = () => this.setup({ clientId: $('ytId').value, clientSecret: $('ytSecret').value });
    $('ytConnect').onclick = () => this.connect();
    $('ytDisconnect').onclick = async () => { Review.yt = await window.api.youtubeDisconnect(); Review.renderShare(); this.render(); };
  },
};
