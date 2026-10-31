"""Hockey_AI from inside the app. Everything here follows Hockey_AI's docs/app_contract.md (v1):
the app finds the game's files, writes the rink picks and play settings, runs each tool with
Hockey_AI's own Python, and reads the "PROGRESS n" / "ERROR message" lines they print.

The long runs (Analyze game, the report) go through jobs.py, which starts them as their own
process so they keep going when the app or the server restarts."""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from . import core, jobs, library
from .config import NO_WINDOW, files_url, mtime_ms, read_json, write_json


def ai_events_file(hai) -> Path:
    """Hockey_AI's default play filters, in <Hockey_AI>/config/events.json. The app never writes to it."""
    return Path(hai) / 'config' / 'events.json'


def ai_python(hai):
    """Hockey_AI's own Python, from its virtual environment."""
    for v in ('.venv', 'venv'):
        for p in (Path(hai) / v / 'Scripts' / 'python.exe', Path(hai) / v / 'bin' / 'python'):
            if p.exists():
                return str(p)
    return None


def game_files(video: str) -> dict:
    """Every file Hockey_AI reads or writes for one game. XBotGo keeps its camera log in a hidden
    .data folder next to the video; Hockey_AI's output goes in <stem>_analysis next to it too."""
    p = Path(video)
    out = p.parent / f'{p.stem}_analysis'
    base = str(out / p.stem)
    return {
        'video': video, 'out': str(out), 'base': base,
        'track': str(p.parent / '.data' / f'{p.stem}.track'),
        'mark': str(p.parent / '.data' / f'{p.stem}.mark'),
        'picks': f'{base}_picks.json',
        'camera': f'{base}_camera.json',
        'calibCheck': f'{base}_calib_check',
        'events': f'{base}_events.json',
        'annotated': f'{base}.mp4',
        'report': f'{base}_report.json',
        'exportFile': f'{base}_events_export.json',
        'players': f'{base}_players.json',
        'pdf': f'{base}_postgame.pdf',
        'html': f'{base}_postgame.html',
        'checkpoint': f'{base}_checkpoint.json',  # left by a step that stopped partway, so it can resume
        'manifest': f'{base}_manifest.json',  # what's saved and what can be re-derived (contract v2, 8e)
        'shifts': f'{base}_shifts.json',  # per-team and per-player skating numbers (contract v2, 8d)
    }


def exists(f) -> bool:
    return Path(f).exists()


def _report_teams(file):
    data = read_json(file, None)
    return ((data or {}).get('summary') or {}).get('teams')


def load_ai_run(export_path: str):
    data = json.loads(Path(export_path).read_text(encoding='utf-8'))
    if data.get('schema_version') != 1 or not isinstance(data.get('events'), list):
        raise ValueError('That file is not a Hockey_AI events export.')
    base = re.sub(r'_events_export\.json$', '', export_path)
    return {
        'exportPath': export_path,
        'base': base,
        # Thumbnail paths in the players file are relative to the run's folder.
        'thumbBase': files_url(Path(export_path).parent) + '/',
        'data': data,
        'players': read_json(f'{base}_players.json', None),
        'presence': read_json(f'{base}_presence.json', None),  # when each tracked player was on screen
        'teams': _report_teams(f'{base}_report.json'),
    }


def play_settings(hai):
    """The user's play settings live in the app's own settings (Hockey AI settings screen). Hockey_AI's
    config/events.json is only the starting point."""
    try:
        mine = core.load_settings().get('playSettings')
        if mine:
            return mine
    except (ValueError, OSError):
        pass  # fall back to Hockey_AI's defaults
    return read_json(ai_events_file(hai), None)


def write_events(hai, file) -> None:
    """Each game gets its own copy of the user's play settings, so a run always says which settings it used."""
    write_json(file, play_settings(hai))


def calib_overlays(f):
    d = Path(f['calibCheck'])
    if not d.exists():
        return []
    jpgs = sorted(n.name for n in d.iterdir() if re.search(r'\.jpe?g$', n.name, re.I))
    # A few spread across the game is enough to see whether the lines sit on the rink.
    pick = jpgs if len(jpgs) <= 4 else [jpgs[round(i * (len(jpgs) - 1) / 3)] for i in range(4)]
    out = []
    for n in pick:
        file = d / n
        # ?t= so a re-run's pictures aren't cached
        out.append({'file': str(file), 'url': f'{files_url(file)}?t={int(mtime_ms(file))}'})
    return out


def checkpoint_of(f):
    """Where a step that crashed or was stopped will pick up again: { step, resumeFrom } or None."""
    try:
        c = read_json(f['checkpoint'], None)
    except (ValueError, OSError):
        return None
    if isinstance(c, dict) and c.get('schema_version') == 1 and isinstance(c.get('resume_from_s'), (int, float)):
        return {'step': c.get('step'), 'resumeFrom': c['resume_from_s']}
    return None


