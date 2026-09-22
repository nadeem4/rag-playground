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
import types
from typing import Any, Literal, Union, get_args, get_origin

import pytest

from core.artifacts import ArtifactType
from core.ids import compute_artifact_id
from core.ports import STAGE_OUTPUT, PortSpec, Stage
from core.registry import registry
from core.transform import Explanation, Transform
from pydantic import ValidationError

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


def test_fingerprint_accepts_the_config(cls):
    """The executor ALWAYS calls `fingerprint(config)`.

    A plugin declaring `fingerprint(self)` typechecks, passes every other
    contract test, and then dies with a TypeError the first time its node is
    executed — the transform is simply unrunnable. This caught exactly that in
    `rerank/mmr`, which had never executed through the executor.

    Both arities must work: no-arg for callers that have no config in hand,
    and with-config for the executor.
    """
    inst = cls()
    bare = inst.fingerprint()
    with_config = inst.fingerprint(cls.config_model())
    assert isinstance(bare, str) and bare
    assert isinstance(with_config, str) and with_config


def test_artifact_id_is_deterministic(cls):
    inst = cls()
    kw = dict(
        transform_name=cls.name,
        transform_version=cls.version,
        fingerprint=inst.fingerprint(cls.config_model()),
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


# ---------------------------------------------------------------------------
# I-11: every plugin explains itself
# ---------------------------------------------------------------------------


def test_summary_is_non_empty(cls):
    assert isinstance(cls.summary, str) and cls.summary.strip(), (
        f"{ids(cls)}: `summary` must say how this strategy works"
    )


def test_explain_is_implemented_by_the_plugin(cls):
    assert cls.explain is not Transform.explain, (
        f"{ids(cls)}: must override `explain(config)`; the base default says "
        "nothing about the plugin's own settings"
    )


def test_explain_default_config_has_settings_text(cls):
    exp = cls().explain(cls.config_model())
    assert isinstance(exp, Explanation)
    assert exp.settings.strip(), f"{ids(cls)}: explain().settings is empty"


def test_explanation_text_has_no_em_dashes(cls):
    exp = cls().explain(cls.config_model())
    for text in (cls.summary, exp.settings, exp.tradeoff, exp.warning):
        assert "—" not in (text or ""), f"{ids(cls)}: em-dash in {text!r}"


def test_explain_exemptions_name_real_fields(cls):
    exempt = getattr(cls, "EXPLAIN_EXEMPT", frozenset())
    unknown = set(exempt) - set(cls.config_model.model_fields)
    assert not unknown, f"{ids(cls)}: EXPLAIN_EXEMPT names unknown fields {unknown}"


def _unwrap_optional(annotation: Any) -> tuple[Any, bool]:
    args = get_args(annotation)
    if get_origin(annotation) in (Union, types.UnionType) and type(None) in args:
        rest = [a for a in args if a is not type(None)]
        return rest[0], True
    return annotation, False


def _candidates(annotation: Any, default: Any) -> list[Any] | None:
    """Other valid-looking values for a field, or None when the field is not a
    number, a bool or a multi-value Literal (strings are free text)."""
    inner, optional = _unwrap_optional(annotation)
    out: list[Any] = []
    if inner is bool:
        out = [not default]
    elif get_origin(inner) is Literal:
        values = list(get_args(inner))
        if len(values) < 2:
            return None
        out = [v for v in values if v != default]
    elif inner in (int, float):
        step = 1 if inner is int else 0.1
        if default is None:
            out = [256, 64, 1] if inner is int else [0.5]
        else:
            out = [default + step, default - step, default * 2]
            if inner is float:
                out = [round(v, 6) for v in out]
    else:
        return None
    if optional and default is not None:
        out = [None] + out
    return out


def _valid(cls, field: str, value: Any) -> Any | None:
    try:
        return cls.config_model(**{field: value})
    except ValidationError:
        return None


def test_explain_is_setting_aware(cls):
    """Change each number, bool or multi-value choice from its default to other
    valid values: every change must change the explanation, unless the plugin
    exempts the field in `EXPLAIN_EXEMPT` with a reason."""
    exempt = getattr(cls, "EXPLAIN_EXEMPT", frozenset())
    inst = cls()
    base = inst.explain(cls.config_model()).model_dump()
    for name, info in cls.config_model.model_fields.items():
        if name in exempt:
            continue
        candidates = _candidates(info.annotation, info.default)
        if candidates is None:
            continue
        tried = 0
        for value in candidates:
            cfg = _valid(cls, name, value)
            if cfg is None:
                continue
            tried += 1
            changed = inst.explain(cfg).model_dump()
            assert changed != base, (
                f"{ids(cls)}: explain() ignores {name}={value!r} "
                f"(default {info.default!r})"
            )
        assert tried, f"{ids(cls)}: found no valid alternative for {name}"


# ---------------------------------------------------------------------------
# I-22: every setting teaches itself (Learn mode)
# ---------------------------------------------------------------------------

#: Stages whose plugins must carry `learn` for the strategy and every setting.
#: Add a stage here once its lesson text is written; the checks below then
#: cover it with no other change.
LEARN_REQUIRED: frozenset[Stage] = frozenset({Stage.CHUNK})

#: A sentence end followed by the start of another sentence.
_SENTENCE_BREAK = re.compile(r"[.!?]\s+\S")


def _learn_texts(cls) -> list[str]:
    return [
        text
        for lesson in cls.learn.values()
        for text in (lesson["hint"], *lesson["more"])
    ]


def test_learn_covers_the_strategy_and_every_setting(cls):
    if cls.stage not in LEARN_REQUIRED:
        return
    expected = {"_strategy", *cls.config_model.model_fields}
    assert set(cls.learn) == expected, (
        f"{ids(cls)}: `learn` must have exactly {sorted(expected)}, "
        f"got {sorted(cls.learn)}"
    )


def test_learn_entries_are_a_hint_plus_more(cls):
    for key, lesson in cls.learn.items():
        assert set(lesson) == {"hint", "more"}, f"{ids(cls)}: learn[{key!r}]"
        assert isinstance(lesson["hint"], str) and lesson["hint"].strip()
        assert isinstance(lesson["more"], list)
        assert all(isinstance(p, str) and p.strip() for p in lesson["more"])


def test_learn_hint_is_exactly_one_sentence(cls):
    for key, lesson in cls.learn.items():
        assert not _SENTENCE_BREAK.search(lesson["hint"]), (
            f"{ids(cls)}: learn[{key!r}] hint must be one sentence: "
            f"{lesson['hint']!r}"
        )


def test_learn_text_ends_with_a_full_stop(cls):
    for text in _learn_texts(cls):
        assert text.endswith("."), f"{ids(cls)}: no full stop at the end of {text!r}"


def test_learn_text_has_no_em_or_en_dashes(cls):
    for text in _learn_texts(cls):
        assert "—" not in text and "–" not in text, (
            f"{ids(cls)}: dash in {text!r}"
        )
