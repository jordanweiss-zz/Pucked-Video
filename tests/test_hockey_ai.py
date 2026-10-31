"""Hockey_AI runs, with a stand-in Hockey_AI whose tools print the contract's PROGRESS lines."""
import json
import os
import sys
import time
from pathlib import Path

import pytest

from server import jobs

TOOL = r'''
import json, os, sys, time
args = sys.argv[1:]
def opt(name):
    return args[args.index(name) + 1] if name in args else None
slow = float(os.environ.get('FAKE_SLOW', '0'))
for p in (0, 50, 100):
    print(f'PROGRESS {p}', flush=True)
    time.sleep(slow)
print('some log line', flush=True)
if os.environ.get('FAKE_FAIL') == NAME:
    print('ERROR --lens is for 1920x1080 video, this video is 1280x720', flush=True)
    sys.exit(2)
def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, 'w').write(json.dumps(data))
if NAME == 'calibrate':
    write(opt('-o'), {'ok': True})
elif NAME == 'analyze':
    base = opt('-o')[:-4]
    write(base + '_report.json', {'summary': {'teams': ['A', 'B']}})
elif NAME == 'players':
    write(args[0] + '_players.json', {'players': []})
elif NAME == 'filter':
    write(args[0] + '_events_export.json', {'schema_version': 1, 'events': []})
elif NAME == 'report':
    open(args[0] + '_postgame.pdf', 'w').write('%PDF')
elif NAME == 'derive':
    assert args[1:] == ['--steps', 'all', '--if-stale'], args
    write(args[0] + '_shifts.json', SHIFTS)
    write(args[0] + '_manifest.json', {'schema_version': 1, 'can_derive': ['shifts'], 'needs_gpu': False,
                                       'outputs': {'shifts': {'stale': False, 'exists': True}}})
'''

SHIFTS = {
    'schema_version': 1, 'start_offset': 0,
    'teams': {'team_a': {'observed_s': 100, 'distance_ft': 5280, 'sprints': 3}, 'team_b': {'observed_s': 90, 'distance_ft': 2640, 'sprints': 1}},
    'players': {'A09': {'team': 'team_a', 'number': '9', 'shifts': [
        {'period': 1, 'start_s': 10, 'end_s': 50, 'duration_s': 40, 'distance_ft': 400, 'top_speed_mph': 15.5, 'avg_speed_mph': 7,
         'sprints': 1, 'zones_s': {'offensive': 30, 'neutral': 10}}]},
        'B-T8': {'team': 'team_b', 'number': None, 'shifts': []}},
}


@pytest.fixture
def hai(tmp_path):
    d = tmp_path / 'Hockey_AI'
    (d / 'config').mkdir(parents=True)
    (d / 'config' / 'events.json').write_text(json.dumps({'goal': {'on': True}}))
    (d / 'scripts').mkdir()
    for name, file in [('calibrate', 'scripts/calibrate_xbotgo.py'), ('analyze', 'main.py'), ('players', 'scripts/name_players.py'),
                       ('filter', 'scripts/filter_events.py'), ('report', 'scripts/game_report.py'),
                       ('derive', 'scripts/derive.py')]:
        (d / file).write_text(f'NAME = {name!r}\nSHIFTS = {SHIFTS!r}\n{TOOL}')
    (d / '.venv' / 'bin').mkdir(parents=True)
    os.symlink(sys.executable, d / '.venv' / 'bin' / 'python')
    return d


@pytest.fixture
def xgame(tmp_path):
    v = tmp_path / 'g' / 'game.mp4'
    (v.parent / '.data').mkdir(parents=True)
    v.write_bytes(b'not really a video')
    (v.parent / '.data' / 'game.track').write_text('UTC10:00:00.0 a Frame1 Yaw1\n')
    return v


@pytest.fixture(autouse=True)
def no_job_left(monkeypatch):
    yield
    if jobs.running():
        jobs.cancel()
    jobs.status_path().unlink(missing_ok=True)
    for k in ('FAKE_SLOW', 'FAKE_FAIL'):
        os.environ.pop(k, None)


def wait_until(check, secs=30):
    end = time.time() + secs
    while time.time() < end:
        job = jobs.read_status()
        if job and check(job):
            return job
        time.sleep(0.1)
    raise AssertionError(f'gave up waiting; job is {jobs.read_status()}')


def test_needs_setup_first(api, hai, xgame):
    assert api('ai:analyze', None, str(xgame), {})['error'].startswith('Choose your Hockey_AI folder')
    assert api('ai:analyze', str(hai), str(xgame), {})['error'] == 'Set up the rink first.'


