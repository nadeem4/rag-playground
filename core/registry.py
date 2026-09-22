"""Plugin registry and the schema export the UI renders forms from.

Adding a strategy is one file plus one decorator. The frontend reads
`export_schema()` and generates every config form from the Pydantic JSON Schema,
so no frontend change is needed for a new plugin.
"""

from __future__ import annotations

from typing import Any

from core.ports import STACKABLE, Stage
from core.transform import Transform


class DuplicateTransformError(ValueError):
    pass


class UnknownTransformError(KeyError):
    pass


class Registry:
    """Stage-scoped name lookup. Two stages may reuse a name; one stage may not."""

    def __init__(self) -> None:
        self._by_stage: dict[Stage, dict[str, type[Transform]]] = {}

    def register(self, cls: type[Transform]) -> type[Transform]:
        bucket = self._by_stage.setdefault(cls.stage, {})
        if cls.name in bucket:
            raise DuplicateTransformError(
                f"{cls.stage}/{cls.name} is already registered by "
                f"{bucket[cls.name].__name__}"
            )
        bucket[cls.name] = cls
        return cls

    def get(self, stage: Stage, name: str) -> type[Transform]:
        try:
            return self._by_stage[stage][name]
        except KeyError as exc:
            raise UnknownTransformError(f"{stage}/{name}") from exc

    def all_for(self, stage: Stage) -> dict[str, type[Transform]]:
        return dict(self._by_stage.get(stage, {}))

    def stages(self) -> list[Stage]:
        return list(self._by_stage)

    def clear(self) -> None:
        self._by_stage.clear()

    def export_schema(self) -> dict[str, Any]:
        """Everything the frontend needs to render the pipeline builder."""
        out: dict[str, Any] = {}
        for stage, bucket in self._by_stage.items():
            out[str(stage)] = {
                name: {
                    "name": name,
                    "version": cls.version,
                    "summary": cls.summary,
                    "stage": str(stage),
                    "output": str(cls.output),
                    "stackable": stage in STACKABLE,
                    "deterministic": cls.deterministic,
                    "cacheable": cls.cacheable,
                    "requires": cls.requires,
                    "provides": cls.provides,
                    "inputs": {
                        port_name: {
                            "type": str(port.type),
                            "variadic": port.variadic,
                            "ambient": port.ambient,
                            "required": port.required,
                        }
                        for port_name, port in cls.inputs.items()
                    },
                    "config_schema": cls.config_model.model_json_schema(),
                }
                for name, cls in bucket.items()
            }
        return out


#: The process-wide registry that the `@register` decorator writes to.
registry = Registry()


def register(cls: type[Transform]) -> type[Transform]:
    return registry.register(cls)
