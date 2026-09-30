"""The visitor cookie: an anonymous id for one browser, minted by the server.

A cookie rather than a header because page images (`<img>`) and run streams
(`EventSource`) cannot carry headers, and the browser sends cookies on all of
them. It is the key to a visitor's own uploads in demo mode and nothing more:
no login, no account. Clearing cookies means starting over.
"""

from __future__ import annotations

import re
import secrets

from fastapi import Request, Response

COOKIE = "rag_visitor"
_VALID = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
_MAX_AGE = 365 * 24 * 3600


def visitor_id(request: Request) -> str | None:
    """The request's visitor id, or None when the cookie is absent or malformed."""
    value = request.cookies.get(COOKIE)
    return value if value and _VALID.match(value) else None


def ensure_visitor(request: Request, response: Response) -> str:
    """The visitor id, minting one and setting the cookie when there is none."""
    existing = visitor_id(request)
    if existing:
        return existing
    minted = secrets.token_urlsafe(24)  # 32 URL-safe characters
    response.set_cookie(COOKIE, minted, max_age=_MAX_AGE, path="/", samesite="lax", httponly=True)
    return minted
