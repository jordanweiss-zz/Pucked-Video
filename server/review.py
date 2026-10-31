"""Review clips: a stretch of the game played back the way the coach showed it while recording,
with their drawings and their voice.

While recording, the screens note what was on screen as a list of segments: the video playing from
one time to another (at whatever speed, slow motion included), or held on one frame, with or without
a drawing. Each segment is encoded at its own length so the picture stays in step with the voice,
the segments are joined, and the voice is mixed over the game's own sound."""
from __future__ import annotations

import base64
import re
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

from . import clips, events, ffmpeg
from .config import FFMPEG, NO_WINDOW

_job: ffmpeg.Job | None = None

# Longest review we'll make, so a forgotten recording can't fill the disk.
MAX_SECONDS = 20 * 60


def send(state) -> None:
    events.send('review:progress', state)


def has_audio(video: str) -> bool:
    # With no output named ffmpeg exits with an error, but it lists the streams first.
    try:
        out = subprocess.run([FFMPEG, '-hide_banner', '-i', video], capture_output=True, text=True, errors='replace',
                             timeout=30, creationflags=NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return bool(re.search(r'Stream #\d+:\d+.*: Audio:', out.stderr))


def atempo(rate: float) -> str:
    """atempo takes 0.5 to 2 per step, so chain steps for slower or faster."""
    steps = []
    while rate < 0.5:
        steps.append('atempo=0.5')
        rate /= 0.5
    while rate > 2:
        steps.append('atempo=2')
        rate /= 2
    steps.append(f'atempo={rate:.5f}')
    return ','.join(steps)


def frame_counts(segments, fps):
    """How many frames each segment gets. Rounding each one on its own would let the picture drift
    from the voice over a long review, so round where each one ends instead."""
    counts, total, done = [], 0.0, 0
    for s in segments:
        total += max(0.0, float(s['wall']))
        end = round(total * fps)
        counts.append(end - done)
        done = end
    return counts


def segment_args(video, seg, i, frames, look, game_audio):
    """ffmpeg arguments that encode one segment to seg<i>.mkv (video plus PCM sound, so the joins are exact)."""
    fps, w, h = look['fps'], look['w'], look['h']
    dur = frames / fps
    size = f'scale={w}:{h},setsar=1'
    finish = f'tpad=stop_mode=clone:stop_duration={dur + 1:.3f},fps={fps},format=yuv420p[v]'
    silence = ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']
    if seg['kind'] == 'play':
        src = max(1 / fps, float(seg['to']) - float(seg['from']))
        stretch = dur / src  # >1 is slow motion
        inputs = ['-ss', f"{float(seg['from']):.3f}", '-t', f'{src + 0.1:.3f}', '-i', video]
        graph = f'[0:v]setpts=(PTS-STARTPTS)*{stretch:.5f},{size},{finish}'
        if game_audio:
            graph += f';[0:a]asetpts=PTS-STARTPTS,{atempo(1 / stretch)},aresample=48000,aformat=channel_layouts=stereo,apad[a]'
            audio = '[a]'
        else:
            inputs += silence
            audio = '1:a'
    else:  # a held frame, maybe with a drawing over it
        inputs = ['-ss', f"{float(seg['at']):.3f}", '-i', video]
        graph = '[0:v]trim=end_frame=1,setpts=PTS-STARTPTS'
        if seg.get('drawing') is not None:
            inputs += ['-i', f"drawing{seg['drawing']}.png"]
            graph += '[f];[f][1:v]overlay'
        graph += f',{size},{finish}'
        inputs += silence
        audio = f"{2 if seg.get('drawing') is not None else 1}:a"
    return ['-hide_banner', '-y', *inputs, '-filter_complex', graph, '-map', '[v]', '-map', audio,
            '-frames:v', str(frames), '-t', f'{dur:.4f}', *clips.encoder_args(None, w, h), '-c:a', 'pcm_s16le',
            '-ar', '48000', '-ac', '2', '-progress', 'pipe:1', '-nostats', f'seg{i}.mkv']


def final_args(voice, game_volume, out):
    """Join the segments, then lay the voice over the game's sound."""
    inputs = ['-f', 'concat', '-safe', '0', '-i', 'list.txt']
    if voice:
        inputs += ['-i', voice]
        graph = (f'[0:a]volume={game_volume:.2f}[g];[1:a]aresample=48000,aformat=channel_layouts=stereo[vo];'
                 '[g][vo]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]')
    else:
        graph = f'[0:a]volume={game_volume:.2f}[a]'
    return ['-hide_banner', '-y', *inputs, '-filter_complex', graph, '-map', '0:v', '-map', '[a]', '-c:v', 'copy',
            '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', out]


def _export(job, opts) -> None:
    global _job
    cwd = tempfile.mkdtemp(prefix='pucked-review-')
    try:
        look = {'fps': int(opts.get('fps') or 30), 'w': int(opts['w']) // 2 * 2, 'h': int(opts['h']) // 2 * 2}
        segments = opts['segments']
        counts = frame_counts(segments, look['fps'])
        total = sum(counts) or 1
        if total / look['fps'] > MAX_SECONDS:
            raise RuntimeError(f'Review clips can be up to {MAX_SECONDS // 60} minutes long.')
        for i, png in enumerate(opts.get('drawings') or []):
            Path(cwd, f'drawing{i}.png').write_bytes(base64.b64decode(png))
        voice = None
        if opts.get('voice'):
            voice = 'voice' + (opts.get('voiceExt') or '.webm')
            Path(cwd, voice).write_bytes(base64.b64decode(opts['voice']))
        volume = max(0.0, min(1.0, float(opts.get('gameVolume', 0.25))))
        game_audio = volume > 0 and has_audio(opts['video'])

        done = 0
        files = []
        for i, (seg, frames) in enumerate(zip(segments, counts)):
            if frames <= 0:
                continue
            dur = frames / look['fps']

            def progress(sec, done=done, dur=dur):
                send({'state': 'running', 'pct': min(95.0, (done + min(sec, dur) * look['fps']) / total * 95)})

            ffmpeg.run_with_progress(job, segment_args(opts['video'], seg, i, frames, look, game_audio), cwd, progress)
            done += frames
            files.append(f'seg{i}.mkv')
        if not files:
            raise RuntimeError('The recording was too short to make a video.')
        Path(cwd, 'list.txt').write_text('\n'.join(f"file '{f}'" for f in files), encoding='utf-8')
        secs = total / look['fps']
        ffmpeg.run_with_progress(job, final_args(voice, volume, opts['out']), cwd,
                                 lambda s: send({'state': 'running', 'pct': 95 + min(1.0, s / secs) * 5}))
        send({'state': 'done', 'out': opts['out'], 'seconds': secs})
    except ffmpeg.Cancelled:
        send({'state': 'cancelled'})
    except Exception as e:  # shown to the user as it is
        send({'state': 'failed', 'error': str(e)})
    finally:
        _job = None
        shutil.rmtree(cwd, ignore_errors=True)


def export_review(opts):
    """opts: { video, out, w, h, fps, segments: [{kind:'play', from, to, wall} | {kind:'hold', at, wall, drawing}],
    drawings: [png base64], voice: base64, voiceExt, gameVolume 0..1 }."""
    global _job
    if _job:
        return {'ok': False, 'error': 'A review clip is already being saved. Wait for it to finish.'}
    _job = ffmpeg.Job()
    threading.Thread(target=_export, args=(_job, opts), daemon=True).start()
    return {'ok': True}


def cancel():
    if not _job:
        return False
    _job.cancel()
    return True