def game_status(hai, video):
    f = game_files(video)
    return {
        'files': f,
        'python': bool(ai_python(hai)) if hai else False,
        'hasTrack': exists(f['track']),
        'hasMark': exists(f['mark']),
        'picks': read_json(f['picks'], []),
        'calibrated': exists(f['camera']),
        'analyzed': exists(f['report']),
        # Nothing left to run unless the user changes the rink points.
        'upToDate': exists(f['report']) and exists(f['players']) and mtime_ms(f['picks']) <= mtime_ms(f['camera']),
        'hasExport': exists(f['exportFile']),
        'report': f['pdf'] if exists(f['pdf']) else f['html'] if exists(f['html']) else None,
        'teams': _report_teams(f['report']),
        'checkpoint': checkpoint_of(f),
        'overlays': calib_overlays(f),
        'hasData': exists(f['shifts']),
        'update': library.ai_update(_safe_json(f['manifest'])),
    }


def _safe_json(file):
    try:
        return read_json(file, None)
    except (ValueError, OSError):
        return None


def game_data(video):
    """Everything a past analyzed game has saved, for the Game data screen. Nothing is re-run."""
    f = game_files(video)
    export = _safe_json(f['exportFile']) or {}
    goals = [e for e in export.get('events') or [] if e.get('type') == 'goal']
    counts: dict = {}
    for e in export.get('events') or []:
        team = e.get('team') or 'unknown'
        counts.setdefault(e.get('type'), {}).setdefault(team, 0)
        counts[e.get('type')][team] += 1
    return {
        'analyzed': exists(f['report']),
        'teams': _report_teams(f['report']),
        'shifts': _safe_json(f['shifts']),
        'goals': goals,
        'eventCounts': counts,
        'players': _safe_json(f['players']),
        'update': library.ai_update(_safe_json(f['manifest'])),
    }


# --- The steps of a run --------------------------------------------------------------------------
# Steps run in order, and a step whose result is already on disk (and newer than its input) is skipped,
# so starting again after a cancel or a crash picks up where it left off. Skipping is decided when the
# step's turn comes, because an earlier step that re-ran makes the later ones out of date.
# Weights are hours of work per hour of video, for the progress bar and estimate.

def analyze_steps(f, start_offset=0, fresh=False, render=False):
    """Steps 1-4 of the contract. Re-running a step's same command resumes from its checkpoint;
    `fresh` throws that away and starts over."""
    off = str(start_offset)
    restart = ['--fresh'] if fresh else []
    return [
        {
            'id': 'calibrate', 'label': 'Map the rink', 'weight': 1,
            'skip': lambda: exists(f['camera']) and mtime_ms(f['picks']) <= mtime_ms(f['camera']),
            # After the user edits picks, only the rink placement is re-fitted, which takes seconds.
            'args': lambda: ['scripts/calibrate_xbotgo.py', '-i', f['video'], '--track', f['track'], '--start-offset', off,
                             '--picks', f['picks'], '--fit-rink-length', '--step', '5', '-o', f['camera'],
                             '--debug-dir', f['calibCheck'],
                             *(['--reuse', f['camera']] if exists(f['camera']) else []), *restart],
        },
        {
            'id': 'analyze', 'label': 'Find the plays (uses the graphics card)', 'weight': 4.5,
            'skip': lambda: exists(f['report']) and mtime_ms(f['report']) > mtime_ms(f['camera']),
            'args': lambda: ['main.py', '-i', f['video'], '-o', f['annotated'], '--gpu', '--xbotgo-track', f['track'],
                             '--start-offset', off, '--camera-calib', f['camera'], '--event-config', f['events'], *restart,
                             # The app draws its own overlays, so the annotated copy (about 12 GB per game hour) is optional.
                             *([] if render else ['--no-render'])],
        },
        {
            'id': 'players', 'label': 'Read jersey numbers', 'weight': 0.75,
            # Re-running it keeps every player the user already named, but there's no need after a resume.
            'skip': lambda: mtime_ms(f['players']) > mtime_ms(f['report']),
            'args': lambda: ['scripts/name_players.py', f['base'], '--video', f['video'], '--start-offset', off,
                             '--event-config', f['events']],
        },
        {
            'id': 'filter', 'label': 'Pick the plays to show', 'weight': 0.02,
            'args': lambda: ['scripts/filter_events.py', f['base'], '--start-offset', off, '--config', f['events'], '--write',
                             *(['--mark', f['mark']] if exists(f['mark']) else [])],
        },
    ]


def report_steps(f, opts):
    """Step 5: the printable post-game report."""
    args = ['scripts/game_report.py', f['base'], '--video', f['video'], '--start-offset', '0', '--camera-calib', f['camera'],
            '--event-config', f['events'], *(['--mark', f['mark']] if exists(f['mark']) else [])]
    if opts.get('teamA'):
        args += ['--team-a', opts['teamA']]
    if opts.get('teamB'):
        args += ['--team-b', opts['teamB']]
    if opts.get('title'):
        args += ['--title', opts['title']]
    if opts.get('focusTeam'):
        args += ['--focus-team', opts['focusTeam']]
    if opts.get('players'):
        args += ['--players', ','.join(opts['players'])]
    return [{'id': 'report', 'label': 'Make the post-game report', 'weight': 1, 'args': lambda: args}]


