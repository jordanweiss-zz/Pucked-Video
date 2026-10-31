"""Long Hockey_AI runs as their own process, so they keep going when the app or the server restarts.

The server writes the job's description to ai-job.json in the data folder and starts jobrun.py,
which runs the steps and keeps that file up to date. The server only reads the file and passes
changes on to the screens, so after a restart it simply picks the job up again from the file.
One job at a time: Hockey_AI's analysis uses the GPU, and two DirectML jobs at once can hang it."""
from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from . import events
from .config import APP_DIR, DATA_DIR

STATUS_FILE = 'ai-job.json'
_cancel_requested = False


def status_path() -> Path:
    return DATA_DIR / STATUS_FILE


def read_status():
    try:
        return json.loads(status_path().read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def write_status(job) -> None:
    """Replace the status file in one go, so a reader never sees half of it."""
    path = status_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f'{STATUS_FILE}.{os.getpid()}.tmp')
    tmp.write_text(json.dumps(job), encoding='utf-8')
    for attempt in range(20):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:  # Windows: the server is reading it right now
            time.sleep(0.05)
    os.replace(tmp, path)


def pid_alive(pid) -> bool:
    if not pid:
        return False
    if sys.platform == 'win32':
        import ctypes
        k = ctypes.windll.kernel32
        h = k.OpenProcess(0x1000, False, int(pid))  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong()
        ok = k.GetExitCodeProcess(h, ctypes.byref(code))
        k.CloseHandle(h)
        return bool(ok) and code.value == 259  # STILL_ACTIVE
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # A finished child of this process stays a zombie until it's reaped.
    try:
        done, _ = os.waitpid(int(pid), os.WNOHANG)
        return done == 0
    except ChildProcessError:
        return True


def view(job):
    """The job as the screens see it."""
    if not job:
        return None
    return {k: v for k, v in job.items() if k not in ('spec', 'runnerPid')}


def running() -> bool:
    job = read_status()
    if not job or job.get('state') != 'running':
        return False
    if not job.get('runnerPid'):  # just started; the runner hasn't written its pid yet
        return time.time() * 1000 - job.get('startedAt', 0) < 30000
    return pid_alive(job['runnerPid'])


def current():
    return view(read_status())


def start(hai, kind, video, opts) -> None:
    global _cancel_requested
    from .hockey_ai import steps_for
    spec = {'hai': hai, 'kind': kind, 'video': video, 'opts': opts}
    steps = [{k: v for k, v in s.items() if k not in ('skip', 'args')} for s in steps_for(spec)]
    now = int(time.time() * 1000)
    job = {'kind': kind, 'video': video, 'steps': steps, 'state': 'running', 'startedAt': now, 'log': [],
           'error': None, 'spec': spec, 'runnerPid': None}
    write_status(job)
    _cancel_requested = False
    env = {**os.environ, 'PUCKED_DATA_DIR': str(DATA_DIR), 'PUCKED_APP_DIR': str(APP_DIR)}
    cmd = [sys.executable, '-m', 'server.jobrun']
    kw = dict(cwd=str(APP_DIR), env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
              stderr=subprocess.DEVNULL, close_fds=True)
    if sys.platform == 'win32':
        flags = 0x00000200 | 0x08000000  # CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        try:
            # Out of the app's job object too, so closing the app can't take the run down with it.
            proc = subprocess.Popen(cmd, creationflags=flags | 0x01000000, **kw)  # CREATE_BREAKAWAY_FROM_JOB
        except OSError:
            proc = subprocess.Popen(cmd, creationflags=flags, **kw)
    else:
        proc = subprocess.Popen(cmd, start_new_session=True, **kw)
    # The runner writes its own pid when it starts; this covers the moment before it does.
    latest = read_status() or job
    if latest.get('startedAt') == now and not latest.get('runnerPid'):
        latest['runnerPid'] = proc.pid
        write_status(latest)
    events.send('ai:job', view(latest))


def _kill_tree(pid) -> None:
    # Hockey_AI can start helper processes, so stop the whole tree.
    if sys.platform == 'win32':
        subprocess.run(['taskkill', '/pid', str(pid), '/T', '/F'], capture_output=True, creationflags=0x08000000)
    else:
        try:
            os.killpg(os.getpgid(int(pid)), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass


def _end(job, state, error=None) -> None:
    for s in job['steps']:
        if s.get('status') == 'running':
            s['status'] = 'cancelled' if state == 'cancelled' else 'failed'
    job['state'] = state
    if error:
        job['error'] = error
    job['finishedAt'] = int(time.time() * 1000)


def cancel() -> bool:
    global _cancel_requested
    job = read_status()
    if not job or job.get('state') != 'running':
        return False
    _cancel_requested = True
    if job.get('runnerPid'):
        _kill_tree(job['runnerPid'])
    _end(job, 'cancelled')
    write_status(job)
    events.send('ai:job', view(job))
    return True


def check_stopped(job):
    """A runner that disappeared without saying it finished (killed, PC restarted) leaves 'running' behind."""
    if job and job.get('state') == 'running' and job.get('runnerPid') and not pid_alive(job['runnerPid']):
        if _cancel_requested:
            _end(job, 'cancelled')
        else:
            _end(job, 'failed', 'Hockey AI stopped before it finished. Start it again to carry on where it stopped.')
        write_status(job)
        return True
    return False


async def watch() -> None:
    """Pass every change in the status file on to the screens."""
    last = None
    while True:
        try:
            st = status_path().stat()
            stamp = (st.st_mtime_ns, st.st_size)
        except OSError:
            stamp = None
        job = read_status() if stamp else None
        if job and check_stopped(job):
            stamp = None
        if stamp != last and job:
            events.send('ai:job', view(job))
        last = stamp
        await asyncio.sleep(0.5)
