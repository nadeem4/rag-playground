"""The answer steps, as classes for a pipeline written in code.

`Search(top_k=5)` shows the pieces retrieval found, as they are. `Chat(model=
"claude-haiku-4-5")` asks a chat model for an answer whose claims cite those
pieces. Each is the same as its block, for example `{"use": "search",
"top_k": 5}` (`pandion.config.step_class`). Answering runs through a
pipeline: `p.ask(question)`.
"""

from pandion.config import step_class
from pandion.ports import Stage

Search = step_class(Stage.USE_CASE, "search", __name__)
Chat = step_class(Stage.USE_CASE, "chat", __name__)

__all__ = ["Chat", "Search"]
