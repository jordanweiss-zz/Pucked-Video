"""Finding the dead time in a game (Auto-Cut) and saving a condensed copy without it.
Two things point at stoppages: the referee's whistle in the sound, and the XBotGo camera
holding still (its .track log has the pan angle about 20 times a second).
The screens turn those into cut parts with the user's settings; this file only measures."""
from __future__ import annotations

import math
import re
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

import numpy as np

from . import events, ffmpeg, notices
from .config import FFMPEG, NO_WINDOW

# --- Camera movement from the XBotGo .track log ---

TRACK_LINE = re.compile(r'^UTC(\d+):(\d+):([\d.]+).*?Frame\d+ Yaw(-?[\d.]+)')


def track_motion(video_path: str):
    """How far the camera turned in each second of the video, in degrees (None where the log has a gap)."""
    p = Path(video_path)
    file = p.parent / '.data' / f'{p.stem}.track'
    if not file.exists():
        return None
    lo: dict[int, float] = {}
    hi: dict[int, float] = {}
    t0 = None
    for line in file.read_text(encoding='latin-1').split('\n'):
        m = TRACK_LINE.match(line)
        if not m:
            continue
        t = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
        if t0 is None:
            t0 = t
        if t < t0:
            t += 86400  # the game went past midnight
        s = math.floor(t - t0)
        yaw = float(m.group(4))
        lo[s] = min(lo.get(s, yaw), yaw)
        hi[s] = max(hi.get(s, yaw), yaw)
    length = max(hi) + 1 if hi else 0
    return [round(hi[s] - lo[s], 2) if s in hi else None for s in range(length)]


# --- Whistles in the sound ---

RATE = 16000
N = 1024  # 64 ms per frame
HOP = 512  # a frame every 32 ms
BAND = (round(2000 * N / RATE), round(4500 * N / RATE))  # where whistles ring
HANN = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N) / (N - 1))


def frame_scores(samples: np.ndarray):
    """For each 32 ms frame: how much one pitch in the whistle band stands out (tone) and how loud the band is.
    A whistle is a loud, steady, high pitch; skates, sticks and the crowd spread over many pitches.
    Returns (tone, share, band, hz) arrays and how many samples were used."""
    count = (len(samples) - N) // HOP + 1 if len(samples) >= N else 0
    if count <= 0:
        empty = np.zeros(0)
        return (empty, empty, empty, empty), 0
    idx = np.arange(N)[None, :] + HOP * np.arange(count)[:, None]
    spec = np.fft.rfft(samples[idx].astype(np.float64) * HANN, axis=1)
    power = spec.real ** 2 + spec.imag ** 2
    all_ = power[:, 1:N // 2].sum(axis=1)
    band = power[:, BAND[0]:BAND[1] + 1]
    total = band.sum(axis=1)
    peak_bin = band.argmax(axis=1) + BAND[0]
    rows = np.arange(count)
    # Count the peak with its neighbours: a whistle's pitch wobbles across a bin or two.
    near = power[rows, peak_bin] + power[rows, peak_bin - 1] + power[rows, peak_bin + 1]
    mean = (total - near) / (BAND[1] - BAND[0] - 2)
    mean = np.where(mean == 0, 1e-12, mean)
    tone = near / 3 / mean
    share = np.divide(total, all_, out=np.zeros_like(total), where=all_ != 0)
    hz = peak_bin * RATE / N
    return (tone, share, total, hz), count * HOP


def scan_sound(video_path: str, on_progress, job: ffmpeg.Job):
    """Read the sound with ffmpeg and score every frame."""
    proc = subprocess.Popen([FFMPEG, '-hide_banner', '-nostats', '-i', video_path, '-vn', '-sn', '-ac', '1',
                             '-ar', str(RATE), '-f', 'f32le', 'pipe:1'],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=NO_WINDOW)
    job.proc = proc
    info = {'duration': 0.0, 'err': ''}

    def read_err():
        for raw in proc.stderr:
            line = raw.decode('utf-8', 'replace')
            info['err'] = (info['err'] + line)[-4000:]
            m = re.search(r'Duration: (\d+):(\d+):([\d.]+)', line)
            if m and not info['duration']:
                info['duration'] = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))

    t = threading.Thread(target=read_err, daemon=True)
    t.start()
    parts = {'tone': [], 'share': [], 'band': [], 'hz': []}
    carry = np.zeros(0, dtype=np.float32)
    frames = 0
    reported = 0
    leftover = b''
    while True:
        chunk = proc.stdout.read(1 << 20)
        if not chunk:
            break
        # Samples can be split across chunks, so keep what's left over for the next one.
        data = leftover + chunk
        n = len(data) // 4
        leftover = data[n * 4:]
        samples = np.concatenate([carry, np.frombuffer(data[:n * 4], dtype='<f4')])
        (tone, share, band, hz), used = frame_scores(samples)
        for k, v in zip(('tone', 'share', 'band', 'hz'), (tone, share, band, hz)):
            parts[k].append(v)
        frames += len(tone)
        carry = samples[used:]
        if info['duration'] and frames - reported >= 3000:
            reported = frames
            on_progress(min(1.0, frames * HOP / RATE / info['duration']))
    code = proc.wait()
    t.join(timeout=5)
    job.proc = None
    out = {k: np.concatenate(v) if v else np.zeros(0) for k, v in parts.items()}
    out['duration'] = info['duration']
    if job.cancelled:
        raise ffmpeg.Cancelled()
    if code == 0:
        return out
    # A video with no sound: nothing to listen to, so only the camera log is used.
    if re.search(r'does not contain any stream|matches no streams', info['err']):
        out['silent'] = True
        return out
    raise RuntimeError(ffmpeg.last_line(info['err'], f'ffmpeg stopped (exit code {code})'))


