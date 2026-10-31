"""Notices: every long job says it's running, then done or failed, and the list survives a restart."""
import time

from server import clips, notices


def wait_for_clips():
    for _ in range(600):
        if clips._job is None:
            return
        time.sleep(0.1)
    raise AssertionError('clip export never finished')


def newest(api):
    return api('notices:list')[0]


def test_saving_a_clip_gives_a_done_notice(api, game, tmp_path):
    notices._reset_for_tests()
    out = tmp_path / 'clip.mp4'
    assert api('clips:export', {'video': str(game), 'clips': [{'start': 1, 'end': 2}], 'out': str(out), 'look': {}})['ok']
    assert newest(api)['state'] in ('running', 'done')
    wait_for_clips()
    n = newest(api)
    assert n['kind'] == 'clips' and n['state'] == 'done' and n['file'] == str(out) and n['unread']
    assert n['detail'] == 'clip.mp4' and n['pct'] == 100

    assert api('notices:read')
    assert not newest(api)['unread']


def test_a_failed_job_says_why(api, tmp_path):
    notices._reset_for_tests()
    out = tmp_path / 'clip.mp4'
    assert api('clips:export', {'video': str(tmp_path / 'missing.mp4'), 'clips': [{'start': 0, 'end': 1}], 'out': str(out), 'look': {}})['ok']
    wait_for_clips()
    n = newest(api)
    assert n['state'] == 'failed' and n['message'] and n['unread'] and 'file' not in n


def test_hockey_ai_runs_and_restarts(api):
    notices._reset_for_tests()
    job = {'kind': 'analyze', 'video': '/games/game.mp4', 'state': 'running', 'startedAt': int(time.time() * 1000),
           'steps': [{'label': 'Map the rink', 'weight': 1, 'status': 'done', 'pct': 100},
                     {'label': 'Find the plays', 'weight': 3, 'status': 'running', 'pct': 50}]}
    notices.ai_job(job)
    n = newest(api)
    assert n['state'] == 'running' and n['title'] == 'Hockey AI analysis' and n['detail'] == 'game.mp4'
    assert n['pct'] == 62.5 and n['message'] == 'Find the plays'

    job.update(state='failed', error='out of memory', finishedAt=int(time.time() * 1000))
    notices.ai_job(job)
    assert newest(api)['state'] == 'failed' and newest(api)['message'] == 'out of memory'
    notices.ai_job(job)  # the server sees the same file again: still one notice
    assert len(api('notices:list')) == 1

    # The server restarts: the list comes back from disk, and a clip left "running" never finished.
    notices.begin('clips', 'Saving a clip', 'x.mp4')
    notices._items = None
    notices._active.clear()
    states = {n['kind']: n['state'] for n in api('notices:list')}
    assert states == {'ai': 'failed', 'clips': 'failed'}

    # A run that finished while the app was closed still gets its notice.
    later = {**job, 'startedAt': job['startedAt'] + 1, 'state': 'done', 'out': '/games/report.pdf'}
    notices.ai_job(later)
    n = newest(api)
    assert n['state'] == 'done' and n['file'] == '/games/report.pdf' and n['unread']


def test_clear_and_dismiss_leave_running_jobs(api):
    notices._reset_for_tests()
    notices.begin('youtube', 'Uploading to YouTube', 'Game 1')
    notices.finish('youtube', 'done', url='https://youtu.be/abc')
    notices.begin('review', 'Saving a review clip', 'r.mp4')
    done = next(n for n in api('notices:list') if n['state'] == 'done')
    assert done['url'] == 'https://youtu.be/abc'
    assert api('notices:dismiss', done['id'])
    notices.begin('autocut', 'Auto-Cut', 'g.mp4')
    notices.finish('autocut', 'cancelled')
    assert not next(n for n in api('notices:list') if n['kind'] == 'autocut')['unread']
    assert api('notices:clear')
    assert [n['kind'] for n in api('notices:list')] == ['review']
