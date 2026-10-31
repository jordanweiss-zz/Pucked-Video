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
let aiRunPath = null; // this game's imported Hockey_AI results, for the AI players screen
let gameTeamId = null; // your team in this game; its roster fills the player bar
let focusTag = null; // the tag a player pick applies to: the one just added or clicked
const added = []; // tags added this session, newest last, for Undo

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
  await AI.load();
  AI.wire();
  AiPlayers.wire();
  Rink.wire();
  Analyze.wire();
  Clips.wire();
  Draw.wire();
  Chapters.wire();
  Crop.wire();
  AutoCut.wire();
  Follow.wire();
  Review.wire();
  Library.wire();
  GameData.wire();
  await Notices.wire();
  await Teams.load();
  Teams.onChange = () => { renderTeamSelect(); renderPlayers(); renderTags(); };
  Teams.wire();
  renderTeamSelect();
  renderPlayers();
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
  showGame(await window.api.openVideo());
}

// Start reviewing a local game: from Open video… or the game library.
async function showGame(file) {
  if (!file) return;
  useMedia(video);
  current = { ...file, key: file.path };
  video.src = file.url;
  await loadSavedTags();
  if (!xbotgoImported) await importXbotgoMarks(file.path);
  renderTags();
  await Analyze.gameOpened();
}

async function openYouTube(e) {
  e.preventDefault();
  const videoId = YouTubeMedia.parseId($('ytUrl').value);
  if (!videoId) { $('ytUrl').setCustomValidity('That doesn’t look like a YouTube link'); $('ytUrl').reportValidity(); return; }
  $('ytUrl').setCustomValidity('');
  $('ytUrl').blur(); // so hotkeys tag instead of typing into the field
  video.removeAttribute('src');
  video.load();
  const host = document.createElement('div');
  // A transparent shield over the iframe sends clicks to the app instead of YouTube's own player.
  const shield = document.createElement('div');
  shield.className = 'yt-shield';
  $('yt').replaceChildren(host, shield);
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
  Draw.load(saved?.drawings);
  AutoCut.load(saved?.deadTime);
  if (saved?.sport) { $('sport').value = saved.sport; setSport(saved.sport); }
  xbotgoImported = Boolean(saved?.xbotgoImported);
  aiRunPath = saved?.aiRun ?? null;
  $('aiPlayers').hidden = !aiRunPath;
  // A new game defaults to your only team, if you have just one.
  gameTeamId = saved?.teamId ?? (Teams.data.teams.length === 1 ? Teams.data.teams[0].id : null);
  focusTag = null;
  added.length = 0;
  renderTeamSelect();
  renderPlayers();
  await Follow.load();
}

function renderTeamSelect() {
  if (gameTeamId && !Teams.get(gameTeamId)) gameTeamId = null;
  $('gameTeam').innerHTML = '<option value="">No team</option>'
    + Teams.data.teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  $('gameTeam').value = gameTeamId ?? '';
}

function renderPlayers() {
  const team = Teams.get(gameTeamId);
  const players = team ? team.players.slice().sort((a, b) => (Number(a.number) || 999) - (Number(b.number) || 999)) : [];
  $('playerButtons').innerHTML = players
    .map((p) => `<button data-player="${p.id}" class="${focusTag?.player?.id === p.id ? 'on' : ''}">${esc(Teams.label(p))}</button>`)
    .join('') + (team ? `<button data-player="" class="${focusTag && !focusTag.player ? '' : ''}" title="Not about one player">Team</button>` : '');
  $('playerHint').textContent = !team
    ? (Teams.data.teams.length ? 'Pick your team to tag players' : 'Add your team under Teams & rosters to tag players')
    : focusTag ? `Who was it? Click a player or type their number for the ${fmt(focusTag.time)} ${focusTag.label}` : 'Tag a play, then pick the player';
}

function assignPlayer(playerId) {
  if (!focusTag) return;
  const p = Teams.get(gameTeamId)?.players.find((x) => x.id === playerId);
  if (p) focusTag.player = { id: p.id, number: p.number, name: p.name };
  else delete focusTag.player;
  renderTags();
  renderPlayers();
  save();
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
  const tag = { label, time: media.currentTime, before: def.before, after: def.after, color: def.color };
  tags.push(tag);
  tags.sort((a, b) => a.time - b.time);
  added.push(tag);
  focusTag = tag;
  renderTags();
  renderPlayers();
  save();
}

// Undo removes the tag you added most recently (not the latest one in game time).
function undo() {
  const tag = added.pop();
  if (!tag) return;
  tags = tags.filter((t) => t !== tag);
  if (focusTag === tag) focusTag = added.at(-1) ?? null;
  renderTags();
  renderPlayers();
  save();
}