def find_whistles(sound):
    """Whistle times from the frame scores. A whistle is at least ~0.3 s of a clear tone that is
    louder than the usual rink noise around it."""
    tone, share, band, hz = (list(map(float, sound[k])) for k in ('tone', 'share', 'band', 'hz'))
    sec = HOP / RATE
    # The usual band loudness over the last ~10 s, so a loud crowd doesn't count as a whistle.
    win = round(10 / sec)
    medians = []
    for i in range(0, len(band), win):
        part = sorted(band[i:i + win])
        medians.append(part[len(part) // 2] or 1e-12)
    out = []
    start, strength, pitch = -1, 0.0, 0.0
    for i in range(len(tone) + 1):
        on = (i < len(tone) and tone[i] > 12 and share[i] > 0.2 and band[i] > medians[i // win] * 3
              and (start < 0 or abs(hz[i] - pitch) < 250))
        if on:
            if start < 0:
                start, strength, pitch = i, 0.0, hz[i]
            strength = max(strength, tone[i])
        elif start >= 0:
            length = (i - start) * sec
            if length >= 0.3:
                out.append({'time': round(start * sec, 2), 'length': round(length, 2), 'strength': _js_round(strength),
                            'hz': _js_round(pitch)})
            start = -1
    # Two blasts close together are one whistle.
    return [w for i, w in enumerate(out) if i == 0 or w['time'] - (out[i - 1]['time'] + out[i - 1]['length']) > 1.5]


def _js_round(x: float) -> int:
    # Math.round rounds halves up; Python's round() rounds them to even.
    return math.floor(x + 0.5)


# --- Saving a condensed game: the kept parts joined without encoding (fast, no quality loss) ---

def _save_condensed(job, video, keep, out) -> None:
    cwd = tempfile.mkdtemp(prefix='pucked-condensed-')
    try:
        file = video.replace("'", "'\\''")
        Path(cwd, 'list.txt').write_text(
            '\n'.join(f"file '{file}'\ninpoint {a:.3f}\noutpoint {b:.3f}" for a, b in keep), encoding='utf-8')
        total = sum(b - a for a, b in keep) or 1
        ffmpeg.run_with_progress(job, ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt',
                                       '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-avoid_negative_ts', 'make_zero',
                                       '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', out], cwd,
                                 lambda s: send({'state': 'saving', 'pct': min(100.0, s / total * 100)}))
    finally:
        shutil.rmtree(cwd, ignore_errors=True)


_job: ffmpeg.Job | None = None
_lock = threading.Lock()


def send(state) -> None:
    events.send('autocut:progress', state)
    notices.progress('autocut', state.get('pct'))


def _start():
    global _job
    with _lock:
        if _job:
            return None
        _job = ffmpeg.Job()
        return _job


def _finish():
    global _job
    _job = None


def scan(video: str):
    job = _start()
    if not job:
        return {'ok': False, 'error': 'Already working on it.'}
    notices.begin('autocut', 'Auto-Cut: finding the dead time', Path(video).name)
    try:
        sound = scan_sound(video, lambda f: send({'state': 'scanning', 'pct': f * 100}), job)
        found = {'ok': True, 'whistles': find_whistles(sound), 'duration': sound['duration'],
                 'silent': bool(sound.get('silent')), 'motion': track_motion(video)}
        notices.finish('autocut', 'done', 'Ready to look over in Auto-Cut.')
        return found
    except ffmpeg.Cancelled:
        notices.finish('autocut', 'cancelled')
        return {'ok': False, 'cancelled': True}
    except Exception as e:
        notices.finish('autocut', 'failed', str(e))
        return {'ok': False, 'error': str(e)}
    finally:
        _finish()


def save(opts):
    job = _start()
    if not job:
        return {'ok': False, 'error': 'Already working on it.'}
    notices.begin('autocut', 'Saving the game without dead time', Path(opts['out']).name)
    try:
        _save_condensed(job, opts['video'], opts['keep'], opts['out'])
        notices.finish('autocut', 'done', file=opts['out'])
        return {'ok': True}
    except ffmpeg.Cancelled:
        notices.finish('autocut', 'cancelled')
        return {'ok': False, 'cancelled': True}
    except Exception as e:
        notices.finish('autocut', 'failed', str(e))
        return {'ok': False, 'error': str(e)}
    finally:
        _finish()


def cancel():
    if not _job:
        return False
    _job.cancel()
    return True
