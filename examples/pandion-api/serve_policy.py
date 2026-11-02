"""A serve-mode Policy that trusts a signed token from your gateway.

    Authorization: Bearer <payload>.<signature>

The payload is base64url JSON like {"sub": "ann", "roles": ["hr"]}. This example
signs with HMAC-SHA256 so it needs no extra package. In production the gateway
signs with a private key, and the Policy checks the signature with the
gateway's published keys, using a JWT library.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json

from fastapi import HTTPException

from pandion_api import Policy


def sign(secret: bytes, claims: dict) -> str:
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode())
    return f"{payload.decode()}.{hmac.new(secret, payload, hashlib.sha256).hexdigest()}"


class GatewayPolicy(Policy):
    def __init__(self, secret: bytes) -> None:
        self.secret = secret

    def claims(self, request) -> dict:
        """The token's claims, or a 401 for a missing or forged token."""
        payload, _, signature = request.headers.get("authorization", "").removeprefix("Bearer ").partition(".")
        good = hmac.new(self.secret, payload.encode(), hashlib.sha256).hexdigest()
        if not payload or not hmac.compare_digest(signature, good):
            raise HTTPException(status_code=401, detail="Sign in to ask a question.")
        return json.loads(base64.urlsafe_b64decode(payload))

    def user_id(self, request) -> str:
        return self.claims(request)["sub"]

    def roles(self, request) -> list[str]:
        return self.claims(request).get("roles", [])

    def limit(self, request) -> None:
        self.claims(request)  # a bad token is refused before anything runs
