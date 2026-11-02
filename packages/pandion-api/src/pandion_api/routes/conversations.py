"""Serve's /conversations and /memories: a user reads and deletes only their own.

Every route asks the Policy `limit` first, then `user_id`. A conversation or memory
that is not the caller's is a 404, the same as one that does not exist. A turn is
shown with its question, answer, source ids and trace id, never its rewrite or
the running summary. The memory routes are a 404 while `ServeSettings.chat.memory` is off.
"""

from __future__ import annotations

import anyio
from fastapi import APIRouter, HTTPException, Request, Response

router = APIRouter()

NO_CONVERSATION = "There is no conversation with that id."
NO_MEMORY = "There is no memory with that id."


def _who(request: Request) -> str:
    request.app.state.policy.limit(request)
    return request.app.state.policy.user_id(request)


def _memory_on(request: Request) -> None:
    if not request.app.state.serve.chat.memory:
        raise HTTPException(status_code=404, detail="Memory is not turned on.")


@router.get("/conversations")
async def list_conversations(request: Request):
    user = _who(request)
    rows = await anyio.to_thread.run_sync(request.app.state.conversations.list, user)
    return [r.model_dump() for r in rows]


@router.get("/conversations/{conversation_id}")
async def get_conversation(conversation_id: str, request: Request):
    user = _who(request)
    found = await anyio.to_thread.run_sync(request.app.state.conversations.load, conversation_id, user)
    if found is None:
        raise HTTPException(status_code=404, detail=NO_CONVERSATION)
    keep = ("question", "answer", "source_ids", "trace_id", "created_at")
    return {
        "id": found.id,
        "created_at": found.created_at,
        "updated_at": found.updated_at,
        "turns": [t.model_dump(include=set(keep)) for t in found.turns],
    }


@router.delete("/conversations/{conversation_id}", status_code=204)
async def delete_conversation(conversation_id: str, request: Request):
    user = _who(request)
    store = request.app.state.conversations
    if await anyio.to_thread.run_sync(store.load, conversation_id, user) is None:
        raise HTTPException(status_code=404, detail=NO_CONVERSATION)
    await anyio.to_thread.run_sync(store.delete, conversation_id, user)
    return Response(status_code=204)


@router.get("/memories")
async def list_memories(request: Request):
    user = _who(request)
    _memory_on(request)
    rows = await anyio.to_thread.run_sync(request.app.state.conversations.memories, user)
    return [m.model_dump() for m in rows]


@router.delete("/memories/{memory_id}", status_code=204)
async def delete_memory(memory_id: str, request: Request):
    user = _who(request)
    _memory_on(request)
    store = request.app.state.conversations
    if not any(m.id == memory_id for m in await anyio.to_thread.run_sync(store.memories, user)):
        raise HTTPException(status_code=404, detail=NO_MEMORY)
    await anyio.to_thread.run_sync(store.delete_memory, user, memory_id)
    return Response(status_code=204)
