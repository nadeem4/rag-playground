"""Everything you need to write your own strategy for any stage.

A strategy is a class: its stage, what it reads (`inputs`), what it makes
(`output`, fixed by the stage), a settings model where every field has a
default, one plain sentence (`summary`), and `apply()`. Decorate it with
`@register` and its `name` works in YAML and in `Pipeline(...)` like a
built-in. `@register` also takes an `Embedder` subclass, which adds an
embedder that `embed: {use: <its name>}` can pick. See docs/pandion.md,
"Write your own strategy", and examples/pandion/own_strategies/ for one
strategy per stage.

A strategy, or a server, that calls a model endpoint the user named checks it
with `guard_endpoint` and builds the OpenAI client's arguments with
`openai_client_kwargs`. A route looks at a `DocumentInfo` (made by
`document_info`): the cheap facts about a file before it is parsed, and `@route_check`
adds a check of those facts for `when: {use: <name>}`. A server
that parses a stored file catches `UnreadableFormat`, raised when the parser cannot read the file's format, and
can judge a file before it keeps it with `format_of` (a file name's format by
its extension, or None) and `FORMATS` (each format's name, what one file of it
is, and its extensions). `check_contents` raises `UnreadableFormat` for a PDF
or an image behind a Word, PowerPoint, HTML, Markdown or text file's name,
the check an index run makes before any step. A server that takes a URL as a document fetches it
with `fetch_url` and catches `FetchRefused`, raised with a plain reason when
the guard refuses it.

A team that keeps its index somewhere else writes an index store: `IndexRow`,
`IndexMeta`, `StoreHit`, `Capabilities` and the filters `Eq`, `In`, `AnyOf` and
`And` are its words, and `register_store` adds it. See docs/pandion.md, "Index stores".

A team that keeps its chats somewhere else writes a conversation store: `Turn`,
`Conversation`, `ConversationInfo` and `Memory` are its words, `ConversationStore` is the
contract, and `register_conversation_store` adds it. A store that also keeps a `TraceRecord` for each turn, and its `Feedback`, is a `TraceStore`. A server runs a turn with `chat_turn`
(`ChatSettings`, `fold_summary` and `remember` go with it; `flags_for` and `give_feedback` mark and judge its traces) on a store from `get_conversation_store`. See docs/pandion.md, "Conversations".

A team that keeps its documents somewhere else writes a `Source`: `SourceEntry`
is what it lists, `register_source` adds it, and `index.sync(source)` reads
only the entries that are new or changed. See docs/pandion.md, "Sync from a source".

A team that decides who may read a document writes an `@access_rule`: it takes a
`DocumentInfo` and returns role names, or None for no opinion. A rule that fails
leaves the document visible to nobody. See docs/pandion.md, "Who may read a document".
"""

from typing import Any

from pandion.access import ALL_ROLES, AccessDenied, access_rule
from pandion.artifacts import ArtifactType
from pandion.chat_turn import ChatSettings, TurnResult, chat_turn, fold_summary, remember
from pandion.errors import MissingExtra
from pandion.conversation_store import (
    Conversation, ConversationInfo, ConversationNotFound, ConversationStore, Memory, TraceStore, Turn,
    get_conversation_store, register_conversation_store,
)
from pandion.docinfo import DocumentInfo, document_info
from pandion.document_sources import Source, SourceEntry, register_source
from pandion.embeddings import Embedder, get_embedder, register_embedder
from pandion.endpoints import EndpointRefused, guard_endpoint
from pandion.fetch import FetchRefused, fetch_url
from pandion.formats import FORMATS, UnreadableFormat, check_contents, format_of
from pandion.index_store import AnyOf, And, Capabilities, Eq, In, IndexMeta, IndexRow, StoreHit, register_store
from pandion.llm import openai_client_kwargs
from pandion.plugins import PluginError, load as load_plugins, plugin_listing
from pandion.payloads import Chunk, ChunkSet, Element, Hit, Output, ParsedDoc, Query, RetrievalResult
from pandion.ports import PortSpec, RunContext, Stage, set_note, set_usage
from pandion.registry import register as _register_transform
from pandion.routing import route_check
from pandion.sources import raw_file
from pandion.flags import TracesNotKept, flags_for, give_feedback
from pandion.trace_record import Feedback, TraceRecord
from pandion.trace_report import TRACE_LIMIT, TraceReport, format_trace, format_trace_report, parse_since, summarise_traces
from pandion.transform import Explanation, Transform

__all__ = [
    "ALL_ROLES", "AccessDenied", "ChatSettings", "TurnResult", "chat_turn", "fold_summary", "remember", "get_conversation_store", "access_rule", "FORMATS", "And", "AnyOf", "ArtifactType", "Capabilities", "Chunk", "ChunkSet", "Conversation", "ConversationInfo", "ConversationNotFound", "ConversationStore", "DocumentInfo", "Element", "Embedder",
    "EndpointRefused", "Eq", "Explanation", "FetchRefused", "Feedback", "TraceRecord", "TraceStore", "flags_for", "give_feedback", "TracesNotKept", "TRACE_LIMIT", "TraceReport", "format_trace_report", "format_trace", "parse_since", "summarise_traces", "Hit", "In", "IndexMeta", "IndexRow", "Memory", "MissingExtra", "Output", "ParsedDoc",
    "PluginError", "PortSpec", "Query", "RetrievalResult", "RunContext", "Source", "SourceEntry", "Stage", "StoreHit", "Transform", "Turn", "UnreadableFormat",
    "check_contents", "document_info", "fetch_url", "format_of", "get_embedder", "guard_endpoint", "load_plugins",
    "openai_client_kwargs", "plugin_listing", "raw_file", "register", "register_conversation_store", "register_source", "register_store", "route_check", "set_note", "set_usage",
]


def register(cls: Any) -> Any:
    """Add a strategy (a Transform) or an embedder, so its name works in YAML and code."""
    if isinstance(cls, type) and issubclass(cls, Embedder):
        return register_embedder(cls)
    if isinstance(cls, type) and issubclass(cls, Transform):
        return _register_transform(cls)
    raise TypeError(f"register takes a Transform or an Embedder subclass, not {cls!r}.")
