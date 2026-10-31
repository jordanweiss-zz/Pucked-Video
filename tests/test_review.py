import base64
import json
import subprocess
import time
import urllib.parse

from conftest import duration, size
from test_video import png, wait_for_clips

from server import review, youtube


def wait_for_review():
    for _ in range(600):
        if review._job is None:
            return
        time.sleep(0.1)
    raise AssertionError('review export never finished')


def streams(file):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', str(file)],
                         capture_output=True, text=True, check=True)
    return sorted(out.stdout.split())


def test_frame_counts_keep_time_with_the_voice():
    segs = [{'wall': 0.51}] * 100
    counts = review.frame_counts(segs, 30)
    assert sum(counts) == round(51 * 30)
    assert set(counts) <= {15, 16}


def test_atempo_chains_for_slow_motion():
    assert review.atempo(0.25) == 'atempo=0.5,atempo=0.50000'
    assert review.atempo(1) == 'atempo=1.00000'


def test_review_with_slow_motion_drawing_and_voice(api, game, tmp_path):
    voice = tmp_path / 'voice.webm'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=220:d=6', '-c:a', 'libopus', str(voice)], check=True)
    events = []
    review.send = lambda s: events.append(s)  # noqa: E731 - catch progress without a screen
    out = tmp_path / 'review.mp4'
    segments = [
        {'kind': 'play', 'from': 1, 'to': 2, 'wall': 1},  # normal speed
        {'kind': 'play', 'from': 2, 'to': 2.5, 'wall': 2},  # quarter speed
        {'kind': 'hold', 'at': 2.5, 'wall': 2.5, 'drawing': 0},  # paused on a drawing
        {'kind': 'hold', 'at': 3, 'wall': 0.5, 'drawing': None},
    ]
    res = api('review:export', {'video': str(game), 'out': str(out), 'w': 1920, 'h': 1080, 'fps': 30, 'segments': segments,
                                'drawings': [base64.b64encode(png(1920, 1080, (255, 255, 0, 255))).decode()],
                                'voice': base64.b64encode(voice.read_bytes()).decode(), 'voiceExt': '.webm', 'gameVolume': 0.25})
    assert res == {'ok': True}
    wait_for_review()
    assert events[-1]['state'] == 'done', events[-1]
    assert abs(duration(out) - 6) < 0.15
    assert size(out) == (1920, 1080)
    assert streams(out) == ['audio', 'video']
    # The held frame has the (solid yellow) drawing burned in.
    px = subprocess.run(['ffmpeg', '-v', 'error', '-ss', '4.5', '-i', str(out), '-frames:v', '1', '-vf', 'scale=1:1',
                         '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True, check=True).stdout
    assert px[0] > 200 and px[1] > 200 and px[2] < 80


def test_review_without_voice_or_game_sound(api, game, tmp_path):
    review.send = lambda s: None  # noqa: E731
    out = tmp_path / 'quiet.mp4'
    api('review:export', {'video': str(game), 'out': str(out), 'w': 1280, 'h': 720, 'fps': 30, 'gameVolume': 0,
                          'segments': [{'kind': 'play', 'from': 0, 'to': 2, 'wall': 2}]})
    wait_for_review()
    assert abs(duration(out) - 2) < 0.15
    assert size(out) == (1280, 720)


def test_clip_pauses_on_drawings(api, game, tmp_path):
    out = tmp_path / 'drawn.mp4'
    drawing = base64.b64encode(png(1920, 1080, (0, 0, 255, 255))).decode()
    look = {'fps': 30}
    res = api('clips:export', {'video': str(game), 'out': str(out), 'look': look,
                               'clips': [{'start': 1, 'end': 3, 'holds': [{'at': 2, 'secs': 2, 'drawing': drawing},
                                                                          {'at': 5, 'secs': 2, 'drawing': drawing}]}]})
    assert res['ok']
    wait_for_clips()
    assert abs(duration(out) - 4) < 0.25  # 2 s of play plus a 2 s pause; the drawing at 5 s is outside the clip
    px = subprocess.run(['ffmpeg', '-v', 'error', '-ss', '2', '-i', str(out), '-frames:v', '1', '-vf', 'scale=1:1',
                         '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True, check=True).stdout
    assert px[2] > 200 and px[0] < 80


def test_vertical_reel_with_drawing_and_logo(api, game, tmp_path):
    logo = tmp_path / 'logo.png'
    logo.write_bytes(png(64, 64))
    drawing = base64.b64encode(png(1920, 1080, (0, 0, 0, 0))).decode()
    out = tmp_path / 'reel9.mp4'
    look = {'vertical': True, 'outH': 1920, 'fps': 30, 'logo': {'file': str(logo), 'width': 120, 'opacity': 0.8, 'corner': 'tr'}}
    res = api('clips:export', {'video': str(game), 'out': str(out), 'look': look,
                               'clips': [{'start': 0, 'end': 1.5, 'holds': [{'at': 0.5, 'secs': 1, 'drawing': drawing}]},
                                         {'start': 3, 'end': 5}]})
    assert res['ok']
    wait_for_clips()
    assert size(out) == (1080, 1920)
    assert abs(duration(out) - 4.5) < 0.3


def test_youtube_setup_and_sign_in_link(api, tmp_path):
    assert api('youtube:status')['configured'] is False
    client = tmp_path / 'client_secret.json'
    client.write_text(json.dumps({'installed': {'client_id': '123-abc.apps.googleusercontent.com', 'client_secret': 's3cret'}}))
    st = api('youtube:setup', {'file': str(client)})
    assert st['configured'] and not st['connected']
    url = api('youtube:connect', 'http://localhost:51234')['url']
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
    assert q['redirect_uri'] == ['http://127.0.0.1:51234/api/youtube/callback']
    assert q['scope'] == [youtube.SCOPE] and q['code_challenge_method'] == ['S256']
    # The secret stays in the data folder, never sent to the screens.
    assert 's3cret' not in json.dumps(api('youtube:status'))


def test_youtube_rejects_a_web_client(client, tmp_path):
    f = tmp_path / 'web.json'
    f.write_text(json.dumps({'web': {'client_id': 'x.apps.googleusercontent.com', 'client_secret': 'y'}}))
    res = client.post('/api/youtube:setup', json={'args': [{'file': str(f)}]}, headers={'X-Pucked': '1'})
    assert res.status_code == 500 and 'Desktop app' in res.json()['error']


def test_youtube_callback_with_unknown_state(client):
    res = client.get('/api/youtube/callback', params={'state': 'nope', 'code': 'x'})
    assert res.status_code == 400 and 'expired' in res.text


def test_youtube_upload_in_pieces(tmp_path, monkeypatch):
    video = tmp_path / 'v.mp4'
    video.write_bytes(b'x' * 20)
    monkeypatch.setattr(youtube, 'CHUNK', 8)
    monkeypatch.setattr(youtube, 'access_token', lambda: 'tok')
    events = []
    monkeypatch.setattr(youtube, 'send', events.append)
    puts = []

    def fake(url, method, headers, data=None):
        if method == 'POST':
            assert json.loads(data)['status']['privacyStatus'] == 'unlisted'
            return 200, {'Location': 'https://upload/session'}, b''
        puts.append(headers['Content-Range'])
        if headers['Content-Range'].startswith('bytes 16-'):
            return 200, {}, json.dumps({'id': 'abc123def45', 'status': {'privacyStatus': 'private'}}).encode()
        return 308, {'Range': f"bytes=0-{headers['Content-Range'].split('-')[1].split('/')[0]}"}, b''

    monkeypatch.setattr(youtube, '_request', fake)
    youtube._upload_file({'cancelled': False}, str(video), 'Title', '', 'unlisted')
    assert puts == ['bytes 0-7/20', 'bytes 8-15/20', 'bytes 16-19/20']
    assert events[-1]['state'] == 'done' and events[-1]['url'] == 'https://youtu.be/abc123def45'
    assert events[-1]['privacy'] == 'private' and events[-1]['asked'] == 'unlisted'
