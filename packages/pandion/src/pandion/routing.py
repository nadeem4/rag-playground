"""Which category a document goes to: the route checks, and the sorting.

A check is a small function of a document's cheap facts (`DocumentInfo`) that
says yes or no. Checks have their own registry, not the graph's: they run
before any step, on a file's facts. `@route_check` adds one by name, so
`when: {use: <name>}` in a route works. The built-in checks are in
`pandion/plugins/route/checks.py`.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel

from pandion.docinfo import DocumentInfo
from pandion.registry import DuplicateTransformError

if TYPE_CHECKING:
    from pandion.config import RouteRule

CheckFn = Callable[[DocumentInfo, Any], bool]


class NoSettings(BaseModel):
    """The settings of a check that has none."""


@dataclass(frozen=True)
class RegisteredCheck:
    name: str
    summary: str
    config_model: type[BaseModel]
    fn: CheckFn
    #: The phrase a reason uses when this check was true, from its settings.
    because: Callable[[Any], str]


CHECKS: dict[str, RegisteredCheck] = {}


def route_check(
    name: str,
    *,
    summary: str = "",
    config: type[BaseModel] = NoSettings,
    because: Callable[[Any], str] | None = None,
) -> Callable[[CheckFn], CheckFn]:
    """Register `fn(info, settings) -> bool` as the check `name`."""

    def add(fn: CheckFn) -> CheckFn:
        if name in CHECKS:
            raise DuplicateTransformError(
                f"route/{name} is already registered by "
                f"{CHECKS[name].fn.__module__}.{CHECKS[name].fn.__name__} "
                f"and again by {fn.__module__}.{fn.__name__}"
            )
        CHECKS[name] = RegisteredCheck(
            name, summary, config, fn, because or (lambda settings: f"{name} is true")
        )
        return fn

    return add


def built_in_checks() -> frozenset[str]:
    """The names of the checks Pandion ships; any other is a plugin's."""
    from pandion.plugins import discover

    discover()
    return frozenset(n for n, c in CHECKS.items() if c.fn.__module__ == "pandion.plugins.route.checks")


def check_catalog() -> dict[str, dict[str, Any]]:
    """Every check, in the shape `Registry.export_schema` gives a strategy."""
    return {
        name: {
            "name": name,
            "summary": check.summary,
            "stage": "route",
            "config_schema": check.config_model.model_json_schema(),
            "learn": None,
        }
        for name, check in CHECKS.items()
    }


def _phrase(use: str, settings: dict[str, Any]) -> str:
    """The reason phrase of a check that was true; a phrase that fails to build
    never stops a run."""
    try:
        return CHECKS[use].because(CHECKS[use].config_model(**settings))
    except Exception:
        return f"{use} true"


def run_check(use: str, settings: dict[str, Any], info: DocumentInfo) -> tuple[bool, str | None]:
    """(result, error). A check that raises is false, and the error says why."""
    try:
        check = CHECKS[use]
        return bool(check.fn(info, check.config_model(**settings))), None
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"


@dataclass(frozen=True)
class Sorting:
    """The category a document goes to, and why."""

    category: str
    reason: str


def sort_document(route: list[RouteRule], info: DocumentInfo | None, *, pinned: str | None = None) -> Sorting:
    """A pinned category wins. Otherwise the first rule whose checks are all
    true; the rule with no `when` takes what is left. Every check of a rule is
    run, so a failing one is never hidden by an earlier false one."""
    if pinned is not None:
        return Sorting(pinned, "Chosen when added")
    errors: list[str] = []
    for n, rule in enumerate(route, start=1):
        if rule.when is None:
            reason = "Default: no rule matched" + "".join(f"; {e}" for e in errors)
            return Sorting(rule.category, reason)
        phrases, matched = [], True
        for use, settings in rule.when:
            result, error = run_check(use, settings, info)
            if error:
                errors.append(f"{use} failed: {error}")
            if result:
                phrases.append(_phrase(use, settings))
            else:
                matched = False
        if matched:
            return Sorting(rule.category, f"Rule {n}: {' and '.join(phrases)}")
    raise ValueError("No route rule matched and none is a default.")
