"""Plain FastAPI dependencies: what a route gets from the app it runs in."""

from __future__ import annotations

from fastapi import Request

from pandion_api.documents import DocumentStore
from pandion_api.policy import Policy
from pandion_api.runs import RunManager
from pandion_api.settings import ApiSettings


def get_policy(request: Request) -> Policy:
    return request.app.state.policy


def get_settings(request: Request) -> ApiSettings:
    return request.app.state.settings


def get_runs(request: Request) -> RunManager:
    return request.app.state.runs


def get_documents(request: Request) -> DocumentStore:
    return request.app.state.documents
