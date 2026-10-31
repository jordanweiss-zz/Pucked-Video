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
