"""Notices about long jobs: what's running, what finished and what failed.

Every long job (Hockey AI runs, saving clips and review clips, Auto-Cut, YouTube uploads) gets one
notice. It says "running" with a percent while the job works, then "done", "failed" or "cancelled".
The list is kept in notices.json in the data folder, so a job that finished while the app was closed
(an overnight Hockey AI run) is still there to read the next time it opens. Every open screen hears
about each change on the "notices" channel and shows it in the bell, as a pop-up, and if the user
turned it on, as a notice on the computer's desktop."""
from __future__ import annotations

import os
import threading
import time
import uuid
from pathlib import Path

from . import events
from .config import DATA_DIR, read_json, write_json

FILE = 'notices.json'
KEEP = 60  # the newest this many are kept
FINISHED = ('done', 'failed', 'cancelled')

_lock = threading.RLock()
_items: list[dict] | None = None
_active: dict[str, str] = {}  # job kind -> the id of its running notice (one job of each kind at a time)
_last_sent: dict[str, float] = {}  # id -> when its progress was last sent, so a busy job doesn't flood the screens


def _path() -> Path:
    return DATA_DIR / FILE


def _now() -> int:
    return int(time.time() * 1000)


def _load() -> list[dict]:
    global _items
    if _items is None:
        try:
            data = read_json(_path(), [])
        except (OSError, ValueError):
            data = []
        _items = data if isinstance(data, list) else []
        # Clips, reels and uploads run inside the server, so one still "running" from before it last
        # stopped never finished. (Hockey AI runs are their own process; jobs.py settles those.)
        for n in _items:
            if n.get('state') == 'running' and n.get('kind') != 'ai':
                n.update(state='failed', unread=True, finishedAt=n.get('updatedAt') or _now(),
                         message='Pucked Video closed before this finished. Start it again.')
    return _items


def _save() -> None:
    try:
        write_json(_path(), _load()[:KEEP])
    except OSError:
        pass  # a full or read-only disk shouldn't stop the job itself


def _send(n: dict) -> None:
    _last_sent[n['id']] = time.monotonic()
    events.send('notices', n)


def _find(nid: str):
    return next((n for n in _load() if n['id'] == nid), None)


def begin(kind: str, title: str, detail: str = '', key: str | None = None, **extra) -> str:
    """A job started. `kind` is ai, clips, review, autocut or youtube; `key` names the job when
    something else (jobs.py) has to find its notice again after a restart."""
    with _lock:
        items = _load()
        nid = key or uuid.uuid4().hex[:12]
        old = _find(nid)
        if old:
            items.remove(old)
        n = {'id': nid, 'kind': kind, 'title': title, 'detail': detail, 'state': 'running', 'pct': None,
             'message': '', 'startedAt': _now(), 'updatedAt': _now(), 'unread': False, **extra}
        items.insert(0, n)
        del items[KEEP:]
        _active[kind] = nid
        _save()
        _send(n)
        return nid


def progress(kind: str, pct=None, message: str | None = None) -> None:
    """The running job of this kind moved on. Sent at most about once a second; not saved to disk."""
    with _lock:
        n = _find(_active.get(kind, ''))
        if not n or n['state'] != 'running':
            return
        if pct is not None:
            n['pct'] = max(0.0, min(100.0, float(pct)))
        if message is not None:
            n['message'] = message
        n['updatedAt'] = _now()
        if time.monotonic() - _last_sent.get(n['id'], 0) >= 1:
            _send(n)


def finish(kind: str, state: str, message: str = '', nid: str | None = None, **extra) -> None:
    """The job ended: state is done, failed or cancelled. `extra` can carry `file` (what it made)
    or `url` (where it went), which the screens offer to open."""
    with _lock:
        nid = nid or _active.get(kind)
        n = _find(nid or '')
        if _active.get(kind) == nid:
            _active.pop(kind, None)
        if not n or n['state'] in FINISHED:
            return
        n.update(state=state if state in FINISHED else 'failed', message=message or '', finishedAt=_now(),
                 updatedAt=_now(), unread=state != 'cancelled', **extra)
        if state == 'done':
            n['pct'] = 100.0
        _save()
        _send(n)


def from_progress(kind: str, st: dict, **done_extra) -> None:
    """Follow a job from the progress messages its module already sends to the screens:
    { state: running | scanning | saving | done | failed | cancelled, pct, error }."""
    state = st.get('state')
    if state in FINISHED:
        finish(kind, state, st.get('error') or '', **({k: v for k, v in done_extra.items() if v} if state == 'done' else {}))
    else:
        progress(kind, st.get('pct'))


# --- Hockey AI runs, which jobs.py follows through ai-job.json ------------------------------------

AI_TITLES = {'analyze': 'Hockey AI analysis', 'report': 'Post-game report', 'derive': 'Updating game numbers'}


def ai_job(job) -> None:
    """Keep the notice for a Hockey AI run in step with its status file. Called for every change,
    and when the server starts, so a run that ended while the app was closed still gets its notice."""
    if not job or not job.get('startedAt'):
        return
    nid = f"ai-{job['startedAt']}"
    with _lock:
        n = _find(nid)
        if not n:
            if job.get('state') != 'running' and job.get('finishedAt') and _now() - job['finishedAt'] > 86400 * 1000:
                return  # an old run from before notices existed
            begin('ai', AI_TITLES.get(job.get('kind'), 'Hockey AI'), Path(job.get('video') or '').name, key=nid,
                  video=job.get('video'))
            n = _find(nid)
            n['startedAt'] = job['startedAt']
        state = job.get('state')
        if state == 'running':
            steps = [s for s in job.get('steps') or [] if s.get('status') != 'skipped']
            on = next((s for s in steps if s.get('status') == 'running'), None)
            total = sum(s.get('weight', 1) for s in steps) or 1
            done = sum(s.get('weight', 1) * (100 if s.get('status') == 'done' else s.get('pct') or 0) / 100
                       for s in steps if s.get('status') in ('done', 'running'))
            _active['ai'] = nid
            progress('ai', done / total * 100, on.get('label') if on else None)
        elif state in FINISHED:
            made = {'file': job['out']} if state == 'done' and job.get('out') else {}
            finish('ai', state, job.get('error') or '', nid=nid, **made)


# --- What the screens call -------------------------------------------------------------------------

def list_notices():
    with _lock:
        return _load()[:KEEP]


def mark_read() -> bool:
    with _lock:
        changed = [n for n in _load() if n.get('unread')]
        for n in changed:
            n['unread'] = False
        if changed:
            _save()
        return True


def clear() -> bool:
    """Remove the finished ones; running jobs stay."""
    with _lock:
        _load()[:] = [n for n in _load() if n['state'] not in FINISHED]
        _save()
        events.send('notices:all', _load())
        return True


def dismiss(nid: str) -> bool:
    with _lock:
        n = _find(nid)
        if not n or n['state'] not in FINISHED:
            return False
        _load().remove(n)
        _save()
        events.send('notices:all', _load())
        return True


def _reset_for_tests() -> None:
    global _items
    with _lock:
        _items = None
        _active.clear()
        try:
            os.remove(_path())
        except OSError:
            pass