def derive_steps(f):
    """Bring a past game's results up to date from what the first pass saved: CPU only, no new analysis."""
    return [{'id': 'derive', 'label': 'Update the numbers from the saved analysis', 'weight': 0.05,
             'args': lambda: ['scripts/derive.py', f['base'], '--steps', 'all', '--if-stale']}]


def steps_for(spec):
    """The steps of a job from its saved description; the job runner calls this in its own process."""
    f = game_files(spec['video'])
    if spec['kind'] == 'derive':
        return derive_steps(f)
    if spec['kind'] == 'analyze':
        return analyze_steps(f, 0, spec['opts'].get('fresh', False), spec['opts'].get('render', False))
    return report_steps(f, spec['opts'])


def friendly_error(msg):
    """Hockey_AI's ERROR lines are shown as they are, except ones with a plainer way to say them."""
    m = re.search(r'--lens is for 1920x1080 video, this video is (\d+x\d+)', msg or '')
    if m:
        return ('Unsupported resolution: Hockey AI only works on 1920×1080 XBotGo video for now, and this video is '
                f"{m.group(1).replace('x', '×')}.")
    return msg


# --- What the screens call ----------------------------------------------------------------------

def check_ready(hai):
    if not hai:
        return 'Choose your Hockey_AI folder in Hockey AI settings first.'
    if not ai_python(hai):
        return 'That Hockey_AI folder has no Python set up (.venv is missing).'
    if not ai_events_file(hai).exists():
        return 'That folder has no config/events.json. Is it the Hockey_AI folder?'
    if jobs.running():
        return 'Hockey AI is already working on a game. Wait for it to finish or cancel it.'
    return None


def load_events(hai):
    """Hockey_AI's default play settings, to start from before the user has saved their own."""
    return read_json(ai_events_file(hai), None) if hai else None


def save_players(base, data):
    """The user's fixes to the run's players are saved with source "user", which later runs never overwrite."""
    write_json(f'{base}_players.json', data)
    return True


def refilter(hai, base, start_offset=0):
    """Re-pick a saved run's plays with the current settings and player names. CPU only and takes seconds."""
    py = ai_python(hai) if hai else None
    if not py:
        return {'ok': False, 'error': 'Choose your Hockey_AI folder in Hockey AI settings first.'}
    events = f'{base}_events.json'
    write_events(hai, events)
    args = [py, '-u', 'scripts/filter_events.py', base, '--start-offset', str(start_offset or 0), '--config', events, '--write']
    out = subprocess.run(args, cwd=hai, capture_output=True, text=True, errors='replace', creationflags=NO_WINDOW)
    if out.returncode == 0:
        return {'ok': True}
    line = next((l for l in out.stdout.split('\n') if l.startswith('ERROR ')), None)
    lines = [l for l in (out.stderr or f'exit code {out.returncode}').strip().split('\n') if l.strip()]
    return {'ok': False, 'error': line[6:] if line else (lines[-1] if lines else f'exit code {out.returncode}')}


def save_picks(video, picks):
    """Rink landmarks the user clicked: [frame, [ice_x_ft, ice_y_ft], [px, py]] per contract section 5."""
    f = game_files(video)
    write_json(f['picks'], picks)
    return True


def analyze(hai, video, opts=None):
    opts = opts or {}
    f = game_files(video)
    problem = (check_ready(hai)
               or (None if exists(f['track']) else
                   f"There's no XBotGo camera log next to this video (.data\\{Path(f['track']).name}).")
               or (None if exists(f['picks']) or exists(f['camera']) else 'Set up the rink first.'))
    if problem:
        return {'ok': False, 'error': problem}
    write_events(hai, f['events'])
    if opts.get('fresh'):
        Path(f['checkpoint']).unlink(missing_ok=True)
    jobs.start(hai, 'analyze', video, {'fresh': bool(opts.get('fresh')), 'render': bool(opts.get('render'))})
    return {'ok': True}


def report(hai, video, opts=None):
    opts = opts or {}
    f = game_files(video)
    problem = check_ready(hai) or (None if exists(f['report']) else 'Analyze the game first.')
    if problem:
        return {'ok': False, 'error': problem}
    write_events(hai, f['events'])
    jobs.start(hai, 'report', video, opts)
    return {'ok': True}


def update(hai, video):
    """Re-derive a past game's numbers with the current Hockey AI and play settings, without the graphics card."""
    f = game_files(video)
    problem = (check_ready(hai)
               or (None if exists(f['report']) else 'Analyze the game first.')
               or (None if (Path(hai) / 'scripts' / 'derive.py').exists() else
                   'This Hockey AI is too old to update past games. Get the latest Hockey AI, then try again.'))
    if problem:
        return {'ok': False, 'error': problem}
    write_events(hai, f['events'])
    jobs.start(hai, 'derive', video, {})
    return {'ok': True}


def finished_output(spec):
    """The file to open when a job is done: the report, once it's made."""
    if spec['kind'] != 'report':
        return None
    f = game_files(spec['video'])
    out = f['pdf'] if exists(f['pdf']) else f['html']
    return out if exists(out) else None
