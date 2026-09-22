import pytest
from pydantic import BaseModel

from core.artifacts import ArtifactType
from core.ports import PortSpec, RunContext, Stage
from core.transform import Transform, TransformDefinitionError


class DummyConfig(BaseModel):
    size: int = 512


def make_valid():
    class Valid(Transform[DummyConfig]):
        summary = "A test transform."
        name = "valid"
        stage = Stage.CHUNK
        inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
        output = ArtifactType.CHUNK_SET
        config_model = DummyConfig

        def apply(self, inputs, config, ctx):
            return {"chunks": [], "size": config.size}

    return Valid


def test_valid_subclass_inherits_defaults():
    v = make_valid()()
    assert v.version == "1"
    assert v.deterministic is True
    assert v.cacheable is True
    assert v.requires == {}
    assert v.provides == {}
    assert v.fingerprint() == "none"


def test_missing_name_raises_at_definition_time():
    with pytest.raises(TransformDefinitionError, match="name"):

        class NoName(Transform[DummyConfig]):
            summary = "A test transform."
            stage = Stage.CHUNK
            inputs = {}
            output = ArtifactType.CHUNK_SET
            config_model = DummyConfig

            def apply(self, inputs, config, ctx):
                return None


def test_missing_config_model_raises():
    with pytest.raises(TransformDefinitionError, match="config_model"):

        class NoConfig(Transform):
            summary = "A test transform."
            name = "x"
            stage = Stage.CHUNK
            inputs = {}
            output = ArtifactType.CHUNK_SET

            def apply(self, inputs, config, ctx):
                return None


def test_config_model_must_have_all_defaults():
    """A node must be droppable into a graph and runnable immediately."""

    class Required(BaseModel):
        size: int  # no default

    with pytest.raises(TransformDefinitionError, match="default"):

        class NeedsArg(Transform[Required]):
            summary = "A test transform."
            name = "needs_arg"
            stage = Stage.CHUNK
            inputs = {}
            output = ArtifactType.CHUNK_SET
            config_model = Required

            def apply(self, inputs, config, ctx):
                return None


def test_stage_must_be_consistent_with_output_type():
    with pytest.raises(TransformDefinitionError, match="stage"):

        class Wrong(Transform[DummyConfig]):
            summary = "A test transform."
            name = "wrong"
            stage = Stage.CHUNK
            inputs = {}
            output = ArtifactType.INDEX  # chunk stage must output chunk_set
            config_model = DummyConfig

            def apply(self, inputs, config, ctx):
                return None


def test_abstract_apply_cannot_be_instantiated():
    class NoApply(Transform[DummyConfig]):
        summary = "A test transform."
        name = "no_apply"
        stage = Stage.CHUNK
        inputs = {}
        output = ArtifactType.CHUNK_SET
        config_model = DummyConfig

    with pytest.raises(TypeError):
        NoApply()


def test_abstract_intermediate_base_opts_out_of_validation():
    """A shared base for a family of plugins should not need name/stage."""

    class SomeBase(Transform):
        summary = "A test transform."
        __abstract_transform__ = True

        def helper(self):
            return 42


def test_requires_naming_an_undeclared_port_raises():
    """A typo'd port name would silently mean 'no constraint'."""
    with pytest.raises(TransformDefinitionError) as exc:

        class Typo(Transform[DummyConfig]):
            summary = "A test transform."
            name = "typo"
            stage = Stage.RETRIEVE
            inputs = {"index": PortSpec(ArtifactType.INDEX)}
            output = ArtifactType.RETRIEVAL_RESULT
            config_model = DummyConfig
            requires = {"indx": {"backends": ["fts"]}}

            def apply(self, inputs, config, ctx):
                return None

    message = str(exc.value)
    assert "indx" in message
    assert "index" in message


def test_requires_with_a_non_dict_value_raises():
    """`{"doc": ["text"]}` is the old flat shape, not a per-port contract."""
    with pytest.raises(TransformDefinitionError, match="requires"):

        class Flat(Transform[DummyConfig]):
            summary = "A test transform."
            name = "flat"
            stage = Stage.CHUNK
            inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
            output = ArtifactType.CHUNK_SET
            config_model = DummyConfig
            requires = {"doc": ["text"]}

            def apply(self, inputs, config, ctx):
                return None


def test_well_formed_nested_requires_is_accepted():
    class Nested(Transform[DummyConfig]):
        summary = "A test transform."
        name = "nested"
        stage = Stage.RETRIEVE
        inputs = {"index": PortSpec(ArtifactType.INDEX)}
        output = ArtifactType.RETRIEVAL_RESULT
        config_model = DummyConfig
        requires = {"index": {"backends": ["fts"]}}

        def apply(self, inputs, config, ctx):
            return None

    assert Nested.requires == {"index": {"backends": ["fts"]}}


def test_empty_requires_is_accepted():
    assert make_valid().requires == {}


def test_provides_must_be_a_dict():
    """`provides` is flat — it describes the single output."""
    with pytest.raises(TransformDefinitionError, match="provides"):

        class BadProvides(Transform[DummyConfig]):
            summary = "A test transform."
            name = "bad_provides"
            stage = Stage.INDEX
            inputs = {}
            output = ArtifactType.INDEX
            config_model = DummyConfig
            provides = ["fts"]

            def apply(self, inputs, config, ctx):
                return None


def test_portspec_defaults():
    port = PortSpec(ArtifactType.QUERY)
    assert port.variadic is False
    assert port.ambient is False
    assert port.required is True


def test_apply_receives_typed_config(tmp_path):
    ctx = RunContext(output_dir=tmp_path, emit=lambda e: None, tmp=tmp_path)
    out = make_valid()().apply({}, DummyConfig(size=256), ctx)
    assert out["size"] == 256
