const $ = (id) => document.getElementById(id);
const video = $('video');
// The active player: the <video> element for local files, or a YouTubeMedia for links.
let media = video;

// Most XBotGo exports are 30 fps; requestVideoFrameCallback refines this once playback starts.
let frameDuration = 1 / 30;
let sports = [];
let sport = null;
let current = null; // local file { key, path, url, size } or YouTube { key, videoId }
let tags = [];
let xbotgoImported = false; // highlight clicks from the camera already turned into tags

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
  useMedia(video);
  current = { ...file, key: file.path };
  video.src = file.url;
  await loadSavedTags();
  if (!xbotgoImported) await importXbotgoMarks(file.path);
  renderTags();
}

async function openYouTube(e) {
  e.preventDefault();
  const videoId = YouTubeMedia.parseId($('ytUrl').value);
  if (!videoId) { $('ytUrl').setCustomValidity('That doesn’t look like a YouTube link'); $('ytUrl').reportValidity(); return; }
  $('ytUrl').setCustomValidity('');
  video.removeAttribute('src');
  video.load();
  const host = document.createElement('div');
  $('yt').replaceChildren(host);
  useMedia(new YouTubeMedia(host, videoId));
  current = { key: `youtube:${videoId}`, videoId };
  await loadSavedTags();
  renderTags();
}

async function loadSavedTags() {
  $('placeholder').hidden = true;
  stopClip();
  const saved = await window.api.loadTags(current.key);
  tags = saved?.tags ?? [];
  if (saved?.sport) { $('sport').value = saved.sport; setSport(saved.sport); }
  xbotgoImported = Boolean(saved?.xbotgoImported);
}

function useMedia(next) {
  if (media !== next && media !== video) media.destroy();
  for (const [type, fn] of Object.entries(mediaEvents)) {
    media.removeEventListener(type, fn);
    next.addEventListener(type, fn);
  }
  media = next;
  video.hidden = media !== video;
  $('yt').hidden = media === video;
}

// Turn the highlight clicks made on the XBotGo during the game into Highlight tags, once per video.
async function importXbotgoMarks(videoPath) {
  const marks = await window.api.loadXbotgoMarks(videoPath);
  if (!marks.length) return;
  const def = sport.tags.find((t) => t.label === 'Highlight') ?? { label: 'Highlight', color: '#ffffff', before: 10, after: 5 };
  for (const time of marks) {
    if (!tags.some((t) => Math.abs(t.time - time) < 1)) {
      tags.push({ label: def.label, time, before: def.before, after: def.after, color: def.color, source: 'xbotgo' });
    }
  }
  tags.sort((a, b) => a.time - b.time);
  xbotgoImported = true;
  save();
}

function addTag(label) {
  if (!current) return;
  const def = sport.tags.find((t) => t.label === label);
  tags.push({ label, time: media.currentTime, before: def.before, after: def.after, color: def.color });
  tags.sort((a, b) => a.time - b.time);
  renderTags();
  save();
}

function save() {
  if (current) window.api.saveTags(current.key, { sport: sport.id, xbotgoImported, tags });
}

const esc = (str) => String(str).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function renderTags() {
  $('tagCount').textContent = tags.length ? `(${tags.length})` : '';
  $('tagList').innerHTML = tags
    .map((t, i) => `<li data-i="${i}" style="--c:${t.color}"><span class="t">${fmt(t.time)}</span>${t.label}<button class="x" data-del="${i}">×</button>`
      + `<input class="note" data-note="${i}" placeholder="Add a note…" value="${esc(t.note ?? '')}"></li>`)
    .join('');
  renderMarkers();
}

function renderMarkers() {
  const d = media.duration;
  $('markers').innerHTML = d
    ? tags.map((t, i) => `<i data-i="${i}" style="left:${(t.time / d) * 100}%;--c:${t.color}" title="${fmt(t.time)} ${t.label}"></i>`).join('')
    : '';
}

// Clicking a tag plays its clip window (before..after) and pauses at the end of it.
let clipEnd = null;
function playClip(i) {
  const t = tags[i];
  media.currentTime = Math.max(0, t.time - t.before);
  clipEnd = t.time + t.after;
  document.querySelectorAll('#tagList li').forEach((li) => li.classList.toggle('playing', Number(li.dataset.i) === i));
  media.play();
}

function stopClip() {
  clipEnd = null;
  document.querySelectorAll('#tagList li.playing').forEach((li) => li.classList.remove('playing'));
}

function step(frames) {
  media.pause();
  media.currentTime = Math.max(0, media.currentTime + frames * frameDuration);
}

$('open').onclick = openVideo;
$('ytForm').onsubmit = openYouTube;
$('sport').onchange = (e) => { setSport(e.target.value); save(); };
$('play').onclick = () => (media.paused ? media.play() : media.pause());
$('back').onclick = () => (media.currentTime -= 5);
$('fwd').onclick = () => (media.currentTime += 5);
$('stepBack').onclick = () => step(-1);
$('stepFwd').onclick = () => step(1);
$('speed').onchange = (e) => (media.playbackRate = Number(e.target.value));
$('scrubber').oninput = (e) => (stopClip(), media.currentTime = (e.target.value / 1000) * media.duration);
$('tagButtons').onclick = (e) => { const b = e.target.closest('button'); if (b) addTag(b.dataset.label); };
$('tagList').onclick = (e) => {
  if (e.target.dataset.del !== undefined) { tags.splice(Number(e.target.dataset.del), 1); renderTags(); save(); return; }
  if (e.target.dataset.note !== undefined) return;
  const li = e.target.closest('li');
  if (li) playClip(Number(li.dataset.i));
};
$('tagList').onchange = (e) => {
  if (e.target.dataset.note === undefined) return;
  tags[Number(e.target.dataset.note)].note = e.target.value.trim();
  save();
};
$('markers').onclick = (e) => { if (e.target.dataset.i !== undefined) playClip(Number(e.target.dataset.i)); };

const mediaEvents = {
  play: () => ($('play').textContent = '⏸'),
  pause: () => ($('play').textContent = '▶'),
  timeupdate: () => {
    $('time').textContent = `${fmt(media.currentTime)} / ${fmt(media.duration)}`;
    if (media.duration) $('scrubber').value = (media.currentTime / media.duration) * 1000;
    if (clipEnd !== null && media.currentTime >= clipEnd) { media.pause(); stopClip(); }
  },
  loadedmetadata: renderMarkers,
};
for (const [type, fn] of Object.entries(mediaEvents)) video.addEventListener(type, fn);

if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
  let last = null;
  const onFrame = (_now, meta) => {
    if (last && meta.mediaTime > last.mediaTime && meta.presentedFrames === last.presentedFrames + 1) {
      frameDuration = meta.mediaTime - last.mediaTime;
    }
    last = meta;
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
}

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input:not([type=range]), select')) return;
  if (e.key === ' ') { e.preventDefault(); $('play').click(); return; }
  if (e.key === 'ArrowLeft') return $('back').click();
  if (e.key === 'ArrowRight') return $('fwd').click();
  if (e.key === ',') return step(-1);
  if (e.key === '.') return step(1);
  const def = sport?.tags.find((t) => t.key === e.key.toLowerCase());
  if (def) addTag(def.label);
});

init();
