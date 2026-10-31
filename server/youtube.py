"""Uploading videos to the user's own YouTube channel.

Google needs each copy of the app to sign in with its own "Desktop app" client from Google Cloud
(free). The user picks the file Google gives them in the app; the client and the sign-in are kept in
youtube.json in the app's data folder, never in the app's own folder. Sign-in uses Google's loopback
flow: Google sends the browser back to this server at /api/youtube/callback."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from . import events
from .config import DATA_DIR, read_json, write_json

AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
TOKEN_URL = 'https://oauth2.googleapis.com/token'
UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status'
SCOPE = 'https://www.googleapis.com/auth/youtube.upload'
CHUNK = 8 * 1024 * 1024
PRIVACY = ('private', 'unlisted', 'public')

_pending: dict[str, dict] = {}  # sign-ins waiting for Google to send the browser back, by state
_access: dict = {}  # {'token', 'expires'}
_upload: dict | None = None  # {'cancelled': bool}


def store_file() -> Path:
    return DATA_DIR / 'youtube.json'


def _store() -> dict:
    return read_json(store_file(), {}) or {}


def _save(data) -> None:
    write_json(store_file(), data)
    try:
        os.chmod(store_file(), 0o600)  # holds the sign-in, so only this user may read it
    except OSError:
        pass


def status():
    s = _store()
    return {'configured': bool(s.get('client_id') and s.get('client_secret')), 'connected': bool(s.get('refresh_token')),
            'clientId': s.get('client_id', ''), 'uploading': _upload is not None}


def setup(opts):
    """Save the Desktop app client: either { file } (the JSON Google lets you download) or { clientId, clientSecret }."""
    if opts.get('file'):
        try:
            raw = json.loads(Path(opts['file']).read_text(encoding='utf-8'))
        except (OSError, ValueError) as e:
            raise RuntimeError(f"Couldn't read that file: {e}") from e
        client = raw.get('installed') or raw.get('web') or raw
        if 'web' in raw:
            raise RuntimeError('That is a "Web application" client. Make a "Desktop app" client instead (step 4).')
        cid, secret = client.get('client_id'), client.get('client_secret')
    else:
        cid, secret = (opts.get('clientId') or '').strip(), (opts.get('clientSecret') or '').strip()
    if not cid or not secret or not cid.endswith('.apps.googleusercontent.com'):
        raise RuntimeError("That doesn't look like a Google client. The ID ends in .apps.googleusercontent.com.")
    s = _store()
    if s.get('client_id') != cid:
        s.pop('refresh_token', None)  # a sign-in belongs to the client it was made with
    s.update(client_id=cid, client_secret=secret)
    _save(s)
    _access.clear()
    return status()


def disconnect():
    s = _store()
    s.pop('refresh_token', None)
    _save(s)
    _access.clear()
    return status()


def redirect_uri(origin: str) -> str:
    # Google allows any port on the loopback address for Desktop app clients, but only by IP address,
    # and the server only answers 127.0.0.1 or localhost.
    parts = urllib.parse.urlsplit(origin)
    return f'http://127.0.0.1:{parts.port or 80}/api/youtube/callback'


def connect(origin: str):
    """The Google sign-in page to open in the user's browser."""
    s = _store()
    if not s.get('client_id'):
        raise RuntimeError('Set up YouTube first.')
    state = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    uri = redirect_uri(origin)
    _pending.clear()  # only the newest sign-in counts
    _pending[state] = {'verifier': verifier, 'redirect_uri': uri, 'at': time.time()}
    q = {'client_id': s['client_id'], 'redirect_uri': uri, 'response_type': 'code', 'scope': SCOPE,
         'access_type': 'offline', 'prompt': 'consent', 'state': state,
         'code_challenge': challenge, 'code_challenge_method': 'S256'}
    return {'url': f'{AUTH_URL}?{urllib.parse.urlencode(q)}'}


def _post_form(url, fields):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(fields).encode(), method='POST',
                                 headers={'Content-Type': 'application/x-www-form-urlencoded'})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', 'replace')
        try:
            err = json.loads(body)
        except ValueError:
            err = {'error': body[:200]}
        raise GoogleError(err.get('error', ''), err.get('error_description') or err.get('error') or str(e)) from e


class GoogleError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def finish_sign_in(state, code, error):
    """Called when Google sends the browser back. Returns (ok, message for the page)."""
    pending = _pending.pop(state or '', None)
    if error:
        return False, 'YouTube was not connected: you said no, or Google stopped the sign-in.' if error == 'access_denied' else f'Google said: {error}'
    if not pending or time.time() - pending['at'] > 900:
        return False, 'That sign-in link has expired. Press Connect YouTube in Pucked Video again.'
    s = _store()
    try:
        tok = _post_form(TOKEN_URL, {'code': code, 'client_id': s['client_id'], 'client_secret': s['client_secret'],
                                     'redirect_uri': pending['redirect_uri'], 'grant_type': 'authorization_code',
                                     'code_verifier': pending['verifier']})
    except (GoogleError, OSError) as e:
        return False, f"Couldn't finish connecting YouTube: {e}"
    if not tok.get('refresh_token'):
        return False, 'Google did not give Pucked Video a lasting sign-in. Press Connect YouTube again.'
    s['refresh_token'] = tok['refresh_token']
    _save(s)
    _access.update(token=tok['access_token'], expires=time.time() + int(tok.get('expires_in', 3600)) - 60)
    events.send('youtube:status', status())
    return True, 'YouTube is connected. You can close this tab and go back to Pucked Video.'


