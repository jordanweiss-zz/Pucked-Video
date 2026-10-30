"""Saving clips and highlight reels with ffmpeg. Each clip is cut from the game video and
re-encoded (so it starts exactly where the user said), on the graphics card when it can be,
then a reel joins the clips without encoding them again."""
from __future__ import annotations

import base64
import shutil
import tempfile
import threading
from pathlib import Path

from . import events, ffmpeg

# Hardware H.264 encoders to try first (AMD, Apple, NVIDIA, Intel), then the CPU one, which always works.
ENCODERS = [
    {'name': 'h264_amf', 'args': ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cbr', '-b:v', '10M']},
    {'name': 'h264_videotoolbox', 'args': ['-c:v', 'h264_videotoolbox', '-b:v', '10M']},
    {'name': 'h264_nvenc', 'args': ['-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', '10M']},
    {'name': 'h264_qsv', 'args': ['-c:v', 'h264_qsv', '-b:v', '10M']},
    {'name': 'libx264', 'args': ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20']},
]

_encoder = None


def pick_encoder():
    """The first encoder that can really encode a frame on this computer. Listing isn't enough:
    a build can include h264_amf on a PC without an AMD card."""
    global _encoder
    if _encoder:
        return _encoder
    for enc in ENCODERS:
        ok, _ = ffmpeg.run(['-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=0.1', '-frames:v', '1',
                            *enc['args'], '-f', 'null', '-'], timeout=15)
        if ok:
            _encoder = enc
            return enc
    raise RuntimeError('ffmpeg could not encode video on this computer.')


_job: ffmpeg.Job | None = None


def send(state) -> None:
    events.send('clips:progress', state)


# Where the logo sits, `m` pixels in from the edges.
CORNERS = {
    'tl': lambda m: f'x={m}:y={m}',
    'tr': lambda m: f'x=W-w-{m}:y={m}',
    'bl': lambda m: f'x={m}:y=H-h-{m}',
    'br': lambda m: f'x=W-w-{m}:y=H-h-{m}',
}


def clip_filters(clip, look) -> str:
    """The filter graph for one clip: an optional 9:16 crop, the team logo, then the play name.
    The play name is drawn by the app as a picture (not every ffmpeg build can draw text) and laid over
    the first 4 seconds of the clip."""
    parts = []
    v = '[0:v]'
    nxt = 1
    if look.get('vertical'):
        # cropX picks where the 9:16 window sits across the picture, 0 = left edge, 1 = right edge.
        crop_x = clip.get('cropX')
        cx = f"{max(0.0, min(1.0, 0.5 if crop_x is None else float(crop_x))):.3f}"
        parts.append(f'{v}crop=w=trunc(ih*9/32)*2:h=ih:x=(iw-trunc(ih*9/32)*2)*{cx}:y=0,scale=1080:1920,setsar=1[c]')
        v = '[c]'
    logo = look.get('logo')
    if logo:
        m = round(look['outH'] / 30)
        parts.append(f"[{nxt}:v]scale={logo['width']}:-1,format=rgba,colorchannelmixer=aa={logo['opacity']}[lg]")
        parts.append(f"{v}[lg]overlay={CORNERS.get(logo.get('corner'), CORNERS['tr'])(m)}[l]")
        v = '[l]'
        nxt += 1
    if clip.get('overlay'):
        parts.append(f"{v}[{nxt}:v]overlay=x=H/30:y=H-h-H/30:enable='lt(t,4)'[t]")
        v = '[t]'
    parts.append(f'{v}format=yuv420p[v]')
    return ';'.join(parts)


def encode_clip(job, cwd, video, clip, out, look, on_progress) -> None:
    dur = max(0.1, clip['end'] - clip['start'])
    inputs = ['-ss', f"{clip['start']:.3f}", '-i', video]
    if look.get('logo'):
        inputs += ['-i', look['logo']['file']]
    if clip.get('overlay'):
        label = f"label{clip['i']}.png"
        Path(cwd, label).write_bytes(base64.b64decode(clip['overlay']))
        inputs += ['-i', label]
    args = ['-hide_banner', '-y', *inputs, '-t', f'{dur:.3f}', '-filter_complex', clip_filters(clip, look), '-map', '[v]',
            '-map', '0:a:0?', *_encoder['args'], '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
            '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', out]
    ffmpeg.run_with_progress(job, args, cwd, lambda s: on_progress(min(1.0, s / dur)))


def join_clips(cwd, files, out) -> None:
    """Join clips that all came from the same encoder without encoding again."""
    Path(cwd, 'list.txt').write_text('\n'.join(f"file '{f}'" for f in files), encoding='utf-8')
    ok, err = ffmpeg.run(['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy',
                          '-movflags', '+faststart', out], cwd=cwd)
    if not ok:
        raise RuntimeError(err)


def _export(job, video, clips, out, look) -> None:
    global _job
    cwd = tempfile.mkdtemp(prefix='pucked-clips-')
    try:
        pick_encoder()
        total = sum(c['end'] - c['start'] for c in clips) or 1
        done_sec = 0.0
        files = []
        for i, clip in enumerate(clips):
            file = out if len(clips) == 1 else str(Path(cwd, f'clip{i}.mp4'))
            length = clip['end'] - clip['start']

            def progress(f, i=i, length=length, done=done_sec):
                send({'state': 'running', 'pct': (done + f * length) / total * 100, 'clip': i + 1,
                      'clips': len(clips), 'encoder': _encoder['name']})

            encode_clip(job, cwd, video, {**clip, 'i': i}, file, look, progress)
            done_sec += length
            files.append(f'clip{i}.mp4')
        if len(clips) > 1:
            join_clips(cwd, files, out)
        send({'state': 'done', 'out': out, 'encoder': _encoder['name']})
    except ffmpeg.Cancelled:
        send({'state': 'cancelled'})
    except Exception as e:  # shown to the user as it is
        send({'state': 'failed', 'error': str(e)})
    finally:
        _job = None
        shutil.rmtree(cwd, ignore_errors=True)


def export_clips(opts):
    """`look` is the same for every clip in a reel, so they can be joined without encoding again:
    { vertical, outH, logo: { file, width, opacity, corner } | null }."""
    global _job
    if _job:
        return {'ok': False, 'error': 'A clip is already being saved. Wait for it to finish.'}
    _job = ffmpeg.Job()
    threading.Thread(target=_export, args=(_job, opts['video'], opts['clips'], opts['out'], opts.get('look') or {}),
                     daemon=True).start()
    return {'ok': True}


def cancel():
    if not _job:
        return False
    _job.cancel()
    return True


def save_frame(opts):
    """One frame of the game with the user's drawing laid over it."""
    cwd = tempfile.mkdtemp(prefix='pucked-frame-')
    try:
        Path(cwd, 'drawing.png').write_bytes(base64.b64decode(opts['overlay']))
        ok, err = ffmpeg.run(['-hide_banner', '-y', '-ss', f"{opts['time']:.3f}", '-i', opts['video'], '-i', 'drawing.png',
                              '-filter_complex', '[0:v][1:v]overlay', '-frames:v', '1', opts['out']], cwd=cwd)
        return {'ok': True} if ok else {'ok': False, 'error': err}
    finally:
        shutil.rmtree(cwd, ignore_errors=True)