def test_full_analysis_then_report(api, hai, xgame):
    api('ai:picks:save', str(xgame), [[0, [0, 0], [10, 10]]])
    api('settings:save', {'playSettings': {'goal': {'on': False}}})
    assert api('ai:analyze', str(hai), str(xgame), {}) == {'ok': True}
    job = wait_until(lambda j: j['state'] != 'running')
    assert job['state'] == 'done', job
    assert [s['status'] for s in job['steps']] == ['done'] * 4
    assert 'runnerPid' not in api('ai:job:get') and api('ai:job:get')['state'] == 'done'
    base = xgame.parent / 'game_analysis' / 'game'
    # The game gets the user's play settings, and Hockey_AI's own file is left alone.
    assert json.loads(Path(f'{base}_events.json').read_text()) == {'goal': {'on': False}}
    assert json.loads((hai / 'config' / 'events.json').read_text()) == {'goal': {'on': True}}

    st = api('ai:game', str(hai), str(xgame))
    assert st['analyzed'] and st['upToDate'] and st['hasExport'] and st['python']

    # A second run skips everything already done, except picking the plays.
    api('ai:analyze', str(hai), str(xgame), {})
    job = wait_until(lambda j: j['state'] != 'running')
    assert [s['status'] for s in job['steps']] == ['skipped', 'skipped', 'skipped', 'done']

    assert api('ai:report', str(hai), str(xgame), {'teamA': 'Wolves', 'players': ['p1', 'p2']}) == {'ok': True}
    job = wait_until(lambda j: j['state'] != 'running')
    assert job['state'] == 'done' and job['kind'] == 'report'
    assert Path(f'{base}_postgame.pdf').exists()
    assert api('ai:game', str(hai), str(xgame))['report'].endswith('_postgame.pdf')


def test_failure_is_explained(api, hai, xgame):
    os.environ['FAKE_FAIL'] = 'analyze'
    api('ai:picks:save', str(xgame), [])
    api('ai:analyze', str(hai), str(xgame), {})
    job = wait_until(lambda j: j['state'] != 'running')
    assert job['state'] == 'failed' and job['fixable']
    assert job['error'].startswith('Unsupported resolution') and '1280×720' in job['error']


def test_cancel_stops_the_run(api, hai, xgame):
    os.environ['FAKE_SLOW'] = '5'
    api('ai:picks:save', str(xgame), [])
    api('ai:analyze', str(hai), str(xgame), {})
    job = wait_until(lambda j: j.get('runnerPid') and j['steps'][0].get('status') == 'running')
    pid = job['runnerPid']
    assert api('ai:analyze', str(hai), str(xgame), {})['error'].startswith('Hockey AI is already working')
    assert api('ai:job:cancel') is True
    job = jobs.read_status()
    assert job['state'] == 'cancelled' and job['steps'][0]['status'] == 'cancelled'
    time.sleep(0.5)
    assert not jobs.pid_alive(pid)


def test_run_outlives_the_server_and_is_picked_up_again(api, hai, xgame):
    os.environ['FAKE_SLOW'] = '0.5'
    api('ai:picks:save', str(xgame), [])
    api('ai:analyze', str(hai), str(xgame), {})
    wait_until(lambda j: j.get('runnerPid'))
    # The runner isn't a child the server has to keep: it has its own session.
    pid = jobs.read_status()['runnerPid']
    assert os.getsid(pid) != os.getsid(0)
    # A "restarted" server only knows the status file, and still sees the job finish.
    job = wait_until(lambda j: j['state'] != 'running')
    assert job['state'] == 'done'


def test_a_runner_that_vanished_is_reported(api, hai, xgame):
    os.environ['FAKE_SLOW'] = '5'
    api('ai:picks:save', str(xgame), [])
    api('ai:analyze', str(hai), str(xgame), {})
    job = wait_until(lambda j: j.get('runnerPid') and j['steps'][0].get('status') == 'running')
    jobs._kill_tree(job['runnerPid'])  # as if the PC restarted
    # The server notices within a second, without being asked.
    job = wait_until(lambda j: j['state'] != 'running', secs=5)
    assert job['state'] == 'failed' and 'carry on where it stopped' in job['error']
    assert job['steps'][0]['status'] == 'failed'


def test_refilter_and_players(api, hai, xgame, tmp_path):
    base = str(tmp_path / 'run' / 'game')
    (tmp_path / 'run').mkdir()
    assert api('ai:refilter', str(hai), base, 0) == {'ok': True}
    assert Path(f'{base}_events_export.json').exists()
    run = api('ai:run:load', f'{base}_events_export.json')
    assert run['base'] == base and run['thumbBase'].startswith('/files/') and run['thumbBase'].endswith('/run/')
    api('ai:players:save', base, {'players': [{'id': 1}]})
    assert api('ai:run:load', f'{base}_events_export.json')['players'] == {'players': [{'id': 1}]}


