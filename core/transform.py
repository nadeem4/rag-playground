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

    #: Capability predicate on input ports, checked at graph validation.
    #: A bm25 retriever declares requires = {"backends": ["fts"]} so it cannot be
    #: wired to a dense-only index — a type-legal edge that would otherwise fail
    #: at run time, or worse, return silent garbage.
    requires: dict[str, Any] = {}

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

        for field_name, field_info in cls.config_model.model_fields.items():
            if field_info.is_required():
                raise TransformDefinitionError(
                    f"{cls.__name__}: config field '{field_name}' has no default. "
                    "Every config field must be defaultable so a node can be "
                    "dropped into a graph and run immediately."
                )

    def fingerprint(self) -> str:
        """Model id, revision, and provider API version — folded into the
        artifact id. Returns 'none' for model-free transforms."""
        return "none"

    @abstractmethod
    def apply(self, inputs: Mapping[str, Any], config: C, ctx: RunContext) -> Any:
        """Produce this transform's payload.

        `inputs` is keyed by port name and holds loaded upstream payloads (or a
        list of them, for a variadic port). `config` is a validated instance of
        `config_model`, so plugin code gets real attribute access and completion.
        """
