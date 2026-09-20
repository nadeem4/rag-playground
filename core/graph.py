"""The pipeline DAG: nodes, edges, and the one validation pass.

Validation is a gate, not a hint. Everything downstream — the executor, the
cache, the UI — may assume a `ResolvedGraph` is well formed: acyclic, every port
typed and bound, every capability satisfied. That is why `validate()` returns a
*different* type rather than a boolean: an unvalidated graph is simply not
runnable.

Ambient ports are resolved here rather than by the executor, so the resolution
is visible in `bindings` and folds into the recipe hash like any explicit edge.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from graphlib import CycleError, TopologicalSorter
from typing import Any

from core.ports import Stage
from core.registry import Registry, UnknownTransformError
from core.transform import Transform


class GraphValidationError(ValueError):
    """A graph that cannot be run. Raised before any transform executes."""


@dataclass(frozen=True)
class Node:
    """One transform instance in the pipeline.

    `config` is the raw dict as the UI sends it; it is validated against the
    transform's `config_model` by the executor, not here.
    """

    id: str
    stage: Stage
    transform: str
    config: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Edge:
    """A wire from one node's single output into a named input port."""

    src: str
    dst: str
    port: str


#: A port binds to one source node, or — when variadic — to an ordered list.
Binding = str | list[str]


@dataclass
class ResolvedGraph:
    """A validated graph. Only this type is runnable."""

    order: list[str]
    bindings: dict[str, dict[str, Binding]]
    parents: dict[str, set[str]]

    def ancestors(self, node_ids: set[str]) -> set[str]:
        """The targets *and* their transitive ancestors.

        Including the targets is what makes this directly usable as the set of
        nodes to run for a partial execution.
        """
        seen: set[str] = set()
        stack = list(node_ids)
        while stack:
            nid = stack.pop()
            if nid in seen:
                continue
            seen.add(nid)
            stack.extend(self.parents.get(nid, ()))
        return seen


def _capabilities_satisfied(requires: dict[str, Any], provides: dict[str, Any]) -> bool:
    """A list requirement is a subset test; anything else is equality."""
    for key, needed in requires.items():
        have = provides.get(key)
        if isinstance(needed, list):
            if not isinstance(have, list) or not set(needed) <= set(have):
                return False
        elif have != needed:
            return False
    return True


@dataclass
class Graph:
    nodes: list[Node] = field(default_factory=list)
    edges: list[Edge] = field(default_factory=list)

    def node(self, nid: str) -> Node:
        for nd in self.nodes:
            if nd.id == nid:
                return nd
        raise GraphValidationError(f"unknown node: {nid}")

    def validate(self, registry: Registry) -> ResolvedGraph:
        by_id: dict[str, Node] = {}
        for nd in self.nodes:
            if nd.id in by_id:
                raise GraphValidationError(f"duplicate node id: {nd.id}")
            by_id[nd.id] = nd

        specs: dict[str, type[Transform]] = {}
        for nd in self.nodes:
            try:
                specs[nd.id] = registry.get(nd.stage, nd.transform)
            except UnknownTransformError as exc:
                raise GraphValidationError(
                    f"node {nd.id}: unknown transform {nd.transform}"
                ) from exc

        # --- explicit edges -------------------------------------------------
        bindings: dict[str, dict[str, Binding]] = {nd.id: {} for nd in self.nodes}
        parents: dict[str, set[str]] = {nd.id: set() for nd in self.nodes}

        for e in self.edges:
            if e.src not in by_id or e.dst not in by_id:
                raise GraphValidationError(f"edge {e.src}->{e.dst}: unknown node")

            dst_ports = specs[e.dst].inputs
            if e.port not in dst_ports:
                raise GraphValidationError(
                    f"edge {e.src}->{e.dst}: unknown port '{e.port}'"
                )

            port = dst_ports[e.port]
            src_type = specs[e.src].output
            if src_type != port.type:
                raise GraphValidationError(
                    f"edge {e.src}->{e.dst}.{e.port}: type '{src_type}' does not "
                    f"match port type '{port.type}'"
                )

            if not _capabilities_satisfied(
                specs[e.dst].requires, specs[e.src].provides
            ):
                raise GraphValidationError(
                    f"edge {e.src}->{e.dst}.{e.port}: capability mismatch — "
                    f"requires {specs[e.dst].requires}, "
                    f"source provides {specs[e.src].provides}"
                )

            slot = bindings[e.dst]
            if port.variadic:
                # Edge declaration order is the fan-in order, and it is part of
                # the recipe hash — so it must never be sorted or de-duplicated.
                slot.setdefault(e.port, [])
                slot[e.port].append(e.src)  # type: ignore[union-attr]
            else:
                if e.port in slot:
                    raise GraphValidationError(
                        f"{e.dst}.{e.port} is a single-valued port but has two "
                        "incoming edges"
                    )
                slot[e.port] = e.src
            parents[e.dst].add(e.src)

        # --- topological order (needed before ambient resolution) -----------
        sorter = TopologicalSorter({nid: parents[nid] for nid in by_id})
        try:
            order = list(sorter.static_order())
        except CycleError as exc:
            raise GraphValidationError(f"graph contains a cycle: {exc}") from exc

        position = {nid: i for i, nid in enumerate(order)}

        # --- ambient ports: nearest ancestor producing the type -------------
        for nid in order:
            for pname, port in specs[nid].inputs.items():
                if not port.ambient or pname in bindings[nid]:
                    continue
                candidates = [
                    other
                    for other in order
                    if position[other] < position[nid]
                    and specs[other].output == port.type
                ]
                if not candidates:
                    if port.required:
                        raise GraphValidationError(
                            f"{nid}.{pname}: ambient port found no upstream node "
                            f"producing '{port.type}'"
                        )
                    continue
                bindings[nid][pname] = candidates[-1]
                parents[nid].add(candidates[-1])

        # --- every required port is bound -----------------------------------
        for nid in order:
            for pname, port in specs[nid].inputs.items():
                if port.required and pname not in bindings[nid]:
                    raise GraphValidationError(
                        f"{nid}: required port '{pname}' is not connected"
                    )

        return ResolvedGraph(order=order, bindings=bindings, parents=parents)
