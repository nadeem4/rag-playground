"""Roles per document: the resolver chain and @access_rule."""

import pytest

from pandion.access import RULES, AccessConfig, AccessDenied, FolderRule, access_rule, resolve_roles
from pandion.docinfo import DocumentInfo
from pandion.registry import DuplicateTransformError


def info(path="", metadata=None):
    return DocumentInfo(
        filename="a.txt", type="txt", size=1, path=path, metadata=metadata or {}, properties={},
        page_count=None, text_layer=None, first_page_text="",
    )


@pytest.fixture(autouse=True)
def clean_rules():
    before = set(RULES)
    yield
    for name in set(RULES) - before:
        del RULES[name]


def cfg(**kw):
    return AccessConfig(**kw)


def test_file_metadata_roles_win_over_a_folder_rule():
    access = cfg(default=["staff"], folders=[FolderRule("hr/**", ["hr"])])
    got = resolve_roles("hr/a.txt", info(metadata={"roles": "ops"}), access)
    assert got.roles == ["ops"] and got.reason == "file metadata"


def test_a_folder_rule_wins_over_the_default():
    access = cfg(default=["staff"], folders=[FolderRule("hr/**", ["hr"])])
    got = resolve_roles("HR/a.txt", info(), access)
    assert got.roles == ["hr"] and got.reason == "folder rule hr/**"


def test_the_first_matching_folder_rule_wins():
    access = cfg(folders=[FolderRule("hr/**", ["hr"]), FolderRule("**", ["all"])])
    assert resolve_roles("hr/x/a.txt", info(), access).roles == ["hr"]
    assert resolve_roles("other/a.txt", info(), access).roles == ["all"]


def test_a_rule_returning_none_falls_through_to_the_default():
    access_rule("nobody")(lambda i: None)
    got = resolve_roles("a.txt", info(), cfg(default=["staff"], rules=["nobody"]))
    assert got.roles == ["staff"] and got.reason == "default"


def test_a_rule_gives_roles():
    access_rule("team")(lambda i: ["eng"])
    got = resolve_roles("a.txt", info(), cfg(default=["staff"], rules=["team"]))
    assert got.roles == ["eng"] and got.reason == "access rule team"


def test_no_default_means_no_roles():
    assert resolve_roles("a.txt", info(), cfg()).roles == []


def test_a_failing_access_rule_gives_the_document_no_roles():
    def boom(i):
        raise RuntimeError("db down")

    access_rule("boom")(boom)
    got = resolve_roles("a.txt", info(), cfg(default=["staff"], rules=["boom"]))
    assert got.roles == [] and "RuntimeError" in got.reason and "db down" in got.reason


def test_a_rule_returning_a_string_instead_of_a_list_is_treated_as_failed():
    access_rule("bad")(lambda i: "staff")
    got = resolve_roles("a.txt", info(), cfg(default=["staff"], rules=["bad"]))
    assert got.roles == [] and "failed" in got.reason


def test_an_unregistered_rule_name_is_an_error():
    with pytest.raises(AccessDenied, match="The access rule 'x' is not registered"):
        resolve_roles("a.txt", info(), cfg(rules=["x"]))


def test_a_rule_name_registered_twice_names_both_modules():
    access_rule("dup")(lambda i: None)
    with pytest.raises(DuplicateTransformError, match="already registered"):
        access_rule("dup")(lambda i: None)


def test_metadata_roles_are_split_on_commas_and_trimmed():
    got = resolve_roles("a.txt", info(metadata={"roles": "hr, staff ,"}), cfg())
    assert got.roles == ["hr", "staff"]
