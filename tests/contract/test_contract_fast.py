"""The fast half of the contract suite.

Runs over EVERY transform in the global registry and never calls `apply()`, so
it stays in the milliseconds and needs no models, no network and no fixtures.
Every future plugin is covered the moment it registers.

In Phase 1 the global registry is empty, so `all_transforms()` returns `[]` and
pytest turns each parametrized test into a single skip ("got empty parameter
set"). That is the intended Phase 1 result: the harness is wired and lights up
automatically when the first real plugin registers.
"""

from __future__ import annotations

import json
import re

import pytest

from core.artifacts import ArtifactType
from core.ids import compute_artifact_id
from core.ports import STAGE_OUTPUT, PortSpec
from core.registry import registry
from core.transform import Transform

IDENT = re.compile(r"^[a-z][a-z0-9_]*$")


def all_transforms() -> list[type[Transform]]:
    """Every registered transform, across every stage.

    Iterates `STAGE_OUTPUT` rather than the registry's own stage keys so a stage
    that exists but holds nothing is handled identically to one never touched.
    """
    out: list[type[Transform]] = []
    for stage in STAGE_OUTPUT:
        out.extend(registry.all_for(stage).values())
    return out


def ids(cls: type[Transform]) -> str:
    return f"{cls.stage}/{cls.name}"


#: Collected once, at import time. A plugin that registers during collection of
#: a *later* module would be missed — plugins must register on import of the
#: package, which is how the registry decorator works.
pytestmark = pytest.mark.parametrize(
    "cls", all_transforms(), ids=lambda c: f"{c.stage}-{c.name}"
)


def test_name_is_a_valid_identifier(cls):
    assert IDENT.match(cls.name), f"{ids(cls)}: name must be snake_case"


def test_version_is_present(cls):
    assert isinstance(cls.version, str) and cls.version, (
        f"{ids(cls)}: version must be a non-empty string"
    )


def test_stage_matches_output_type(cls):
    assert cls.output == STAGE_OUTPUT[cls.stage], (
        f"{ids(cls)}: stage '{cls.stage}' must output "
        f"'{STAGE_OUTPUT[cls.stage]}', got '{cls.output}'"
    )


def test_input_ports_are_wellformed(cls):
    for port_name, port in cls.inputs.items():
        assert IDENT.match(port_name), f"{ids(cls)}: bad port name '{port_name}'"
        assert isinstance(port, PortSpec), (
            f"{ids(cls)}: port '{port_name}' is not a PortSpec"
        )
        assert isinstance(port.type, ArtifactType), (
            f"{ids(cls)}: port '{port_name}' has a non-ArtifactType type"
        )


def test_every_config_field_has_a_default(cls):
    for field_name, field_info in cls.config_model.model_fields.items():
        assert not field_info.is_required(), (
            f"{ids(cls)}: config field '{field_name}' has no default"
        )


def test_config_instantiates_with_no_arguments(cls):
    cls.config_model()


def test_schema_is_json_serializable_and_ref_free(cls):
    schema = cls.config_model.model_json_schema()
    blob = json.dumps(schema)
    if "$ref" in blob:
        assert "$defs" in schema, (
            f"{ids(cls)}: schema has a $ref with no $defs to resolve it"
        )


def test_config_roundtrips_through_json(cls):
    cfg = cls.config_model()
    dumped = cfg.model_dump(mode="json")
    assert cls.config_model(**dumped).model_dump(mode="json") == dumped


def test_artifact_id_is_deterministic(cls):
    inst = cls()
    kw = dict(
        transform_name=cls.name,
        transform_version=cls.version,
        fingerprint=inst.fingerprint(),
        output_type=cls.output,
        config=cls.config_model().model_dump(mode="json"),
        inputs={port_name: "0" * 64 for port_name in cls.inputs},
    )
    assert compute_artifact_id(**kw) == compute_artifact_id(**kw)


def test_determinism_and_cacheability_are_declared(cls):
    assert isinstance(cls.deterministic, bool), (
        f"{ids(cls)}: `deterministic` must be a bool"
    )
    assert isinstance(cls.cacheable, bool), f"{ids(cls)}: `cacheable` must be a bool"
