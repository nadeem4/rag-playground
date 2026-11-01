"""The conformance suite, run against the reference memory store."""

import pytest

from pandion.index_memory import MemorySettings, MemoryStore
from pandion.index_store import AnyOf, And, get_store
from pandion.testing import STORE_CHECKS, store_conformance


@pytest.mark.parametrize("name", list(STORE_CHECKS), ids=list(STORE_CHECKS))
def test_memory_store_passes_each_check(name):
    STORE_CHECKS[name](MemoryStore(MemorySettings()))


def test_store_conformance_passes_for_the_memory_store():
    store_conformance(lambda: get_store("memory"))


def test_conformance_catches_a_store_that_returns_rows_with_no_roles():
    """A store that lets an empty roles list through an any_of filter is the leak the suite exists to catch."""

    class Leaky(MemoryStore):
        def create(self, name, meta):
            col = super().create(name, meta)
            real_dense, real_lexical = col.search_dense, col.search_lexical
            col.search_dense = lambda vector, k, where: _leak(real_dense, (vector, k), where, col)
            col.search_lexical = lambda text, k, where: _leak(real_lexical, (text, k), where, col)
            return col

    def _leak(search, args, where, col):
        hits = search(*args, where)
        if isinstance(where, AnyOf) and where.field == "roles":
            extra = search(*args, And(()))
            seen = {h.row.id for h in hits}
            hits = hits + [h for h in extra if not h.row.roles and h.row.id not in seen]
        return hits

    with pytest.raises(AssertionError, match="a_row_with_no_roles_is_never_returned"):
        store_conformance(lambda: Leaky(MemorySettings()))
