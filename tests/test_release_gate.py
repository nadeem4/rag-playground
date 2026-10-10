"""The production gate: only a plain release tag, and only a commit staging has verified."""

import importlib.util
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "release_gate", Path(__file__).resolve().parents[1] / "scripts" / "release_gate.py"
)
rg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rg)


@pytest.mark.parametrize("tag", ["v0.33.0", "v1.0.0", "v12.4.105"])
def test_plain_version_tags_are_release_tags(tag):
    assert rg.is_release_tag(tag)
    rg.check_tag(tag)


@pytest.mark.parametrize("tag", ["0.33.0", "v0.33", "v0.33.0-rc.1", "v0.33.0-beta", "latest", "main", ""])
def test_production_refuses_anything_but_a_plain_version_tag(tag):
    assert not rg.is_release_tag(tag)
    with pytest.raises(rg.GateClosed, match="plain version tag"):
        rg.check_tag(tag)


def test_staging_passed_reads_the_newest_staging_status():
    # GitHub lists a commit's statuses newest first.
    ok = [{"context": "staging", "state": "success"}, {"context": "ci", "state": "failure"}]
    assert rg.staging_passed(ok)
    redone_and_failed = [{"context": "staging", "state": "failure"}, {"context": "staging", "state": "success"}]
    assert not rg.staging_passed(redone_and_failed)
    assert not rg.staging_passed([{"context": "ci", "state": "success"}])
    assert not rg.staging_passed([])


def test_check_staging_says_what_to_do():
    with pytest.raises(rg.GateClosed, match="Publish this commit to staging and test it first"):
        rg.check_staging([])
    rg.check_staging([{"context": "staging", "state": "success"}])
