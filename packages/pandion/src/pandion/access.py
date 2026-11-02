"""Who may read a document: roles per document, resolved at index time.

A document's roles come from the first source that has an opinion: its own
`roles` label, a folder rule from `pipeline.yaml`, an `@access_rule` function,
then the default. A rule that fails gives the document no roles, so it is
visible to nobody: access fails closed.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from pandion.docinfo import DocumentInfo
from pandion.plugins.route.checks import _glob
from pandion.registry import DuplicateTransformError

AccessFn = Callable[[DocumentInfo], "list[str] | None"]

#: Passed as `roles=` for an admin run: no roles filter.
ALL_ROLES: object = object()

RULES: dict[str, AccessFn] = {}


class AccessDenied(ValueError):
    """A search needs roles it was not given, or a rule is not registered."""


@dataclass(frozen=True)
class FolderRule:
    match: str
    roles: list[str]


@dataclass(frozen=True)
class AccessConfig:
    default: list[str] = field(default_factory=list)
    folders: list[FolderRule] = field(default_factory=list)
    rules: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class Resolved:
    roles: list[str]
    reason: str


def access_rule(name: str) -> Callable[[AccessFn], AccessFn]:
    """Register `fn(info) -> list[str] | None` as the access rule `name`.
    `None` means no opinion."""

    def add(fn: AccessFn) -> AccessFn:
        if name in RULES:
            old = RULES[name]
            raise DuplicateTransformError(
                f"access/{name} is already registered by {old.__module__}.{old.__name__} "
                f"and again by {fn.__module__}.{fn.__name__}"
            )
        RULES[name] = fn
        return fn

    return add


def resolve_roles(doc_id: str, info: DocumentInfo, access: AccessConfig) -> Resolved:
    if "roles" in info.metadata:
        roles = [r.strip() for r in info.metadata["roles"].split(",") if r.strip()]
        return Resolved(roles, "file metadata")
    for folder in access.folders:
        if _glob(doc_id, folder.match):
            return Resolved(list(folder.roles), f"folder rule {folder.match}")
    for name in access.rules:
        if name not in RULES:
            raise AccessDenied(f"The access rule '{name}' is not registered")
        try:
            got = RULES[name](info)
            if got is not None and not (
                isinstance(got, list) and all(isinstance(r, str) and r for r in got)
            ):
                raise TypeError("an access rule returns a list of role names, or None")
        except Exception as e:  # noqa: BLE001 - any failure must close the document
            return Resolved([], f"access rule {name} failed: {type(e).__name__}: {e}")
        if got is not None:
            return Resolved(list(got), f"access rule {name}")
    return Resolved(list(access.default), "default")
