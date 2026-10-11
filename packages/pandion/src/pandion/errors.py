"""Errors a package user can act on.

Parsers, OCR, local models and stores are optional extras, so the base install
stays small. A plugin imports its library inside the function that needs it,
through `require`, and a missing one says which extra brings it. Nothing is
ever installed while a pipeline runs.
"""

from __future__ import annotations

import importlib
from types import ModuleType


class MissingExtra(ImportError):
    """A step needs a package that was not installed with pandion."""


def require(module: str, *, extra: str, step: str) -> ModuleType:
    """Import `module`, or say how to install the extra that brings it."""
    try:
        return importlib.import_module(module)
    except ImportError as exc:
        raise MissingExtra(
            f'{step} needs {module}. Install it with: pip install "pandion[{extra}]"'
        ) from exc
