import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

# The server reads where its data lives when it's imported, so point it at a scratch folder first.
DATA = Path(tempfile.mkdtemp(prefix='pucked-test-data-'))
os.environ['PUCKED_DATA_DIR'] = str(DATA)
os.environ['PUCKED_NO_OPEN'] = '1'
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from server.app import app  # noqa: E402


@pytest.fixture(scope='session')
def client():
    with TestClient(app, base_url='http://127.0.0.1') as c:
        yield c


@pytest.fixture
def api(client):
    def call(name, *args):
        res = client.post(f'/api/{name}', json={'args': list(args)}, headers={'X-Pucked': '1'})
        assert res.status_code == 200, res.text
        return res.json()['result']
    return call


@pytest.fixture(scope='session')
def game(tmp_path_factory):
    """A 6-second 1920x1080 game with sound, and an XBotGo .data folder next to it."""
    d = tmp_path_factory.mktemp('games')
    video = d / 'game.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=d=6:s=1920x1080:r=30',
                    '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
                    '-shortest', str(video)], check=True)
    (d / '.data').mkdir()
    (d / '.data' / 'game.mark').write_text('[{"type":"start","time":0},{"type":"click","time":2.5},{"type":"click","time":4}]')
    return video


def duration(file) -> float:
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(file)],
                         capture_output=True, text=True, check=True)
    return float(out.stdout)


def size(file):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
                          '-of', 'csv=p=0', str(file)], capture_output=True, text=True, check=True)
    return tuple(int(x) for x in out.stdout.strip().split(','))
