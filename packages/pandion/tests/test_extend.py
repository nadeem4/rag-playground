"""pandion.extend: everything a strategy author needs, public and stable."""

from pathlib import Path

import pytest
from pydantic import BaseModel

import pandion.extend as ext
from pandion.extend import ArtifactType, ParsedDoc, Element, PortSpec, Stage, Transform, register


def test_extend_exports_the_authoring_names():
    for name in ("Transform", "register", "Stage", "PortSpec", "ArtifactType", "RunContext",
                 "Explanation", "set_note", "set_usage", "ParsedDoc", "Element", "ChunkSet", "Chunk",
                 "Query", "Hit", "RetrievalResult", "Output"):
        assert name in ext.__all__ and hasattr(ext, name)


class NoSettings(BaseModel):
    pass


@pytest.fixture
def _forget_txt_lines():
    """Remove the test parser after the test, so no other test sees it."""
    yield
    from pandion.registry import registry

    registry._by_stage[Stage.PARSE].pop("test_txt_lines", None)


def test_a_minimal_outside_parser_registers_and_runs(tmp_path, _forget_txt_lines):
    @register
    class TxtLines(Transform[NoSettings]):
        name = "test_txt_lines"
        stage = Stage.PARSE
        inputs = {"file": PortSpec(ArtifactType.RAW_FILE)}
        output = ArtifactType.PARSED_DOC
        config_model = NoSettings
        summary = "One block per line of a text file."

        def apply(self, inputs, config, ctx):
            lines = [l for l in Path(inputs["file"]["path"]).read_text(encoding="utf-8").splitlines() if l.strip()]
            return ParsedDoc(elements=[Element(id=f"l{i}", type="paragraph", text=l, order=i)
                                       for i, l in enumerate(lines)])

    import pandion
    f = tmp_path / "a.txt"
    f.write_text("one\ntwo\n", encoding="utf-8")
    result = pandion.parse(f, use="test_txt_lines")
    assert [e.text for e in result.output.elements] == ["one", "two"]
    # explain() works without being written: the default lists the settings.
    assert TxtLines().explain(NoSettings()).settings


def test_registering_a_built_in_name_again_is_refused():
    from pandion.plugins import discover
    discover()
    with pytest.raises(ValueError, match="already"):
        @register
        class Again(Transform[NoSettings]):
            name = "pdfium"
            stage = Stage.PARSE
            inputs = {"file": PortSpec(ArtifactType.RAW_FILE)}
            output = ArtifactType.PARSED_DOC
            config_model = NoSettings
            summary = "A second pdfium."

            def apply(self, inputs, config, ctx):
                return ParsedDoc(elements=[])
