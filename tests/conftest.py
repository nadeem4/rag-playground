"""Root conftest: populate the registry before anything is collected.

`tests/contract/test_contract_fast.py` parametrizes over the global registry at
**collection** time, and pytest collects `tests/contract` before
`tests/plugins`. Without this file the registry is still empty when that module
is imported, every parametrized case degenerates to a single "got empty
parameter set" skip, and the contract suite silently tests nothing — which is
strictly worse than having no contract suite, because every new plugin would
look covered.

A root conftest is imported before collection of any test module, so calling
`discover()` here is what makes the parametrization real.
"""

from __future__ import annotations

from plugins import discover

discover()
