"""I-11 core: stage explanations, `summary`, `Explanation` and the schema export."""

from __future__ import annotations

import pytest
from pydantic import BaseModel

from core.artifacts import ArtifactType
from core.ports import STAGE_WHAT, Stage
from core.registry import Registry
from core.transform import Explanation, Transform, TransformDefinitionError


class Cfg(BaseModel):
    size: int = 3


def test_every_stage_explains_what_it_is_for():
    assert set(STAGE_WHAT) == set(Stage)
    for stage, text in STAGE_WHAT.items():
        assert text.strip(), stage
        assert "—" not in text, stage


def test_explanation_defaults():
    exp = Explanation(settings="Pieces of 3.")
    assert exp.model_dump() == {
        "settings": "Pieces of 3.",
        "tradeoff": None,
        "warning": None,
        "blocking": False,
    }


@pytest.mark.parametrize("summary", [None, "", "   "])
def test_a_transform_without_a_summary_is_rejected(summary):
    namespace = {
        "name": "nosummary",
        "stage": Stage.CHUNK,
        "output": ArtifactType.CHUNK_SET,
        "config_model": Cfg,
        "apply": lambda self, inputs, config, ctx: None,
    }
    if summary is not None:
        namespace["summary"] = summary
    with pytest.raises(TransformDefinitionError, match="summary"):
        type("NoSummary", (Transform,), namespace)


def _make():
    class WithSummary(Transform[Cfg]):
        name = "with_summary"
        stage = Stage.CHUNK
        output = ArtifactType.CHUNK_SET
        config_model = Cfg
        summary = "Cuts text into pieces."

        def apply(self, inputs, config, ctx):
            return None

    return WithSummary


def test_base_explain_returns_an_explanation():
    cls = _make()
    exp = cls().explain(Cfg())
    assert isinstance(exp, Explanation)
    assert exp.settings.strip()


def test_export_schema_carries_summary():
    reg = Registry()
    reg.register(_make())
    assert reg.export_schema()["chunk"]["with_summary"]["summary"] == (
        "Cuts text into pieces."
    )