def access_token() -> str:
    if _access.get('token') and _access['expires'] > time.time():
        return _access['token']
    s = _store()
    if not s.get('refresh_token'):
        raise RuntimeError('Connect YouTube first.')
    try:
        tok = _post_form(TOKEN_URL, {'client_id': s['client_id'], 'client_secret': s['client_secret'],
                                     'refresh_token': s['refresh_token'], 'grant_type': 'refresh_token'})
    except GoogleError as e:
        if e.code == 'invalid_grant':
            # Revoked, or a "Testing" Google project, whose sign-ins only last 7 days.
            disconnect()
            events.send('youtube:status', status())
            raise RuntimeError('The YouTube sign-in ran out. Press Connect YouTube again.') from e
        raise
    _access.update(token=tok['access_token'], expires=time.time() + int(tok.get('expires_in', 3600)) - 60)
    return _access['token']


def send(state) -> None:
    events.send('youtube:progress', state)


def _request(url, method, headers, data=None):
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        res = urllib.request.urlopen(req, timeout=120)
        return res.status, dict(res.headers), res.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def _google_message(body: bytes, fallback: str) -> str:
    try:
        err = json.loads(body).get('error', {})
        reason = (err.get('errors') or [{}])[0].get('reason', '')
        if reason in ('quotaExceeded', 'uploadLimitExceeded'):
            return 'YouTube says this channel has uploaded as much as it can today. Try again tomorrow.'
        if reason == 'youtubeSignupRequired':
            return 'This Google account has no YouTube channel yet. Make one on youtube.com, then try again.'
        return err.get('message') or fallback
    except (ValueError, AttributeError):
        return fallback


def _upload_file(job, file, title, description, privacy) -> None:
    global _upload
    try:
        size = Path(file).stat().st_size
        meta = {'snippet': {'title': title[:100] or 'Review clip', 'description': description[:5000], 'categoryId': '17'},
                'status': {'privacyStatus': privacy, 'selfDeclaredMadeForKids': False}}
        code, headers, body = _request(UPLOAD_URL, 'POST', {
            'Authorization': f'Bearer {access_token()}', 'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': str(size)}, json.dumps(meta).encode())
        if code != 200:
            raise RuntimeError(_google_message(body, f'YouTube said {code}'))
        session = headers.get('Location') or headers.get('location')
        sent = 0
        result = None
        with open(file, 'rb') as f:
            while sent < size:
                if job['cancelled']:
                    raise InterruptedError()
                chunk = f.read(CHUNK)
                end = sent + len(chunk) - 1
                for attempt in range(5):
                    try:
                        code, headers, body = _request(session, 'PUT', {
                            'Authorization': f'Bearer {access_token()}', 'Content-Length': str(len(chunk)),
                            'Content-Range': f'bytes {sent}-{end}/{size}'}, chunk)
                    except OSError:
                        code = 0
                    if code in (200, 201, 308) or (code and code < 500):
                        break
                    time.sleep(2 ** attempt)  # the network or YouTube hiccuped; send the piece again
                if code in (200, 201):
                    result = json.loads(body)
                    sent = size
                elif code == 308:
                    rng = headers.get('Range') or headers.get('range')
                    sent = int(rng.split('-')[1]) + 1 if rng else 0
                    f.seek(sent)
                else:
                    raise RuntimeError(_google_message(body, f'YouTube said {code}'))
                send({'state': 'running', 'pct': sent / size * 100})
        vid = result['id']
        got = result.get('status', {}).get('privacyStatus', privacy)
        send({'state': 'done', 'id': vid, 'url': f'https://youtu.be/{vid}', 'privacy': got, 'asked': privacy,
              'studio': f'https://studio.youtube.com/video/{vid}/edit'})
    except InterruptedError:
        send({'state': 'cancelled'})
    except Exception as e:  # shown to the user as it is
        send({'state': 'failed', 'error': str(e)})
    finally:
        _upload = None


def upload(opts):
    """opts: { file, title, description, privacy: private | unlisted | public }."""
    global _upload
    if _upload:
        return {'ok': False, 'error': 'A video is already uploading. Wait for it to finish.'}
    if not Path(opts.get('file') or '').is_file():
        return {'ok': False, 'error': "Couldn't find that video. Save it again."}
    if not _store().get('refresh_token'):
        return {'ok': False, 'error': 'Connect YouTube first.'}
    privacy = opts.get('privacy') if opts.get('privacy') in PRIVACY else 'unlisted'
    _upload = {'cancelled': False}
    threading.Thread(target=_upload_file, args=(_upload, opts['file'], opts.get('title') or '', opts.get('description') or '', privacy),
                     daemon=True).start()
    return {'ok': True}


def cancel_upload():
    if not _upload:
        return False
    _upload['cancelled'] = True
    return True
