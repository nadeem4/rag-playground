"""Model-facing services shared by plugins: embedders and token counters.

Providers are not transforms. A transform is a node in a graph with an artifact
on either side; a provider is a thing a transform *uses*, and several stages use
the same one — `index` embeds chunks, `retrieve` embeds the query, and `rerank`
re-embeds candidates. They must agree on the model, so it lives here rather than
being re-declared per plugin.
"""
