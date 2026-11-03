"""Serve's default limits: turns a minute and active turns for each user, and the size of a request.

All in memory, so they count per server copy. A limit shared by several copies
belongs in `Policy.limit` (a gateway, or Redis).
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque
from typing import Callable

from fastapi import HTTPException
from starlette.responses import JSONResponse

TOO_FAST = "You are asking too fast. Try again in a minute."
TOO_MANY_ACTIVE = "You already have questions being answered. Wait for one to finish."
TOO_LARGE = "That request is too large."


class TurnLimiter:
    """A sliding one-minute window of turns and a count of active turns, for each user id."""

    def __init__(self, per_minute: int, active: int, clock: Callable[[], float] = time.monotonic) -> None:
        self._per_minute, self._active_max, self._clock = per_minute, active, clock
        self._times: dict[str, deque[float]] = defaultdict(deque)
        self._active: dict[str, int] = defaultdict(int)
        self._lock = threading.Lock()

    def acquire(self, user_id: str) -> None:
        """Count a turn, or raise a 429 and count nothing."""
        with self._lock:
            now = self._clock()
            for uid in list(self._times):  # forget users with nothing in the window and nothing active
                old = self._times[uid]
                while old and now - old[0] >= 60:
                    old.popleft()
                if not old and not self._active.get(uid):
                    del self._times[uid]
                    self._active.pop(uid, None)
            times = self._times[user_id]
            if len(times) >= self._per_minute:
                raise HTTPException(status_code=429, detail=TOO_FAST)
            if self._active[user_id] >= self._active_max:
                raise HTTPException(status_code=429, detail=TOO_MANY_ACTIVE)
            times.append(now)
            self._active[user_id] += 1

    def release(self, user_id: str) -> None:
        with self._lock:
            left = max(self._active.get(user_id, 0) - 1, 0)
            if left:
                self._active[user_id] = left
            else:
                self._active.pop(user_id, None)


class RateLimiter:
    """A sliding one-minute window of calls for each user id, for a route that holds no slot."""

    def __init__(self, per_minute: int, clock: Callable[[], float] = time.monotonic) -> None:
        self._per_minute, self._clock = per_minute, clock
        self._times: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, user_id: str) -> bool:
        """Count a call and return True, or return False and count nothing."""
        with self._lock:
            now = self._clock()
            for uid in list(self._times):  # forget users with nothing in the window
                old = self._times[uid]
                while old and now - old[0] >= 60:
                    old.popleft()
                if not old:
                    del self._times[uid]
            times = self._times[user_id]
            if len(times) >= self._per_minute:
                return False
            times.append(now)
            return True


class BodyLimit:
    """ASGI middleware: a request body over `max_bytes` is a 413, by its
    Content-Length before anything is read, and by a running count when it is chunked."""

    def __init__(self, app, max_bytes: int) -> None:
        self.app, self.max_bytes = app, max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        for name, value in scope["headers"]:
            if name == b"content-length" and value.isdigit() and int(value) > self.max_bytes:
                return await JSONResponse({"detail": TOO_LARGE}, status_code=413)(scope, receive, send)
        seen = 0

        async def counted():
            nonlocal seen
            message = await receive()
            seen += len(message.get("body", b""))
            if seen > self.max_bytes:
                raise HTTPException(status_code=413, detail=TOO_LARGE)
            return message

        await self.app(scope, counted, send)
