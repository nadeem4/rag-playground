"""One strategy for every stage of a Pandion pipeline.

Importing this package imports every module below, and each module's
`@register` adds its strategy, so one import (or `plugins: [my_strategies]` in
a pipeline file) makes all of them usable by name.
"""

from my_strategies import (  # noqa: F401
    answer,
    chunk,
    clean,
    embed,
    parse,
    rerank,
    retrieve,
    rewrite,
    source,
    store,
)