def test_past_game_data_and_update_without_the_gpu(api, hai, xgame):
    base = xgame.parent / 'game_analysis' / 'game'
    assert api('ai:update', str(hai), str(xgame))['error'] == 'Analyze the game first.'
    base.parent.mkdir()
    Path(f'{base}_report.json').write_text(json.dumps({'summary': {'teams': {'team_a': 'Black', 'team_b': 'White'}}}))
    Path(f'{base}_events_export.json').write_text(json.dumps({'schema_version': 1, 'events': [
        {'time_s': 30, 'type': 'goal', 'team': 'team_a', 'window_start_s': 25},
        {'time_s': 40, 'type': 'zone_entry', 'team': 'team_b'}]}))
    Path(f'{base}_manifest.json').write_text(json.dumps({'schema_version': 1, 'can_derive': ['shifts', 'goals'], 'needs_gpu': False,
                                                         'outputs': {'shifts': {'stale': True}, 'goals': {'stale': False},
                                                                     'report': {'stale': True}}}))
    d = api('ai:data', str(xgame))
    assert d['analyzed'] and d['shifts'] is None and d['teams']['team_a'] == 'Black'
    assert [g['time_s'] for g in d['goals']] == [30]
    assert d['eventCounts'] == {'goal': {'team_a': 1}, 'zone_entry': {'team_b': 1}}
    # Only outputs Hockey AI can derive count as updatable.
    assert d['update'] == {'stale': ['shifts'], 'canUpdate': True, 'needsGpu': False}
    assert api('ai:game', str(hai), str(xgame))['update']['canUpdate']

    assert api('ai:update', str(hai), str(xgame)) == {'ok': True}
    job = wait_until(lambda j: j['state'] != 'running')
    assert job['state'] == 'done' and job['kind'] == 'derive', job
    d = api('ai:data', str(xgame))
    assert d['shifts']['players']['A09']['shifts'][0]['top_speed_mph'] == 15.5
    assert d['update']['canUpdate'] is False


def test_update_needs_a_new_enough_hockey_ai(api, hai, xgame):
    (hai / 'scripts' / 'derive.py').unlink()
    base = xgame.parent / 'game_analysis' / 'game'
    base.parent.mkdir()
    Path(f'{base}_report.json').write_text('{}')
    assert 'too old' in api('ai:update', str(hai), str(xgame))['error']


def test_game_setup_team_names_and_colours(api, hai, xgame):
    base = xgame.parent / 'game_analysis' / 'game'
    bad = api('ai:teams:save', str(hai), str(xgame), {'team_a': {'name': 'Hawks', 'color': 'pink'}, 'team_b': {'color': 'white'}})
    assert not bad['ok'] and 'colour' in bad['error']
    two = api('ai:teams:save', str(hai), str(xgame), {'team_a': {'color': 'red', 'home': True}, 'team_b': {'color': 'white', 'home': True}})
    assert not two['ok'] and 'home' in two['error']

    # Before analysis the setup is only saved, ready for Hockey AI to read.
    teams = {'team_a': {'name': ' Hawks ', 'color': 'red', 'home': True}, 'team_b': {'name': '', 'color': 'light_blue'}}
    assert api('ai:teams:save', str(hai), str(xgame), teams) == {'ok': True, 'updating': False}
    assert json.loads(Path(f'{base}_teams.json').read_text()) == {
        'schema_version': 1, 'team_a': {'name': 'Hawks', 'color': 'red', 'home': True}, 'team_b': {'name': 'Team B', 'color': 'light_blue'}}

    # After analysis, typed names win over Hockey AI's colours and a change re-labels the teams on the CPU.
    Path(f'{base}_report.json').write_text(json.dumps({'summary': {'teams': {'team_a': 'Black', 'team_b': 'White'}}}))
    Path(f'{base}_team_map.json').write_text(json.dumps({'ambiguous': True, 'swap': False}))
    d = api('ai:data', str(xgame))
    assert d['teams'] == {'team_a': 'Hawks', 'team_b': 'Team B'} and d['teamCheck'] == {'ambiguous': True, 'swap': False}
    assert api('ai:teams:save', str(hai), str(xgame), teams) == {'ok': True, 'updating': True}
    job = wait_until(lambda j: j['state'] != 'running')
    assert job['state'] == 'done' and job['kind'] == 'derive', job
