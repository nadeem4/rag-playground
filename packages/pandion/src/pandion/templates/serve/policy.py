"""Who is asking, and what they may see.

This server sits behind your gateway, which has already signed the user in. The
gateway passes the user's id in a header (the one named by USER_ID_HEADER,
default x-user-id). A request without it is refused with a 401, so keep this
server on a private network that only the gateway can reach.
"""

import os

from fastapi import HTTPException
from pandion_api import Policy


class GatewayPolicy(Policy):
    def user_id(self, request) -> str:
        header = os.environ.get("USER_ID_HEADER", "x-user-id")
        user = request.headers.get(header, "").strip()
        if not user:
            raise HTTPException(status_code=401, detail="Sign in to ask a question.")
        return user

    def roles(self, request) -> list[str]:
        # Fill this in from your identity system. It returns no roles until you
        # do, so with access on nobody sees any document.
        return []

    def limit(self, request) -> None:
        self.user_id(request)  # a request with no user is refused before anything runs
