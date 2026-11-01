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
"""

from typing import Any

from pandion.artifacts import ArtifactType
from pandion.docinfo import DocumentInfo, document_info
from pandion.embeddings import Embedder, get_embedder, register_embedder
from pandion.endpoints import EndpointRefused, guard_endpoint
from pandion.fetch import FetchRefused, fetch_url
from pandion.formats import FORMATS, UnreadableFormat, check_contents, format_of
from pandion.llm import openai_client_kwargs
from pandion.plugins import PluginError, load as load_plugins, plugin_listing
from pandion.payloads import Chunk, ChunkSet, Element, Hit, Output, ParsedDoc, Query, RetrievalResult
from pandion.ports import PortSpec, RunContext, Stage, set_note, set_usage
from pandion.registry import register as _register_transform
from pandion.routing import route_check
from pandion.sources import raw_file
from pandion.transform import Explanation, Transform

__all__ = [
    "FORMATS", "ArtifactType", "Chunk", "ChunkSet", "DocumentInfo", "Element", "Embedder", "EndpointRefused",
    "Explanation", "FetchRefused", "Hit", "Output", "ParsedDoc", "PortSpec", "Query", "RetrievalResult",
    "RunContext", "Stage", "Transform", "UnreadableFormat", "check_contents", "document_info", "fetch_url", "format_of", "get_embedder", "guard_endpoint",
    "openai_client_kwargs", "PluginError", "load_plugins", "plugin_listing", "raw_file", "register", "route_check", "set_note", "set_usage",
]


def register(cls: Any) -> Any:
    """Add a strategy (a Transform) or an embedder, so its name works in YAML and code."""
    if isinstance(cls, type) and issubclass(cls, Embedder):
        return register_embedder(cls)
    if isinstance(cls, type) and issubclass(cls, Transform):
        return _register_transform(cls)
    raise TypeError(f"register takes a Transform or an Embedder subclass, not {cls!r}.")
