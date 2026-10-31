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
# Hardware ones get a bitrate for the picture size (see bitrate()); the CPU one picks its own with -crf.
ENCODERS = [
    {'name': 'h264_amf', 'args': ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cbr', '-b:v', '{rate}']},
    {'name': 'h264_videotoolbox', 'args': ['-c:v', 'h264_videotoolbox', '-b:v', '{rate}']},
    {'name': 'h264_nvenc', 'args': ['-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', '{rate}']},
    {'name': 'h264_qsv', 'args': ['-c:v', 'h264_qsv', '-b:v', '{rate}']},
    {'name': 'libx264', 'args': ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20']},
]
CPU = ENCODERS[-1]

_encoder = None


def bitrate(w=1920, h=1080) -> str:
    """10 Mbit/s for 1080p, more for bigger pictures (about 40 for 4K), so 4K clips don't come out blocky."""
    return f'{max(6, min(45, round(10 * w * h / (1920 * 1080))))}M'


def encoder_args(enc=None, w=1920, h=1080):
    rate = bitrate(w, h)
    return [a.replace('{rate}', rate) for a in (enc or pick_encoder())['args']]


def _size_args(enc, look):
    return encoder_args(enc, look.get('outW') or 1920, look.get('outH') or 1080)


def pick_encoder():
    """The first encoder that can really encode a frame on this computer. Listing isn't enough:
    a build can include h264_amf on a PC without an AMD card."""
    global _encoder
    if _encoder:
        return _encoder
    for enc in ENCODERS:
        ok, _ = ffmpeg.run(['-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=0.1', '-frames:v', '1',
                            *encoder_args(enc), '-f', 'null', '-'], timeout=15)
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


def clip_filters(clip, look, v='[0:v]', nxt=1, pre=()) -> str:
    """The filter graph for one clip: an optional 9:16 crop, the team logo, then the play name.
    The play name is drawn by the app as a picture (not every ffmpeg build can draw text) and laid over
    the first 4 seconds of the clip. `pre` are filters that make the picture `v` first (a held frame)."""
    parts = list(pre)
    if look.get('vertical'):
        # cropX picks where the 9:16 window sits across the picture, 0 = left edge, 1 = right edge.
        crop_x = clip.get('cropX')
        cx = f"{max(0.0, min(1.0, 0.5 if crop_x is None else float(crop_x))):.3f}"
        parts.append(f'{v}crop=w=trunc(ih*9/32)*2:h=ih:x=(iw-trunc(ih*9/32)*2)*{cx}:y=0,scale=1080:1920,setsar=1[c]')
        v = '[c]'
    elif look.get('scaleH'):
        # A smaller copy of a bigger-than-1080p game, for sharing.
        parts.append(f"{v}scale=-2:{int(look['scaleH'])},setsar=1[s]")
        v = '[s]'
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
    # One frame rate for every piece, so plays and held frames join cleanly.
    rate = f"fps={int(look['fps'])}," if look.get('fps') else ''
    parts.append(f'{v}{rate}format=yuv420p[v]')
    return ';'.join(parts)


def encode_clip(job, cwd, video, clip, out, look, on_progress, enc) -> None:
    dur = max(0.1, clip['end'] - clip['start'])
    inputs = ['-ss', f"{clip['start']:.3f}", '-i', video]
    if look.get('logo'):
        inputs += ['-i', look['logo']['file']]
    if clip.get('overlay'):
        label = f"label{clip['i']}.png"
        Path(cwd, label).write_bytes(base64.b64decode(clip['overlay']))
        inputs += ['-i', label]
    args = ['-hide_banner', '-y', *inputs, '-t', f'{dur:.3f}', '-filter_complex', clip_filters(clip, look), '-map', '[v]',
            '-map', '0:a:0?', *_size_args(enc, look), '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
            '-movflags', '+faststart', '-video_track_timescale', '90000', '-progress', 'pipe:1', '-nostats', out]
    ffmpeg.run_with_progress(job, args, cwd, lambda s: on_progress(min(1.0, s / dur)))


def encode_hold(job, cwd, video, hold, out, look, on_progress, enc) -> None:
    """A frame the user drew on, held still for a few seconds with the drawing over it, in the same look
    as the clip around it so they join without encoding again."""
    secs, fps = float(hold['secs']), int(look.get('fps') or 30)
    png = f"hold{hold['i']}.png"
    Path(cwd, png).write_bytes(base64.b64decode(hold['drawing']))
    inputs = ['-ss', f"{hold['at']:.3f}", '-i', video, '-i', png]
    if look.get('logo'):
        inputs += ['-i', look['logo']['file']]
    inputs += ['-f', 'lavfi', '-t', f'{secs:.3f}', '-i', 'anullsrc=r=48000:cl=stereo']
    silence = 3 if look.get('logo') else 2
    pre = ['[0:v]trim=end_frame=1,setpts=PTS-STARTPTS[f0]',
           f'[f0][1:v]overlay,tpad=stop_mode=clone:stop_duration={secs:.3f},fps={fps}[held]']
    graph = clip_filters({'cropX': hold.get('cropX')}, look, v='[held]', nxt=2, pre=pre)
    args = ['-hide_banner', '-y', *inputs, '-filter_complex', graph, '-map', '[v]', '-map', f'{silence}:a',
            '-t', f'{secs:.3f}', *_size_args(enc, look), '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
            '-movflags', '+faststart', '-video_track_timescale', '90000', '-progress', 'pipe:1', '-nostats', out]
    ffmpeg.run_with_progress(job, args, cwd, lambda s: on_progress(min(1.0, s / secs)))


def pieces(clip):
    """A clip with drawings in it, split where it pauses on each drawn frame:
    [('play', {start, end}), ('hold', {at, secs, drawing}), ('play', ...), ...]."""
    out, t = [], clip['start']
    for h in sorted(clip.get('holds') or [], key=lambda h: h['at']):
        if not clip['start'] <= h['at'] < clip['end']:
            continue
        if h['at'] - t > 0.05:
            out.append(('play', {'start': t, 'end': h['at']}))
        out.append(('hold', h))
        t = h['at']
    if clip['end'] - t > 0.05 or not out:
        out.append(('play', {'start': t, 'end': clip['end']}))
    return out


def join_clips(cwd, files, out) -> None:
    """Join clips that all came from the same encoder without encoding again."""
    Path(cwd, 'list.txt').write_text('\n'.join(f"file '{f}'" for f in files), encoding='utf-8')
    ok, err = ffmpeg.run(['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy',
                          '-movflags', '+faststart', out], cwd=cwd)
    if not ok:
        raise RuntimeError(err)


def _encode_all(job, cwd, video, clips, out, look, enc) -> None:
    # Every play and held frame is encoded on its own, then they're all joined without encoding again.
    parts = []
    for i, clip in enumerate(clips):
        for j, (kind, p) in enumerate(pieces(clip)):
            parts.append((i, kind, {**clip, **p, 'overlay': clip.get('overlay') if j == 0 else None, 'holds': None}))
    length = lambda kind, p: float(p['secs']) if kind == 'hold' else p['end'] - p['start']  # noqa: E731
    total = sum(length(k, p) for _, k, p in parts) or 1
    done_sec = 0.0
    files = []
    for n, (i, kind, p) in enumerate(parts):
        file = out if len(parts) == 1 else str(Path(cwd, f'part{n}.mp4'))
        size = length(kind, p)

        def progress(f, i=i, size=size, done=done_sec):
            send({'state': 'running', 'pct': (done + f * size) / total * 100, 'clip': i + 1,
                  'clips': len(clips), 'encoder': enc['name']})

        if kind == 'hold':
            encode_hold(job, cwd, video, {**p, 'i': n}, file, look, progress, enc)
        else:
            encode_clip(job, cwd, video, {**p, 'i': n}, file, look, progress, enc)
        done_sec += size
        files.append(f'part{n}.mp4')
    if len(parts) > 1:
        join_clips(cwd, files, out)


def _export(job, video, clips, out, look) -> None:
    global _job
    cwd = tempfile.mkdtemp(prefix='pucked-clips-')
    try:
        enc = pick_encoder()
        try:
            _encode_all(job, cwd, video, clips, out, look, enc)
        except RuntimeError:
            # Some graphics cards can't encode every size (4K on older ones), so do it on the CPU instead.
            if enc is CPU:
                raise
            enc = CPU
            _encode_all(job, cwd, video, clips, out, look, enc)
        send({'state': 'done', 'out': out, 'encoder': enc['name']})
    except ffmpeg.Cancelled:
        send({'state': 'cancelled'})
    except Exception as e:  # shown to the user as it is
        send({'state': 'failed', 'error': str(e)})
    finally:
        _job = None
        shutil.rmtree(cwd, ignore_errors=True)


def export_clips(opts):
    """`look` is the same for every clip in a reel, so they can be joined without encoding again:
    { vertical, outH, fps, logo: { file, width, opacity, corner } | null }. A clip can have `holds`:
    [{ at, secs, drawing: png base64 }], frames to pause on with the user's drawing over them."""
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
