"""Running ffmpeg: one job at a time per kind, with progress and cancel."""
from __future__ import annotations

import re
import subprocess
import threading

from .config import FFMPEG, NO_WINDOW


class Cancelled(Exception):
    pass


class Job:
    """A cancellable run of one or more ffmpeg commands."""

    def __init__(self):
        self.proc: subprocess.Popen | None = None
        self.cancelled = False

    def cancel(self) -> None:
        self.cancelled = True
        if self.proc and self.proc.poll() is None:
            self.proc.kill()


def last_line(text: str, fallback: str) -> str:
    lines = [l for l in text.strip().split('\n') if l.strip()]
    return lines[-1] if lines else fallback


def run(args, cwd=None, timeout=None):
    """Run ffmpeg to the end. Returns (ok, last stderr line)."""
    try:
        out = subprocess.run([FFMPEG, *args], cwd=cwd, capture_output=True, text=True, errors='replace',
                             timeout=timeout, creationflags=NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, str(e)
    return out.returncode == 0, last_line(out.stderr, f'ffmpeg stopped (exit code {out.returncode})')


def run_with_progress(job: Job, args, cwd, on_seconds) -> None:
    """Run ffmpeg with -progress pipe:1, calling on_seconds(seconds written so far). Raises on failure."""
    proc = subprocess.Popen([FFMPEG, *args], cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            creationflags=NO_WINDOW)
    job.proc = proc
    err = []

    def read_err():
        for line in proc.stderr:
            err.append(line.decode('utf-8', 'replace'))
            del err[:-60]

    t = threading.Thread(target=read_err, daemon=True)
    t.start()
    for raw in proc.stdout:
        m = re.match(rb'out_time_us=(\d+)', raw)
        if m:
            on_seconds(int(m.group(1)) / 1e6)
    code = proc.wait()
    t.join(timeout=5)
    job.proc = None
    if job.cancelled:
        raise Cancelled()
    if code != 0:
        raise RuntimeError(last_line(''.join(err), f'ffmpeg stopped (exit code {code})'))
