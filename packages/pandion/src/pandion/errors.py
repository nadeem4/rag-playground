"""Errors a package user can act on.

Parsers, OCR, local models and stores are optional extras, so the base install
stays small. A plugin imports its library inside the function that needs it,
through `require`, and a missing one says which extra brings it. Nothing is
ever installed while a pipeline runs.
"""

from __future__ import annotations

import importlib
from types import ModuleType


class FormatTooNew(ValueError):
    """A file was written by a newer pandion than this one."""


class MissingExtra(ImportError):
    """A step needs a package that was not installed with pandion."""


def require(module: str, *, extra: str, step: str) -> ModuleType:
    """Import `module`, or say how to install the extra that brings it.

    Only a missing `module` itself (its top-level package) means the extra is
    not installed. Any other import error, such as a dependency of an
    installed library that is gone or a library that fails to load, is raised
    as it is, because "install the extra" would be the wrong advice.
    """
    try:
        return importlib.import_module(module)
    except ModuleNotFoundError as exc:
        top = module.split(".")[0]
        if (exc.name or "").split(".")[0] != top:
            raise
        raise MissingExtra(
            f'{step} needs {module}. Install it with: pip install "pandion[{extra}]"'
        ) from exc
