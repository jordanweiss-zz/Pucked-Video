"""Games, tags, teams, settings and the small lookups the screens need."""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from .config import APP_DIR, DATA_DIR, FFMPEG, NO_WINDOW, files_url, read_json, write_json


def video_info(file: str):
    """What the screens need to play a video from this computer. The video is streamed, never copied."""
    p = Path(file)
    if not p.is_file():
        return None
    return {'path': str(p), 'url': files_url(p), 'size': p.stat().st_size}


def list_sports():
    return [json.loads(f.read_text(encoding='utf-8')) for f in sorted((APP_DIR / 'sports').glob('*.json'))]


def tags_file(key: str) -> Path:
    """Tags for a local video are saved next to it as <video>.tags.json. YouTube videos have no
    file of their own, so theirs go in the app's data folder under youtube/<id>.tags.json."""
    yt = re.fullmatch(r'youtube:([\w-]{11})', key)
    if not yt:
        return Path(f'{key}.tags.json')
    d = DATA_DIR / 'youtube'
    d.mkdir(parents=True, exist_ok=True)
    return d / f'{yt.group(1)}.tags.json'


def load_tags(key: str):
    return read_json(tags_file(key), None)


def save_tags(key: str, data) -> bool:
    write_json(tags_file(key), data)
    return True


def xbotgo_marks(video_path: str):
    """XBotGo keeps a hidden .data folder next to each recording. Its .mark file lists the
    highlight-button presses as [{ type: 'start' | 'click', time: <seconds> }]."""
    p = Path(video_path)
    file = p.parent / '.data' / f'{p.stem}.mark'
    if not file.exists():
        return []
    try:
        marks = json.loads(file.read_text(encoding='utf-8'))
        return [m['time'] for m in marks if m.get('type') == 'click' and isinstance(m.get('time'), (int, float)) and not isinstance(m.get('time'), bool)]
    except (ValueError, TypeError, KeyError):
        return []


# Teams and rosters are shared by every game, so they live in the app's data folder.
def load_teams():
    return read_json(DATA_DIR / 'teams.json', {'teams': []})


def save_teams(data) -> bool:
    write_json(DATA_DIR / 'teams.json', data)
    return True


# App settings (e.g. where Hockey_AI lives) are kept in settings.json in the app's data folder.
def settings_file() -> Path:
    return DATA_DIR / 'settings.json'


def load_settings():
    return read_json(settings_file(), {})


def save_settings(data) -> bool:
    write_json(settings_file(), data)
    return True


# Hockey_AI is a folder with config/events.json and main.py in it. Look in the usual places, so the
# user doesn't have to know where it went.
AI_NAMES = ('Hockey_AI', 'Hockey_AI-main', 'hockey_ai')


def is_hockey_ai(d) -> bool:
    return bool(d) and (Path(d) / 'config' / 'events.json').exists() and (Path(d) / 'main.py').exists()


def check_ai_dir(d):
    if is_hockey_ai(d):
        return d
    # Picked the folder one level up, or a download that unzipped into Hockey_AI-main\Hockey_AI-main.
    for sub in AI_NAMES:
        if d and is_hockey_ai(Path(d) / sub):
            return str(Path(d) / sub)
    return None


def find_ai_dir():
    home = Path.home()
    for spot in ('Projects', 'Documents', 'Desktop', 'Downloads', '', 'source/repos', 'Documents/GitHub', 'GitHub'):
        for name in AI_NAMES:
            d = home / spot / name
            if is_hockey_ai(d):
                return str(d)
            if is_hockey_ai(d / name):
                return str(d / name)
    return None


def check_ffmpeg():
    try:
        out = subprocess.run([FFMPEG, '-version'], capture_output=True, text=True, timeout=15, creationflags=NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired) as e:
        return {'ok': False, 'error': str(e)}
    if out.returncode != 0:
        return {'ok': False, 'error': out.stderr.strip()}
    return {'ok': True, 'version': out.stdout.split('\n')[0]}
