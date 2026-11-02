"""The `access:` block in pipeline.yaml."""

import pytest

from pandion.access import RULES, AccessConfig, FolderRule, access_rule
from pydantic import BaseModel

from pandion.config import ConfigError, from_dict, to_dict
from pandion.extend import ArtifactType, Stage, Transform, raw_file, register
from pandion.registry import registry

DATA = {
    "path": "./index",
    "index": {
        "parse": {"use": "pdfium"},
        "chunk": {"use": "recursive_character"},
        "embed": {"use": "fake-deterministic"},
        "store": {"use": "lancedb"},
    },
}


@pytest.fixture(autouse=True)
def clean_rules():
    before = set(RULES)
    yield
    for name in set(RULES) - before:
        del RULES[name]


def load(tmp_path, **extra):
    return from_dict({**DATA, **extra}, base=tmp_path)


def test_a_pipeline_without_access_has_access_off(tmp_path):
    assert load(tmp_path).access is None


def test_the_access_block_loads_with_default_folders_and_rules(tmp_path):
    access_rule("sharepoint")(lambda i: None)
    config = load(tmp_path, access={
        "default": ["staff"], "folders": [{"match": "hr/**", "roles": ["hr"]}], "rules": ["sharepoint"],
    })
    assert config.access == AccessConfig(["staff"], [FolderRule("hr/**", ["hr"])], ["sharepoint"])


def test_an_unknown_access_key_is_named(tmp_path):
    with pytest.raises(ConfigError, match="'roles'"):
        load(tmp_path, access={"roles": ["x"]})


@pytest.mark.parametrize("access", [
    {"default": "staff"},
    {"default": [""]},
    {"folders": [{"match": "a", "roles": "hr"}]},
    {"folders": [{"match": "a", "roles": [1]}]},
    {"folders": [{"roles": ["hr"]}]},
])
def test_roles_that_are_not_a_list_of_text_are_refused(tmp_path, access):
    with pytest.raises(ConfigError):
        load(tmp_path, access=access)


def test_a_rule_that_is_not_registered_refuses_the_file(tmp_path):
    with pytest.raises(ConfigError, match=r"nope.*plugins:"):
        load(tmp_path, access={"rules": ["nope"]})


def test_to_dict_round_trips_the_access_block(tmp_path):
    access = {"default": ["staff"], "folders": [{"match": "hr/**", "roles": ["hr"]}]}
    config = load(tmp_path, access=access)
    assert to_dict(config)["access"] == access
    assert from_dict(to_dict(config), base=tmp_path).access == config.access


def test_a_file_without_access_gives_the_same_to_dict_as_before(tmp_path):
    assert "access" not in to_dict(load(tmp_path))


class _Settings(BaseModel):
    location: str = ""


class _OtherSource(Transform[_Settings]):
    name = "test_access_other_source"
    stage = Stage.SOURCE
    output = ArtifactType.RAW_FILE
    config_model = _Settings
    summary = "A source that is not the upload source."

    def apply(self, inputs, config, ctx):
        return raw_file(ctx, b"x", "x.txt")


def test_access_with_a_source_step_other_than_upload_is_a_config_error(tmp_path):
    from pandion.plugins import discover

    discover()
    register(_OtherSource)
    try:
        data = {**DATA, "index": {**DATA["index"], "source": {"use": "test_access_other_source"}}}
        with pytest.raises(ConfigError, match="upload source"):
            from_dict({**data, "access": {"default": ["staff"]}}, base=tmp_path)
        assert from_dict(data, base=tmp_path).access is None
    finally:
        registry._by_stage[Stage.SOURCE].pop(_OtherSource.name, None)
