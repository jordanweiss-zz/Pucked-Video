"""The game library: every game video in the folders the user picked, with what the app knows about
each one (the XBotGo thumbnail and date, the tags, whether Hockey AI has analyzed it and whether its
results can be updated without the graphics card)."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from . import ffmpeg
from .config import DATA_DIR, files_url, read_json

VIDEO = re.compile(r'\.(mp4|mov|m4v|mkv)$', re.I)
# Folders the app or Hockey AI writes into, which never hold games of their own.
SKIP = re.compile(r'(^\.|_analysis$|_players$|_calib_check$|^node_modules$|^\$RECYCLE\.BIN$|^System Volume Information$)', re.I)
# Clips and reels the app saved next to a game.
SAVED = re.compile(r' - (condensed|highlights)| 9x16\.mp4$', re.I)
MAX_GAMES = 2000


def _json(file):
    try:
        return read_json(file, None)
    except (ValueError, OSError):
        return None


def find_videos(d: Path, depth: int, out: list) -> None:
    try:
        entries = list(d.iterdir())
    except OSError:
        return
    for e in entries:
        if len(out) >= MAX_GAMES:
            return
        try:
            if e.is_dir():
                if depth > 0 and not SKIP.search(e.name):
                    find_videos(e, depth - 1, out)
            elif e.is_file() and VIDEO.search(e.name) and not SAVED.search(e.name):
                out.append(e)
        except OSError:
            continue


def ai_update(manifest):
    """What Hockey AI can bring up to date for a game without the graphics card, from its manifest."""
    if not isinstance(manifest, dict):
        return None
    can = set(manifest.get('can_derive') or [])
    outputs = manifest.get('outputs') or {}
    stale = [k for k, o in outputs.items() if isinstance(o, dict) and o.get('stale') and k in can]
    return {'stale': stale, 'canUpdate': bool(stale), 'needsGpu': bool(manifest.get('needs_gpu'))}


def _date(name: str, vdata, mtime: float) -> str:
    if vdata and vdata.get('file_time'):
        return str(vdata['file_time']).replace(' ', 'T')
    m = re.search(r'(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})', name)
    if m:
        return f'{m[1]}-{m[2]}-{m[3]}T{m[4]}:{m[5]}:{m[6]}'
    return datetime.fromtimestamp(mtime, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')


def game(file: Path):
    """Saved clips and reels sit next to the games, so tell them apart: a game is long, or has an
    XBotGo .data folder or a tags file."""
    st = file.stat()
    name = file.stem
    data = file.parent / '.data'
    vdata = _json(data / f'{name}.vdata')
    cover = data / f'{name}.cover'
    saved = _json(Path(f'{file}.tags.json'))
    all_tags = (saved or {}).get('tags') or []
    tags = [t for t in all_tags if t.get('status') not in ('rejected', 'suggested')]
    counts: dict[str, int] = {}
    for t in tags:
        counts[t.get('label')] = counts.get(t.get('label'), 0) + 1
    base = file.parent / f'{name}_analysis' / name
    pdf = Path(f'{base}_postgame.pdf')
    return {
        'path': str(file),
        'name': name,
        'title': (saved or {}).get('title') or '',
        'date': _date(name, vdata, st.st_mtime),
        'size': st.st_size,
        'duration': (vdata or {}).get('duration'),
        'xbotgo': bool(vdata),
        'cover': files_url(cover) if cover.exists() else None,
        'tags': len(tags),
        'counts': counts,
        'toReview': sum(1 for t in all_tags if t.get('status') == 'suggested'),
        'sport': (saved or {}).get('sport'),
        'teamId': (saved or {}).get('teamId'),
        'analyzed': Path(f'{base}_report.json').exists(),
        'hasData': Path(f'{base}_shifts.json').exists(),
        'ai': ai_update(_json(Path(f'{base}_manifest.json'))),
        'report': str(pdf) if pdf.exists() else None,
        'hasTags': saved is not None,
    }


def scan(folders):
    files: list[Path] = []
    for f in folders or []:
        find_videos(Path(f), 3, files)
    games = []
    for f in dict.fromkeys(files):
        try:
            g = game(f)
        except OSError:
            continue
        if g['xbotgo'] or g['hasTags'] or g['size'] > 500 * 1024 * 1024:
            games.append(g)
    return sorted(games, key=lambda g: g['date'], reverse=True)


def thumb(file: str):
    """A picture for a game without an XBotGo thumbnail: one frame a few minutes in, kept in the app's data folder."""
    p = Path(file)
    st = p.stat()
    key = hashlib.sha1(json.dumps([str(p), st.st_size, st.st_mtime]).encode()).hexdigest()
    out = DATA_DIR / 'thumbs' / f'{key}.jpg'
    if not out.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
        for at in ('180', '0'):  # a short video has no frame 3 minutes in
            ok, _ = ffmpeg.run(['-hide_banner', '-y', '-ss', at, '-i', str(p), '-frames:v', '1', '-vf', 'scale=320:-2',
                                '-q:v', '4', str(out)], timeout=60)
            if ok and out.exists():
                break
    return files_url(out) if out.exists() else None