function clearTags() {
  if (!tags.length || !confirm(`Remove all ${tags.length} tags from this game?`)) return;
  tags = [];
  added.length = 0;
  focusTag = null;
  renderTags();
  renderPlayers();
  save();
}

// Bring a Hockey_AI run's plays into this game as suggestions.
function importAiRun(run) {
  const result = AI.importRun(run, Teams.get(gameTeamId));
  aiRunPath = run.exportPath;
  Follow.run = run;
  $('aiPlayers').hidden = false;
  renderTags();
  save();
  return result;
}

// Re-pick this game's AI plays after a settings change or a player fix. No graphics card needed; takes seconds.
async function refreshAiPlays() {
  const run = await window.api.loadAiRun(aiRunPath);
  const res = await window.api.refilterAi(AI.dir, run.base, run.data.start_offset ?? 0);
  if (res.ok) importAiRun(await window.api.loadAiRun(aiRunPath));
  return res;
}

function save() {
  if (current) window.api.saveTags(current.key, { sport: sport.id, teamId: gameTeamId, xbotgoImported, aiRun: aiRunPath, tags, drawings: Draw.drawings, deadTime: AutoCut.scan });
}

const esc = (str) => String(str).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Rejected AI plays stay in the file (so a re-import skips them) but are never shown.
const visible = (t) => t.status !== 'rejected' && (t.status !== 'suggested' || $('showAi').checked);

function renderTags() {
  const shown = tags.filter(visible);
  const suggested = tags.filter((t) => t.status === 'suggested').length;
  $('tagCount').textContent = shown.length ? `(${shown.length})` : '';
  $('aiCount').textContent = suggested ? `${suggested} to review` : '';
  $('tagList').innerHTML = tags
    .map((t, i) => (!visible(t) ? '' : `<li data-i="${i}" style="--c:${t.color}" class="${t === focusTag ? 'focus' : ''} ${t.status === 'suggested' ? 'suggested' : ''}"><span class="t">${fmt(t.time)}</span>${t.label}`
      + (t.player ? ` <span class="who">${esc(Teams.label(t.player))}</span>` : '')
      + (t.status === 'suggested'
        ? ` <span class="conf">AI ${Math.round((t.confidence ?? 0) * 100)}%</span><button class="x ok" data-ok="${i}" title="Keep this play">✓</button><button class="no" data-no="${i}" title="Not a real play">✗</button>`
        : `<button class="x" data-del="${i}">×</button>`)
      + `<input class="note" data-note="${i}" placeholder="Add a note…" value="${esc(t.note ?? '')}">`
      + (t === focusTag ? Clips.row(t, i) : '') + '</li>'))
    .join('');
  renderMarkers();
}

function renderMarkers() {
  const d = media.duration;
  $('markers').innerHTML = d
    ? tags.map((t, i) => (visible(t) ? `<i data-i="${i}" class="${t.status === 'suggested' ? 'suggested' : ''}" style="left:${(t.time / d) * 100}%;--c:${t.color}" title="${fmt(t.time)} ${t.label}"></i>` : '')).join('')
      + Draw.markers(d)
    : '';
  AutoCut.render();
  Clips.renderBand();
  if (Follow.who) { Follow.parts = Follow.stretches(Follow.who); Follow.render(); }
}

