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
    return value if value and _VALID.fullmatch(value) else None


def ensure_visitor(request: Request, response: Response) -> str:
    """The visitor id, minting one and setting the cookie when there is none."""
    existing = visitor_id(request)
    if existing:
        return existing
    minted = secrets.token_urlsafe(24)  # 32 URL-safe characters
    if _secure(request):
        # The Hugging Face Space page shows the app in a cross-site iframe, where
        # a Lax cookie is never sent. None needs Secure; Partitioned keeps it in
        # browsers that block third-party cookies. Starlette's `partitioned`
        # needs Python 3.14, so the header is written by hand.
        response.headers.append(
            "set-cookie",
            f"{COOKIE}={minted}; HttpOnly; Max-Age={_MAX_AGE}; Path=/; SameSite=None; Secure; Partitioned",
        )
    else:
        # Plain http (local runs, tests): a Secure cookie would never come back.
        response.set_cookie(COOKIE, minted, max_age=_MAX_AGE, path="/", samesite="lax", httponly=True)
    return minted


def _secure(request: Request) -> bool:
    """Did the browser reach us over https? The Space's proxy ends TLS and says so."""
    return request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
