"""The web server: the screens (renderer/), the files they show, and the calls they make.

Every call the screens make goes to POST /api/<name> with its arguments as a JSON list, so
renderer/api.js can offer the same window.api the Electron version had."""
from __future__ import annotations

import asyncio
import inspect
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from . import autocut, clips, core, events, hockey_ai, jobs, library
from .config import APP_DIR, path_from_url

# name the screens call -> function. Arguments arrive in the same order as the old window.api.
CALLS = {
    'video:info': core.video_info,
    'sports:list': core.list_sports,
    'tags:load': core.load_tags,
    'tags:save': core.save_tags,
    'xbotgo:marks': core.xbotgo_marks,
    'teams:load': core.load_teams,
    'teams:save': core.save_teams,
    'settings:load': core.load_settings,
    'settings:save': core.save_settings,
    'ai:dir:check': core.check_ai_dir,
    'ai:dir:find': core.find_ai_dir,
    'ffmpeg:check': core.check_ffmpeg,
    'ai:events:load': hockey_ai.load_events,
    'ai:run:load': hockey_ai.load_ai_run,
    'ai:players:save': hockey_ai.save_players,
    'ai:refilter': hockey_ai.refilter,
    'ai:game': hockey_ai.game_status,
    'ai:picks:save': hockey_ai.save_picks,
    'ai:analyze': hockey_ai.analyze,
    'ai:report': hockey_ai.report,
    'ai:job:get': jobs.current,
    'ai:job:cancel': jobs.cancel,
    'clips:export': clips.export_clips,
    'clips:cancel': clips.cancel,
    'frame:save': clips.save_frame,
    'xbotgo:motion': autocut.track_motion,
    'autocut:scan': autocut.scan,
    'autocut:save': autocut.save,
    'autocut:cancel': autocut.cancel,
    'library:scan': library.scan,
    'library:thumb': library.thumb,
    'ai:data': hockey_ai.game_data,
    'ai:update': hockey_ai.update,
}

LOCAL_HOSTS = {'127.0.0.1', 'localhost', '[::1]'}


@asynccontextmanager
async def lifespan(_app):
    events.bind(asyncio.get_running_loop())
    watcher = asyncio.create_task(jobs.watch())
    yield
    watcher.cancel()


app = FastAPI(title='Pucked Video', lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware('http')
async def local_only(request: Request, call_next):
    # Until sign-in exists (phase 3) the server only answers this computer. Checking the Host header
    # also stops other websites from reaching it through DNS tricks.
    host = (request.headers.get('host') or '').rsplit(':', 1)[0]
    if host not in LOCAL_HOSTS:
        return JSONResponse({'error': 'Pucked Video only accepts connections from this computer for now.'}, status_code=403)
    return await call_next(request)


@app.get('/api/health')
def health():
    return {'ok': True}


@app.post('/api/{name}')
async def call(name: str, request: Request):
    # The custom header can't be sent by another website without the browser asking first, which we never allow.
    if request.headers.get('x-pucked') != '1':
        raise HTTPException(403, 'Missing X-Pucked header')
    fn = CALLS.get(name)
    if not fn:
        raise HTTPException(404, f'No call named {name}')
    body = await request.json() if await request.body() else {}
    args = body.get('args', [])
    try:
        if inspect.iscoroutinefunction(fn):
            result = await fn(*args)
        else:
            result = await run_in_threadpool(fn, *args)
    except Exception as e:  # the screens show the message, as the Electron version did
        return JSONResponse({'error': str(e)}, status_code=500)
    return {'result': result}


@app.get('/api/events')
async def stream_events():
    return StreamingResponse(events.stream(), media_type='text/event-stream',
                             headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@app.get('/files/{path:path}')
def files(path: str):
    """A video, picture or report from this computer. Range requests let the player jump anywhere in a
    30 GB game without reading the whole file."""
    p = path_from_url(path)
    if not p.is_file():
        raise HTTPException(404, 'Not found')
    return FileResponse(p)


app.mount('/', StaticFiles(directory=APP_DIR / 'renderer', html=True), name='renderer')
