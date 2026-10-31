import json
import shutil


def test_library_finds_games_and_skips_saved_clips(api, game, tmp_path):
    root = tmp_path / 'Videos'
    (root / '2026' / '.data').mkdir(parents=True)
    g = root / '2026' / 'VID_20261025_181500_01.mp4'
    shutil.copy(game, g)
    (root / '2026' / '.data' / 'VID_20261025_181500_01.vdata').write_text(json.dumps({'duration': 3600}))
    shutil.copy(game, root / '2026' / 'VID_20261025_181500_01 - condensed.mp4')
    shutil.copy(game, root / 'random clip.mp4')  # small, no tags, no XBotGo data: not a game
    tagged = root / 'tagged.mp4'
    shutil.copy(game, tagged)
    api('tags:save', str(tagged), {'title': 'Bulldogs vs Flyers', 'tags': [{'label': 'Goal'}, {'label': 'Shot', 'status': 'suggested'}]})
    an = root / '2026' / 'VID_20261025_181500_01_analysis'
    an.mkdir()
    (an / 'VID_20261025_181500_01_report.json').write_text('{}')
    (an / 'VID_20261025_181500_01_manifest.json').write_text(json.dumps(
        {'schema_version': 1, 'can_derive': ['shifts'], 'outputs': {'shifts': {'stale': True}}, 'needs_gpu': False}))

    games = api('library:scan', [str(root)])
    names = [x['name'] for x in games]
    assert 'VID_20261025_181500_01' in names and 'tagged' in names
    assert not any('condensed' in n or 'random' in n for n in names)
    xb = next(x for x in games if x['xbotgo'])
    assert xb['date'] == '2026-10-25T18:15:00' and xb['duration'] == 3600
    assert xb['analyzed'] and xb['ai']['canUpdate']
    t = next(x for x in games if x['name'] == 'tagged')
    assert t['title'] == 'Bulldogs vs Flyers' and t['tags'] == 1 and t['toReview'] == 1


def test_thumbnail(api, client, game):
    url = api('library:thumb', str(game))
    assert url and client.get(url).status_code == 200
    assert api('library:thumb', str(game)) == url  # made once, then reused


def test_progress_of_a_run_outside_the_app(api, tmp_path):
    import os
    import time
    from datetime import datetime, timezone
    v = tmp_path / 'game.mp4'
    v.write_bytes(b'x' * 10)
    api('tags:save', str(v), {'tags': []})
    an = tmp_path / 'game_analysis'
    an.mkdir()
    prog = an / 'game_progress.json'
    now = datetime.now(timezone.utc).isoformat()

    def write(**kw):
        prog.write_text(json.dumps({'schema_version': 1, 'step': 'analyze', 'state': 'running', 'percent': 42.5, 'fps': 7.1,
                                    'eta_s': 3600, 'message': '', 'pid': os.getpid(), 'started_at': now, 'updated_at': now, **kw}))

    def progress():
        return next(g for g in api('library:scan', [str(tmp_path)]) if g['name'] == 'game')['progress']

    assert progress() is None
    write()
    p = progress()
    assert p['state'] == 'running' and p['percent'] == 42.5 and p['etaS'] == 3600 and not p['ours']
    assert api('ai:game', None, str(v))['aiProgress']['state'] == 'running'
    # Not heard from for over a minute, or its process is gone: it stopped.
    write(updated_at=time.time() - 120)
    assert progress()['state'] == 'stopped'
    write(pid=None)
    assert progress()['state'] == 'stopped'
    write(state='failed', message='out of memory')
    assert progress()['state'] == 'failed' and progress()['message'] == 'out of memory'
    write(schema_version=2)
    assert progress() is None
