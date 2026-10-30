import base64
import struct
import subprocess
import time
import zlib

from conftest import duration, size

from server import autocut, clips


def png(w, h, rgba=(255, 0, 0, 200)):
    raw = b''.join(b'\x00' + bytes(rgba) * w for _ in range(h))

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)) + \
        chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


def wait_for_clips():
    for _ in range(600):
        if clips._job is None:
            return
        time.sleep(0.1)
    raise AssertionError('clip export never finished')


def test_one_clip(api, game, tmp_path):
    out = tmp_path / 'clip.mp4'
    assert api('clips:export', {'video': str(game), 'clips': [{'start': 1, 'end': 3}], 'out': str(out), 'look': {}})['ok']
    wait_for_clips()
    assert abs(duration(out) - 2) < 0.2


def test_vertical_reel_with_logo_and_labels(api, game, tmp_path):
    logo = tmp_path / 'logo.png'
    logo.write_bytes(png(64, 64))
    label = base64.b64encode(png(300, 60)).decode()
    out = tmp_path / 'reel.mp4'
    look = {'vertical': True, 'outH': 1920, 'logo': {'file': str(logo), 'width': 120, 'opacity': 0.8, 'corner': 'bl'}}
    res = api('clips:export', {'video': str(game), 'out': str(out), 'look': look,
                               'clips': [{'start': 0, 'end': 1.5, 'overlay': label, 'cropX': 0.2},
                                         {'start': 3, 'end': 5, 'overlay': label}]})
    assert res['ok']
    wait_for_clips()
    assert size(out) == (1080, 1920)
    assert abs(duration(out) - 3.5) < 0.3


def test_save_frame_with_drawing(api, game, tmp_path):
    out = tmp_path / 'frame.png'
    res = api('frame:save', {'video': str(game), 'time': 2.0, 'overlay': base64.b64encode(png(1920, 1080, (0, 0, 0, 0))).decode(),
                             'out': str(out)})
    assert res == {'ok': True}
    assert size(out) == (1920, 1080)


def test_whistles_found(api, tmp_path):
    video = tmp_path / 'rink.m4a'
    # Rink noise with a 3.1 kHz whistle at 10 s for 1.2 s, and a too-short blip at 20 s.
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=d=30:c=pink:a=0.05:r=48000',
                    '-f', 'lavfi', '-i', 'sine=f=3150:d=30:r=48000', '-filter_complex',
                    "[1:a]volume='if(between(t,10,11.2)+between(t,20,20.1),0.5,0)':eval=frame[w];[0:a][w]amix=inputs=2:normalize=0[a]",
                    '-map', '[a]', '-c:a', 'aac', str(video)], check=True)
    res = api('autocut:scan', str(video))
    assert res['ok'] and not res['silent']
    assert [round(w['time']) for w in res['whistles']] == [10]
    assert abs(res['duration'] - 30) < 0.1


def test_condensed_game(api, game, tmp_path):
    out = tmp_path / 'condensed.mp4'
    assert api('autocut:save', {'video': str(game), 'keep': [[0, 2], [4, 6]], 'out': str(out)}) == {'ok': True}
    assert 3.5 < duration(out) < 4.6


def test_camera_motion(api, tmp_path):
    (tmp_path / '.data').mkdir()
    (tmp_path / '.data' / 'g.track').write_text('\n'.join([
        'UTC23:59:59.10 a Frame1 Yaw10.0', 'UTC23:59:59.60 a Frame2 Yaw12.5',
        'UTC00:00:00.20 a Frame3 Yaw12.0',  # past midnight
        'UTC00:00:02.10 a Frame4 Yaw-1',
    ]))
    assert api('xbotgo:motion', str(tmp_path / 'g.mp4')) == [2.5, 0.0, None, 0.0]
    assert autocut.track_motion(str(tmp_path / 'none.mp4')) is None
