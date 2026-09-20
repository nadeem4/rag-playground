"""The one interface every plugin implements.

Learning this once is enough to add a VLM parser, a semantic chunker, or a
cross-encoder reranker. Adding a strategy is always: subclass, declare a config
model, register.

This is an ABC with a TypeVar rather than a Protocol. A runtime-checkable
Protocol with non-method members validates attribute *presence* but never types,
so the registry would hand-validate anyway; an ABC additionally gives inherited
defaults, import-time validation with a good error message, real `isinstance`,
and generics that typecheck. Protocol's only advantage — no inheritance required
— is worth nothing here, because this is an application, not a library.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Generic, Mapping, TypeVar

from pydantic import BaseModel

from core.artifacts import ArtifactType
from core.ports import STAGE_OUTPUT, PortSpec, RunContext, Stage

C = TypeVar("C", bound=BaseModel)


class TransformDefinitionError(TypeError):
    """Raised at class-definition time when a Transform is malformed.

    Failing at import rather than at run time means a malformed plugin can never
    reach a graph.
    """


class Transform(ABC, Generic[C]):
    name: str
    version: str = "1"
    stage: Stage
    inputs: Mapping[str, PortSpec] = {}
    output: ArtifactType
    config_model: type[C]

    #: False for LLM-backed transforms at temperature > 0. A recipe hash is a
    #: sound cache key only for deterministic transforms; non-deterministic ones
    #: are surfaced in the UI as "cached — may differ on re-run".
    deterministic: bool = True

    #: False for transforms whose output should never be reused — chat answers,
    #: chiefly. Otherwise asking the same question twice replays the old answer.
    cacheable: bool = True

    #: Capability predicates on input ports, keyed by *port name*, checked at
    #: graph validation for both explicit edges and ambient bindings. A bm25
    #: retriever declares requires = {"index": {"backends": ["fts"]}} so it
    #: cannot be wired to a dense-only index — a type-legal edge that would
    #: otherwise fail at run time, or worse, return silent garbage. The contract
    #: is per port because it is a statement about one input: the same retriever
    #: says nothing about its `query` port, and a port absent from this mapping
    #: is unconstrained.
    requires: dict[str, dict[str, Any]] = {}

    #: Capability claims on the output, matched against a consumer's `requires`.
    provides: dict[str, Any] = {}

    def __init_subclass__(cls, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)

        # Abstract intermediate base classes opt out of validation.
        if getattr(cls, "__abstract_transform__", False):
            return

        for attr in ("name", "stage", "output", "config_model"):
            if getattr(cls, attr, None) is None:
                raise TransformDefinitionError(f"{cls.__name__} must define `{attr}`")

        expected = STAGE_OUTPUT[cls.stage]
        if cls.output != expected:
            raise TransformDefinitionError(
                f"{cls.__name__}: stage '{cls.stage}' must output '{expected}', "
                f"got '{cls.output}'"
            )

        # A typo'd port name in `requires` would silently mean "no constraint",
        # which yields wrong retrieval rather than an error. Shape only — the
        # capability values themselves are the plugin author's business.
        for port_name, needed in cls.requires.items():
            if port_name not in cls.inputs:
                raise TransformDefinitionError(
                    f"{cls.__name__}: requires['{port_name}'] names no declared "
                    f"input port. Valid ports: {sorted(cls.inputs) or 'none'}"
                )
            if not isinstance(needed, dict):
                raise TransformDefinitionError(
                    f"{cls.__name__}: requires['{port_name}'] must be a dict of "
                    f"capabilities, got {type(needed).__name__}"
                )

        if not isinstance(cls.provides, dict):
            raise TransformDefinitionError(
                f"{cls.__name__}: `provides` must be a dict, got "
                f"{type(cls.provides).__name__}"
            )

        for field_name, field_info in cls.config_model.model_fields.items():
            if field_info.is_required():
                raise TransformDefinitionError(
                    f"{cls.__name__}: config field '{field_name}' has no default. "
                    "Every config field must be defaultable so a node can be "
                    "dropped into a graph and run immediately."
                )

    def fingerprint(self, config: C | None = None) -> str:
        """Model id, revision, and provider API version — folded into the
        artifact id. Returns 'none' for model-free transforms.

        The executor passes the *validated* config, because model identity is a
        function of it: which embedder a node selected decides which revision
        belongs in the recipe hash. `config` is optional so that the contract
        suite — and any other caller with no node in hand — can still ask a
        transform for its default-config fingerprint with `fingerprint()`.
        """
        return "none"

    @abstractmethod
    def apply(self, inputs: Mapping[str, Any], config: C, ctx: RunContext) -> Any:
        """Produce this transform's payload.

        `inputs` is keyed by port name and holds loaded upstream payloads (or a
        list of them, for a variadic port). `config` is a validated instance of
        `config_model`, so plugin code gets real attribute access and completion.
        """
