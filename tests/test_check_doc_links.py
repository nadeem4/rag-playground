"""The doc link checker finds broken relative links and anchors in Markdown files."""

import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "check_doc_links", Path(__file__).resolve().parents[1] / "scripts" / "check_doc_links.py"
)
cdl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cdl)

GH = "https://github.com/nadeem4/rag-playground"


def _repo(tmp_path, files):
    for name, text in files.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return tmp_path


def _reasons(root):
    return [(p.file, p.target) for p in cdl.check(root)]


def test_good_links_pass(tmp_path):
    root = _repo(
        tmp_path,
        {
            "README.md": "See [guide](docs/guide.md#set-up) and [dir](docs/).\n",
            "docs/guide.md": "# Guide\n\n## Set up\n",
        },
    )
    assert cdl.check(root) == []


def test_missing_file_is_reported_with_line(tmp_path):
    root = _repo(tmp_path, {"README.md": "ok\n\n[gone](docs/gone.md)\n"})
    problems = cdl.check(root)
    assert [(p.file, p.line, p.target) for p in problems] == [("README.md", 3, "docs/gone.md")]


def test_missing_anchor_is_reported(tmp_path):
    root = _repo(
        tmp_path,
        {"README.md": "[x](docs/guide.md#nope)\n", "docs/guide.md": "# Guide\n"},
    )
    assert _reasons(root) == [("README.md", "docs/guide.md#nope")]


def test_same_file_anchor_is_checked(tmp_path):
    root = _repo(tmp_path, {"README.md": "# Top\n\n[ok](#top) [bad](#bottom)\n"})
    assert _reasons(root) == [("README.md", "#bottom")]


def test_anchor_follows_github_rules(tmp_path):
    root = _repo(
        tmp_path,
        {
            "README.md": (
                "# What is this, and why?\n\n## The `code` thing\n\n"
                "[a](#what-is-this-and-why) [b](#the-code-thing)\n"
            )
        },
    )
    assert cdl.check(root) == []


def test_duplicate_headings_get_numeric_suffix(tmp_path):
    root = _repo(
        tmp_path,
        {"README.md": "# Setup\n\n# Setup\n\n[a](#setup) [b](#setup-1) [c](#setup-2)\n"},
    )
    assert _reasons(root) == [("README.md", "#setup-2")]


def test_links_in_code_fences_and_inline_code_are_ignored(tmp_path):
    root = _repo(
        tmp_path,
        {"README.md": "```\n[x](nope.md)\n```\n\nUse `[y](nope2.md)` here.\n"},
    )
    assert cdl.check(root) == []


def test_external_and_mail_links_are_skipped(tmp_path):
    root = _repo(tmp_path, {"README.md": "[a](https://example.com/x) [b](mailto:a@b.co)\n"})
    assert cdl.check(root) == []


def test_github_main_url_maps_to_local_file(tmp_path):
    root = _repo(
        tmp_path,
        {
            "README.md": (
                f"[ok]({GH}/blob/main/docs/g.md#top) "
                f"[bad]({GH}/blob/main/docs/none.md) [t]({GH}/tree/main/docs)\n"
            ),
            "docs/g.md": "# Top\n",
        },
    )
    assert _reasons(root) == [("README.md", f"{GH}/blob/main/docs/none.md")]


def test_html_href_is_checked(tmp_path):
    root = _repo(tmp_path, {"README.md": '<a href="nope.md">x</a>\n'})
    assert _reasons(root) == [("README.md", "nope.md")]


def test_main_prints_problems_and_exits_one(tmp_path, capsys):
    root = _repo(tmp_path, {"README.md": "[gone](gone.md)\n"})
    assert cdl.main(["--root", str(root)]) == 1
    assert "README.md:1: gone.md: file not found" in capsys.readouterr().out


def test_main_exits_zero_when_clean(tmp_path):
    root = _repo(tmp_path, {"README.md": "# Hi\n"})
    assert cdl.main(["--root", str(root)]) == 0


def test_reference_definitions_are_checked(tmp_path):
    root = _repo(tmp_path, {"README.md": "[a][ref]\n\n[ref]: nope.md\n[^1]: a footnote\n"})
    assert _reasons(root) == [("README.md", "nope.md")]


def test_nested_image_link_checks_the_outer_target(tmp_path):
    root = _repo(tmp_path, {"README.md": "[![b](README.md)](missing.md)\n"})
    assert _reasons(root) == [("README.md", "missing.md")]


def test_link_text_that_wraps_lines_is_checked(tmp_path):
    root = _repo(tmp_path, {"README.md": "# T\n\nsee [a long\ntext](missing.md)\n"})
    problems = cdl.check(root)
    assert [(p.line, p.target) for p in problems] == [(4, "missing.md")]


def test_anchor_case_is_exact(tmp_path):
    root = _repo(tmp_path, {"README.md": "## a_b\n\n[ok](#a_b) [bad](#A_B)\n"})
    assert _reasons(root) == [("README.md", "#A_B")]


def test_non_ascii_file_names_are_checked(tmp_path):
    import subprocess

    root = _repo(tmp_path, {"café.md": "[gone](gone.md)\n"})
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "add", "-A"], cwd=root, check=True)
    assert _reasons(root) == [("café.md", "gone.md")]
