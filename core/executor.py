"""The executor: walk a validated graph, memoize by artifact id, stream events.

Two rules explain almost everything here.

*The artifact id is computed before the transform runs.* It is a recipe hash, so
it is knowable from the transform, its config, and its inputs' ids alone — which
is what makes a cache hit free: no upstream payload is loaded to decide that a
node can be skipped, it just is not re-executed.

*A failure is data, not an exception.* One bad node must not take a run down,
because the whole point of a bench is comparing strategies and one of them
failing is a result. A failed node is recorded with its traceback, its
descendants are skipped, unrelated branches keep running, and `RunResult.ok`
reports the verdict.
"""

from __future__ import annotations

import time
import traceback
from copy import deepcopy
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any, Callable, TypedDict

from core.artifacts import Artifact
from core.events import Emit, event
from core.graph import Graph, Node
from core.ids import compute_artifact_id
from core.ports import RunContext
from core.registry import Registry
from core.storage import Store


class NodeStatus(StrEnum):
    EXECUTED = "executed"
    CACHED = "cached"
    PRUNED = "pruned"
    FAILED = "failed"
    SKIPPED = "skipped"


@dataclass
class NodeResult:
    """What happened to one node.

    `artifact` is None exactly when no payload was committed — a failed, pruned
    or skipped node. That is what makes a failure non-poisoning: nothing was
    written, so the next run retries rather than serving a cached failure.
    """

    node_id: str
    status: NodeStatus
    artifact: Artifact | None = None
    error: str | None = None
    duration_ms: float = 0.0


@dataclass
class RunResult:
    nodes: dict[str, NodeResult] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not any(n.status is NodeStatus.FAILED for n in self.nodes.values())


def run(
    graph: Graph,
    registry: Registry,
    store: Store,
    *,
    overrides: dict[str, dict[str, Any]] | None = None,
    targets: set[str] | None = None,
    force: bool = False,
    on_event: Emit | None = None,
    cancelled: Callable[[], bool] | None = None,
    context_extras: dict[str, Any] | None = None,
) -> RunResult:
    """Execute `graph`, reusing every artifact already in `store`.

    `targets` runs only the named nodes and their ancestors; everything else is
    PRUNED. `overrides` replaces a node's config *wholesale* — it is a patch on
    the graph, not a merge into the node's dict, so a sweep variant cannot
    accidentally inherit a field from the baseline. `force` re-executes
    everything in the selected set, cache or no cache.

    `cancelled` is polled *between* nodes, never during one: a transform is
    synchronous code with no safe interruption point. Once it returns True,
    every selected node not yet started is SKIPPED, one `run_cancelled` event
    lists them, and `run_finished` carries `cancelled=True`.

    `context_extras` is merged into every node's `RunContext.extras`, a fresh
    shallow copy per node. It is how per-run values that are not part of any
    recipe reach a transform: credentials travel as
    `{"credentials": {"anthropic_api_key": ...}}`. Nothing here is hashed, and
    only `extras["meta"]` is ever copied into artifact meta, so a credential can
    never reach an artifact id, meta or the store.
    """
    emit: Emit = on_event or (lambda e: None)
    overrides = overrides or {}
    resolved = graph.validate(registry)
    by_id = {nd.id: nd for nd in graph.nodes}

    selected = resolved.ancestors(set(targets)) if targets else set(resolved.order)

    result = RunResult()
    emit(event("run_started", nodes=list(resolved.order), selected=sorted(selected)))

    for nid in overrides:
        if nid not in selected:
            emit(
                event(
                    "warning",
                    message=(
                        f"override for node '{nid}' ignored: the node is not in "
                        "the executed set"
                    ),
                )
            )

    payloads: dict[str, Any] = {}
    broken: set[str] = set()
    skipped_by_cancel: list[str] = []

    for nid in resolved.order:
        if nid not in selected:
            result.nodes[nid] = NodeResult(nid, NodeStatus.PRUNED)
            continue

        if skipped_by_cancel or (cancelled is not None and cancelled()):
            skipped_by_cancel.append(nid)
            result.nodes[nid] = NodeResult(nid, NodeStatus.SKIPPED)
            continue

        node = by_id[nid]

        if resolved.parents.get(nid, set()) & broken:
            broken.add(nid)
            result.nodes[nid] = NodeResult(nid, NodeStatus.SKIPPED)
            emit(event("node_skipped", node_id=nid))
            continue

        cls = registry.get(node.stage, node.transform)
        instance = cls()
        config = cls.config_model(**overrides.get(nid, node.config))
        # Hash the *validated* config, so "omitted" and "sent at its default"
        # are one recipe rather than two.
        canonical_config = config.model_dump(mode="json")

        input_ids: dict[str, Any] = {}
        call_inputs: dict[str, Any] = {}
        for pname, src in resolved.bindings[nid].items():
            if isinstance(src, list):
                input_ids[pname] = [result.nodes[s].artifact.id for s in src]
                call_inputs[pname] = [payloads[s] for s in src]
            else:
                input_ids[pname] = result.nodes[src].artifact.id
                call_inputs[pname] = payloads[src]

        aid = compute_artifact_id(
            transform_name=cls.name,
            transform_version=cls.version,
            # The validated config, because model identity depends on it: a
            # revision bump on a *non-default* embedder moves nothing in the
            # config hash, so only the fingerprint can invalidate the id.
            fingerprint=instance.fingerprint(config),
            output_type=cls.output,
            config=canonical_config,
            inputs=input_ids,
        )

        emit(event("node_started", node_id=nid, transform=cls.name, artifact_id=aid))
        started = time.perf_counter()

        if cls.cacheable and not force and store.has(aid):
            payloads[nid] = store.load(aid, cls.output)
            result.nodes[nid] = NodeResult(
                nid,
                NodeStatus.CACHED,
                store.get_meta(aid),
                duration_ms=(time.perf_counter() - started) * 1000,
            )
            emit(
                event(
                    "node_finished",
                    node_id=nid,
                    artifact_id=aid,
                    cache_hit=True,
                    duration_ms=result.nodes[nid].duration_ms,
                )
            )
            continue

        ctx = RunContext(
            output_dir=store.root / ".scratch" / aid[:16],
            emit=emit,
            tmp=store.root / ".scratch" / "tmp",
            extras=dict(context_extras or {}),
        )
        ctx.output_dir.mkdir(parents=True, exist_ok=True)
        ctx.tmp.mkdir(parents=True, exist_ok=True)

        try:
            payload = instance.apply(call_inputs, config, ctx)
        except Exception:
            broken.add(nid)
            err = traceback.format_exc()
            result.nodes[nid] = NodeResult(
                nid,
                NodeStatus.FAILED,
                error=err,
                duration_ms=(time.perf_counter() - started) * 1000,
            )
            emit(event("node_failed", node_id=nid, error=err))
            continue

        # Transform-supplied meta is merged *under* the built-ins: the spread
        # goes first, so a plugin can attach a capability descriptor for the
        # store and the UI but cannot spoof `transform` or `node_id`.
        artifact = Artifact(
            id=aid,
            type=cls.output,
            meta={
                **ctx.extras.get("meta", {}),
                "transform": cls.name,
                "node_id": nid,
            },
        )
        # Always persisted, cacheable or not: `cacheable = False` only means the
        # stored result is never *reused* (above). Writing it anyway lets the UI
        # fetch it by artifact id; a re-run replaces it, so the latest run wins.
        store.put(artifact, payload)
        # Read back, so a downstream node sees exactly what it would see on a
        # cache hit. An index payload is a *writer callable* going in and a
        # directory coming out; without this, "executed" and "cached" would
        # hand downstream two different things.
        payloads[nid] = store.load(aid, cls.output)

        result.nodes[nid] = NodeResult(
            nid,
            NodeStatus.EXECUTED,
            artifact,
            duration_ms=(time.perf_counter() - started) * 1000,
        )
        emit(
            event(
                "node_finished",
                node_id=nid,
                artifact_id=aid,
                cache_hit=False,
                duration_ms=result.nodes[nid].duration_ms,
            )
        )

    if skipped_by_cancel:
        emit(event("run_cancelled", skipped=skipped_by_cancel))
    emit(event("run_finished", ok=result.ok, cancelled=bool(skipped_by_cancel)))
    return result