// Clicking a tag plays its clip window (before..after) and pauses at the end of it.
let clipEnd = null;
function playClip(i) {
  const t = tags[i];
  focusTag = t;
  renderTags();
  renderPlayers();
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
// Clicking the picture toggles play, for both local files and YouTube.
$('video').onclick = () => $('play').click();
$('yt').onclick = (e) => { if (e.target.classList.contains('yt-shield')) $('play').click(); };
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
  if (e.target.dataset.del !== undefined) {
    const [gone] = tags.splice(Number(e.target.dataset.del), 1);
    if (focusTag === gone) focusTag = null;
    const a = added.indexOf(gone);
    if (a >= 0) added.splice(a, 1);
    renderTags(); renderPlayers(); save();
    return;
  }
  if (e.target.dataset.ok !== undefined) { tags[Number(e.target.dataset.ok)].status = 'accepted'; renderTags(); save(); return; }
  if (e.target.dataset.no !== undefined) {
    const t = tags[Number(e.target.dataset.no)];
    t.status = 'rejected';
    if (focusTag === t) focusTag = null;
    renderTags(); renderPlayers(); save();
    return;
  }
  if (e.target.dataset.note !== undefined) return;
  if (e.target.closest('.clip-row')) return Clips.onRowClick(e);
  const li = e.target.closest('li');
  if (li) playClip(Number(li.dataset.i));
};
$('tagList').onchange = (e) => {
  if (e.target.closest('.clip-row')) return Clips.onRowChange(e);
  if (e.target.dataset.note === undefined) return;
  tags[Number(e.target.dataset.note)].note = e.target.value.trim();
  save();
};
$('playerButtons').onclick = (e) => { const b = e.target.closest('button'); if (b) assignPlayer(b.dataset.player); };
$('gameTeam').onchange = (e) => { gameTeamId = e.target.value || null; renderPlayers(); save(); };
$('undo').onclick = undo;
$('showAi').onchange = renderTags;
$('aiImport').onclick = async () => {
  if (!current) return alert('Open a game first.');
  let run;
  try {
    run = await window.api.pickAiResults(AI.dir ? `${AI.dir}/output` : undefined);
  } catch (err) {
    return alert(err.message);
  }
  if (!run) return;
  const { added: n, toReview } = importAiRun(run);
  const plays = (k) => `${k} play${k === 1 ? '' : 's'}`;
  alert(n ? `Added ${plays(n)} for you to review. Click ✓ to keep a play or ✗ to drop it.`
    : toReview ? `No new plays. ${plays(toReview)} still to review.` : 'No new plays in that file.');
};
$('aiPlayers').onclick = () => AiPlayers.open(aiRunPath);
$('clearTags').onclick = clearTags;
$('markers').onclick = (e) => {
  if (e.target.dataset.i !== undefined) playClip(Number(e.target.dataset.i));
  if (e.target.dataset.drawing !== undefined) { media.pause(); media.currentTime = Number(e.target.dataset.drawing); }
};

const mediaEvents = {
  play: () => ($('play').textContent = '⏸'),
  pause: () => ($('play').textContent = '▶'),
  timeupdate: () => {
    $('time').textContent = `${fmt(media.currentTime)} / ${fmt(media.duration)}`;
    if (media.duration) $('scrubber').value = (media.currentTime / media.duration) * 1000;
    if (clipEnd !== null && media.currentTime >= clipEnd) { media.pause(); stopClip(); }
    AutoCut.onTime();
    Follow.onTime();
  },
  loadedmetadata: renderMarkers,
};
for (const [type, fn] of Object.entries(mediaEvents)) video.addEventListener(type, fn);

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

// Step the speed dropdown up or down one option.
function nudgeSpeed(dir) {
  const sel = $('speed');
  sel.selectedIndex = Math.max(0, Math.min(sel.options.length - 1, sel.selectedIndex + dir));
  sel.dispatchEvent(new Event('change'));
}

// Typing a jersey number (one or two digits) picks that player for the focused tag.
let digits = '';
let digitTimer = null;
function typeDigit(d) {
  digits += d;
  clearTimeout(digitTimer);
  const players = Teams.get(gameTeamId)?.players ?? [];
  const exact = players.find((p) => String(p.number) === digits);
  const longer = players.some((p) => String(p.number ?? '').startsWith(digits) && String(p.number) !== digits);
  if (exact && !longer) { assignPlayer(exact.id); digits = ''; return; }
  digitTimer = setTimeout(() => { if (exact) assignPlayer(exact.id); digits = ''; }, 700);
}

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  if (e.target.matches('input:not([type=range]), select')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^[0-9]$/.test(e.key)) return typeDigit(e.key);
  if (e.key === '-') return nudgeSpeed(-1);
  if (e.key === '+' || e.key === '=') return nudgeSpeed(1);
  if (e.key.toLowerCase() === 'u') return Draw.active ? Draw.undo() : undo();
  if (e.key.toLowerCase() === 'd') return $('drawBtn').click();
  if (e.key.toLowerCase() === 'i' && focusTag) return Clips.setHere('start');
  if (e.key.toLowerCase() === 'o' && focusTag) return Clips.setHere('end');
  if (e.key === 'Escape' && Draw.active) return Draw.close();
  if (e.key === 'Escape' && !Review.rec && !$('revBar').hidden) return Review.close();
  if (e.key === ' ') { e.preventDefault(); $('play').click(); return; }
  if (e.key === 'ArrowLeft') return $('back').click();
  if (e.key === 'ArrowRight') return $('fwd').click();
  if (e.key === '[' && Follow.who) return Follow.step(-1);
  if (e.key === ']' && Follow.who) return Follow.step(1);
  if (e.key === ',') return step(-1);
  if (e.key === '.') return step(1);
  const def = sport?.tags.find((t) => t.key === e.key.toLowerCase());
  if (def) addTag(def.label);
});

init();
