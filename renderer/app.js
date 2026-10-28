const $ = (id) => document.getElementById(id);
const video = $('video');

// Most XBotGo exports are 30 fps; requestVideoFrameCallback refines this once playback starts.
let frameDuration = 1 / 30;
let sports = [];
let sport = null;
let current = null; // { path, url, size }
let tags = [];

const fmt = (s) => {
  if (!isFinite(s)) return '00:00';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

async function init() {
  sports = await window.api.listSports();
  $('sport').innerHTML = sports.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  $('sport').value = 'hockey';
  setSport('hockey');
  const ff = await window.api.checkFfmpeg();
  $('ffmpeg').textContent = ff.ok ? 'ffmpeg ready' : 'ffmpeg not found';
}

function setSport(id) {
  sport = sports.find((s) => s.id === id);
  $('tagButtons').innerHTML = sport.tags
    .map((t) => `<button data-label="${t.label}" style="--c:${t.color}">${t.label}<kbd>${t.key.toUpperCase()}</kbd></button>`)
    .join('');
}

async function openVideo() {
  const file = await window.api.openVideo();
  if (!file) return;
  current = file;
  video.src = file.url;
  $('placeholder').hidden = true;
  const saved = await window.api.loadTags(file.path);
  tags = saved?.tags ?? [];
  if (saved?.sport) { $('sport').value = saved.sport; setSport(saved.sport); }
  renderTags();
}

function addTag(label) {
  if (!current) return;
  const def = sport.tags.find((t) => t.label === label);
  tags.push({ label, time: video.currentTime, before: def.before, after: def.after, color: def.color });
  tags.sort((a, b) => a.time - b.time);
  renderTags();
  save();
}

function save() {
  if (current) window.api.saveTags(current.path, { sport: sport.id, tags });
}

function renderTags() {
  $('tagCount').textContent = tags.length ? `(${tags.length})` : '';
  $('tagList').innerHTML = tags
    .map((t, i) => `<li data-i="${i}" style="--c:${t.color}"><span class="t">${fmt(t.time)}</span>${t.label}<button class="x" data-del="${i}">×</button></li>`)
    .join('');
}

function step(frames) {
  video.pause();
  video.currentTime = Math.max(0, video.currentTime + frames * frameDuration);
}

$('open').onclick = openVideo;
$('sport').onchange = (e) => { setSport(e.target.value); save(); };
$('play').onclick = () => (video.paused ? video.play() : video.pause());
$('back').onclick = () => (video.currentTime -= 5);
$('fwd').onclick = () => (video.currentTime += 5);
$('stepBack').onclick = () => step(-1);
$('stepFwd').onclick = () => step(1);
$('speed').onchange = (e) => (video.playbackRate = Number(e.target.value));
$('scrubber').oninput = (e) => (video.currentTime = (e.target.value / 1000) * video.duration);
$('tagButtons').onclick = (e) => { const b = e.target.closest('button'); if (b) addTag(b.dataset.label); };
$('tagList').onclick = (e) => {
  if (e.target.dataset.del !== undefined) { tags.splice(Number(e.target.dataset.del), 1); renderTags(); save(); return; }
  const li = e.target.closest('li');
  if (li) { const t = tags[li.dataset.i]; video.currentTime = Math.max(0, t.time - t.before); video.play(); }
};

video.onplay = () => ($('play').textContent = '⏸');
video.onpause = () => ($('play').textContent = '▶');
video.ontimeupdate = () => {
  $('time').textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
  if (video.duration) $('scrubber').value = (video.currentTime / video.duration) * 1000;
};

if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
  let last = null;
  // The first frame shown after a seek looks like the "next" frame, so forget the previous one on every seek.
  video.addEventListener('seeking', () => (last = null));
  const onFrame = (_now, meta) => {
    const delta = last ? meta.mediaTime - last.mediaTime : 0;
    // Only trust back-to-back frames during normal playback, within a sane 10-240 fps range.
    if (!video.paused && meta.presentedFrames === last?.presentedFrames + 1 && delta >= 1 / 240 && delta <= 1 / 10) {
      frameDuration = delta;
    }
    last = meta;
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
}

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === ' ') { e.preventDefault(); $('play').click(); return; }
  if (e.key === 'ArrowLeft') return $('back').click();
  if (e.key === 'ArrowRight') return $('fwd').click();
  if (e.key === ',') return step(-1);
  if (e.key === '.') return step(1);
  const def = sport?.tags.find((t) => t.key === e.key.toLowerCase());
  if (def) addTag(def.label);
});

init();