class Variant(TypedDict):
    """One point in a sweep: a transform *and* its config.

    Varying the transform is the feature. Comparing two parsers or two chunking
    strategies is a different implementation, not a different parameter, and a
    config-only sweep cannot express it.
    """

    transform: str
    config: dict[str, Any]


@dataclass
class SweepResult:
    variants: list[Variant] = field(default_factory=list)
    runs: list[RunResult] = field(default_factory=list)


def sweep(
    graph: Graph,
    registry: Registry,
    store: Store,
    *,
    node_id: str,
    variants: list[Variant],
    through: str | None = None,
    force: bool = False,
    on_event: Emit | None = None,
    cancelled: Callable[[], bool] | None = None,
    context_extras: dict[str, Any] | None = None,
) -> SweepResult:
    """Run one node over N variants against identical upstream input.

    Upstream is shared, not re-run: every variant produces the same upstream
    artifact ids, so the second variant hits the cache. A three-variant chunker
    sweep parses once and chunks three times.

    `through` names how far downstream to execute — pass a use_case node id to
    score a chunker sweep on end-to-end retrieval quality instead of stopping at
    the chunks. A variant that fails is recorded and the sweep continues.

    `cancelled` is threaded into each run and also checked before each
    variant, so a cancelled sweep starts no further variants.
    `context_extras` is passed to every run unchanged (see `run`).
    """
    emit: Emit = on_event or (lambda e: None)
    out = SweepResult(variants=list(variants))
    target = through or node_id

    for i, variant in enumerate(variants):
        if cancelled is not None and cancelled():
            break
        g = deepcopy(graph)
        g.nodes = [
            Node(
                id=nd.id,
                stage=nd.stage,
                transform=variant["transform"],
                config=variant.get("config", {}),
            )
            if nd.id == node_id
            else nd
            for nd in g.nodes
        ]
        emit(event("variant_started", index=i, variant=dict(variant)))
        out.runs.append(
            run(
                g,
                registry,
                store,
                targets={target},
                force=force,
                on_event=on_event,
                cancelled=cancelled,
                context_extras=context_extras,
            )
        )
        emit(event("variant_finished", index=i, ok=out.runs[-1].ok))

    return out
