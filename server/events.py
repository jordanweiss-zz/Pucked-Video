"""Progress messages from the server to every open screen (Server-Sent Events).

Long jobs run in threads; send() can be called from any of them.
"""
from __future__ import annotations

import asyncio
import json

_loop: asyncio.AbstractEventLoop | None = None
_queues: set[asyncio.Queue] = set()


def bind(loop: asyncio.AbstractEventLoop) -> None:
    global _loop
    _loop = loop


def _put(channel: str, data) -> None:
    msg = json.dumps({'channel': channel, 'data': data})
    for q in list(_queues):
        q.put_nowait(msg)


def send(channel: str, data) -> None:
    if _loop is None:
        return
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is _loop:
        _put(channel, data)
    else:
        _loop.call_soon_threadsafe(_put, channel, data)


async def stream():
    q: asyncio.Queue = asyncio.Queue()
    _queues.add(q)
    try:
        yield ': connected\n\n'
        while True:
            try:
                msg = await asyncio.wait_for(q.get(), timeout=15)
                yield f'data: {msg}\n\n'
            except asyncio.TimeoutError:
                yield ': still here\n\n'  # keeps proxies and the browser from dropping a quiet stream
    finally:
        _queues.discard(q)
