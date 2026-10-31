"""Runs one Hockey_AI job on its own, apart from the server: python -m server.jobrun.

It reads the job from ai-job.json, runs each step with Hockey_AI's Python and writes progress
back to the same file. Started detached, so closing or updating the app doesn't stop it."""
from __future__ import annotations

import re
import subprocess
import sys
import threading
import time

from . import jobs
from .config import NO_WINDOW


def now_ms() -> int:
    return int(time.time() * 1000)


def keep_awake() -> None:
    """An overnight run shouldn't stop when the computer goes to sleep."""
    if sys.platform == 'win32':
        import ctypes
        ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | 0x00000001)  # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    elif sys.platform == 'darwin':
        import os
        subprocess.Popen(['caffeinate', '-i', '-w', str(os.getpid())])


def open_file(path) -> None:
    import os
    if os.environ.get('PUCKED_NO_OPEN'):
        return
    if sys.platform == 'win32':
        os.startfile(path)  # noqa: S606 - opens the user's own report
    else:
        subprocess.Popen(['open' if sys.platform == 'darwin' else 'xdg-open', path])


class Runner:
    def __init__(self, job):
        self.job = job
        self.lock = threading.Lock()
        self.last_write = 0.0

    def save(self, force=False) -> None:
        # Progress lines can come many times a second; the file only needs a few updates a second.
        if not force and time.time() - self.last_write < 0.4:
            return
        with self.lock:
            # A cancel from the server ends the job; never write over it.
            on_disk = jobs.read_status()
            if on_disk and on_disk.get('state') == 'cancelled' and on_disk.get('startedAt') == self.job['startedAt']:
                sys.exit(130)
            jobs.write_status(self.job)
            self.last_write = time.time()

    def log(self, line: str) -> None:
        self.job['log'].append(line)
        del self.job['log'][:-300]

    def run_tool(self, hai, py, step, args) -> int:
        proc = subprocess.Popen([py, '-u', *args], cwd=hai, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                creationflags=NO_WINDOW)
        step['startedAt'] = now_ms()

        def read_err():
            for raw in proc.stderr:
                self.log(raw.decode('utf-8', 'replace').rstrip('\r\n'))

        t = threading.Thread(target=read_err, daemon=True)
        t.start()
        for raw in proc.stdout:
            line = raw.decode('utf-8', 'replace').rstrip('\r\n')
            p = re.match(r'^PROGRESS\s+([\d.]+)', line)
            if p:
                step['pct'] = min(100.0, float(p.group(1)))
                self.save()
                continue
            r = re.match(r'^RESUMING\s+([\d.]+)', line)
            if r:
                step['resumedFrom'] = float(r.group(1))
            e = re.match(r'^ERROR\s+(.*)', line)
            if e:
                step['error'] = e.group(1)
            self.log(line)
        code = proc.wait()
        t.join(timeout=5)
        return code

    def run(self) -> None:
        from .hockey_ai import ai_python, finished_output, friendly_error, steps_for
        job = self.job
        spec = job['spec']
        hai = spec['hai']
        py = ai_python(hai)
        defs = steps_for(spec)
        for step, d in zip(job['steps'], defs):
            if d.get('skip') and d['skip']():
                step['status'] = 'skipped'
                self.save(True)
                continue
            step['status'] = 'running'
            step['pct'] = 0
            self.save(True)
            try:
                code = self.run_tool(hai, py, step, d['args']())
            except OSError as e:
                step['error'] = f"Couldn't start Hockey_AI's Python: {e}"
                code = 1
            if code == 130:
                step['status'] = 'cancelled'
                job['state'] = 'cancelled'
                break
            if code != 0:
                step['status'] = 'failed'
                job['state'] = 'failed'
                job['error'] = friendly_error(step.get('error')) or f"{step['label']} stopped unexpectedly (exit code {code})."
                job['fixable'] = code == 2
                break
            step['status'] = 'done'
            step['pct'] = 100
            self.save(True)
        out = None
        if job['state'] == 'running':
            job['state'] = 'done'
            out = finished_output(spec)
            job['out'] = out  # what the run made, for its notice
        job['finishedAt'] = now_ms()
        self.save(True)
        if out:
            open_file(out)


def main() -> None:
    import os
    job = jobs.read_status()
    if not job or job.get('state') != 'running':
        return
    job['runnerPid'] = os.getpid()
    runner = Runner(job)
    runner.save(True)
    keep_awake()
    try:
        runner.run()
    except SystemExit:
        raise
    except Exception as e:  # anything unexpected still ends the job cleanly for the screens
        job['state'] = 'failed'
        job['error'] = f'Hockey AI stopped: {e}'
        job['finishedAt'] = now_ms()
        jobs.write_status(job)


if __name__ == '__main__':
    main()
