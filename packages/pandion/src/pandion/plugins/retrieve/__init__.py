"""Retrieve-stage plugins.

`read_descriptor` and `embedder_for` are public: a step outside this folder
that embeds text with the index's own model, such as a reranker or an answer
step, reads the index's descriptor and gets its embedder through them.
"""

from pandion.plugins.retrieve._base import embedder_for, read_descriptor

__all__ = ["embedder_for", "read_descriptor"]
