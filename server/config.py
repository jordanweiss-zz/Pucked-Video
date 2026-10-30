"""Where things are: the app's own folder, its data folder, and ffmpeg."""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path
from urllib.parse import quote

APP_DIR = Path(os.environ.get('PUCKED_APP_DIR') or Path(__file__).resolve().parent.parent)


def _default_data_dir() -> Path:
    # The same folder Electron used as userData, so settings, teams and YouTube tags carry over.
    if sys.platform == 'win32':
        return Path(os.environ.get('APPDATA', Path.home() / 'AppData' / 'Roaming')) / 'pucked-video'
    if sys.platform == 'darwin':
        return Path.home() / 'Library' / 'Application Support' / 'pucked-video'
    return Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config')) / 'pucked-video'


DATA_DIR = Path(os.environ.get('PUCKED_DATA_DIR') or _default_data_dir())


def _find_ffmpeg() -> str:
    # The Electron window passes the ffmpeg it ships; otherwise the npm copy, then the one on PATH.
    if os.environ.get('PUCKED_FFMPEG'):
        return os.environ['PUCKED_FFMPEG']
    exe = 'ffmpeg.exe' if sys.platform == 'win32' else 'ffmpeg'
    bundled = APP_DIR / 'node_modules' / 'ffmpeg-static' / exe
    if bundled.exists():
        return str(bundled)
    return shutil.which('ffmpeg') or exe


FFMPEG = _find_ffmpeg()

# Hide the console window that each ffmpeg or Python run would otherwise flash on Windows.
NO_WINDOW = 0x08000000 if sys.platform == 'win32' else 0


def read_json(file, fallback=None):
    file = Path(file)
    if not file.exists():
        return fallback
    return json.loads(file.read_text(encoding='utf-8'))


def write_json(file, data) -> None:
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(data, indent=2), encoding='utf-8')


def mtime_ms(file) -> float:
    try:
        return os.stat(file).st_mtime * 1000
    except OSError:
        return 0


def files_url(file) -> str:
    """The URL the screens use to show a file from this computer (a video, a picture).

    C:\\Videos\\game.mp4 -> /files/C:/Videos/game.mp4 and /home/me/game.mp4 -> /files/home/me/game.mp4.
    Relative paths resolve against it, which is how the AI players' thumbnails load.
    """
    p = str(file).replace('\\', '/').lstrip('/')
    return '/files/' + quote(p, safe='/:')


def path_from_url(p: str) -> Path:
    """The reverse of files_url for the part after /files/ (already URL-decoded)."""
    if sys.platform == 'win32':
        return Path(p)
    return Path('/' + p.lstrip('/'))
