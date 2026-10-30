from conftest import DATA


def test_only_this_computer_and_only_the_app(client):
    assert client.get('/api/health').status_code == 200
    assert client.get('/api/health', headers={'host': 'evil.example:8765'}).status_code == 403
    # Without the app's header, another website's form post is refused.
    assert client.post('/api/settings:load', json={'args': []}).status_code == 403
    assert client.post('/api/nope', json={'args': []}, headers={'X-Pucked': '1'}).status_code == 404


def test_screens_are_served(client):
    page = client.get('/')
    assert page.status_code == 200 and 'api.js' in page.text
    assert client.get('/api.js').status_code == 200


def test_sports(api):
    ids = {s['id'] for s in api('sports:list')}
    assert {'hockey', 'soccer'} <= ids


def test_tags_next_to_the_video_and_youtube_in_data(api, game):
    assert api('tags:load', str(game)) is None
    api('tags:save', str(game), {'tags': [{'label': 'Goal', 'time': 3}]})
    assert game.with_name('game.mp4.tags.json').exists()
    assert api('tags:load', str(game)) == {'tags': [{'label': 'Goal', 'time': 3}]}
    api('tags:save', 'youtube:dQw4w9WgXcQ', {'tags': []})
    assert (DATA / 'youtube' / 'dQw4w9WgXcQ.tags.json').exists()


def test_settings_and_teams(api):
    assert api('teams:load') == {'teams': []}
    api('teams:save', {'teams': [{'name': 'Wolves'}]})
    assert api('teams:load')['teams'][0]['name'] == 'Wolves'
    api('settings:save', {'aiRender': True})
    assert api('settings:load') == {'aiRender': True}
    assert (DATA / 'settings.json').exists()


def test_xbotgo_marks(api, game):
    assert api('xbotgo:marks', str(game)) == [2.5, 4]
    assert api('xbotgo:marks', str(game.with_name('other.mp4'))) == []


def test_video_streams_with_ranges(api, client, game):
    info = api('video:info', str(game))
    assert info['size'] == game.stat().st_size
    assert api('video:info', str(game.with_name('missing.mp4'))) is None
    whole = client.get(info['url'])
    assert whole.status_code == 200 and len(whole.content) == info['size']
    part = client.get(info['url'], headers={'Range': 'bytes=100-199'})
    assert part.status_code == 206
    assert part.headers['content-range'] == f"bytes 100-199/{info['size']}"
    assert part.content == whole.content[100:200]


def test_ffmpeg_check(api):
    assert api('ffmpeg:check')['ok']


def test_ai_dir_check(api, tmp_path):
    hai = tmp_path / 'Hockey_AI'
    (hai / 'config').mkdir(parents=True)
    (hai / 'config' / 'events.json').write_text('{}')
    (hai / 'main.py').write_text('')
    assert api('ai:dir:check', str(hai)) == str(hai)
    assert api('ai:dir:check', str(tmp_path)) == str(hai)  # picked the folder one level up
    assert api('ai:dir:check', str(tmp_path / 'nothing')) is None
