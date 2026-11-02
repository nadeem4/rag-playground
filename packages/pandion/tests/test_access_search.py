"""Roles on the rows, and searches that filter by them.

Two small PDFs, the fake embedder (no download), and the lancedb store.
"""

import json
from pathlib import Path

import lancedb
import pytest

from pandion import Pipeline
from pandion.manifest import MANIFEST
from pdfs import build_pdf

CONFIG = """\
path: ./index
models:
  device: cpu
index:
  parse: {{use: pdfium}}
  chunk: {{use: recursive_character, chunk_size: 70, chunk_overlap: 10}}
  embed: {{use: fake-deterministic}}
  store: {{use: lancedb}}
retrieve:
  search: {{use: {search}, top_k: 10}}
answer: {{use: search}}
{access}"""

ACCESS = """\
access:
  default: [staff]
  folders:
    - {{match: "{folder}/**", roles: [{roles}]}}
"""


def write(folder: Path, *, access: str = "", search: str = "dense") -> Path:
    file = folder / "pipeline.yaml"
    file.write_text(CONFIG.format(access=access, search=search), encoding="utf-8")
    return file


def folder_access(folder="hr", roles="hr") -> str:
    return ACCESS.format(folder=folder, roles=roles)


@pytest.fixture
def docs(tmp_path: Path) -> Path:
    docs = tmp_path / "docs"
    (docs / "hr").mkdir(parents=True)
    (docs / "hr" / "pay.pdf").write_bytes(build_pdf([["Salaries are paid on the last day of the month."]]))
    (docs / "handbook.pdf").write_bytes(build_pdf([["The office opens at nine every morning."]]))
    return docs


def rows(report) -> list[dict]:
    return lancedb.connect(report.index.output).open_table("chunks").to_arrow().to_pylist()


def manifest(folder: Path) -> dict:
    return json.loads((folder / "index" / MANIFEST).read_text(encoding="utf-8"))["documents"]


def roles_by_doc(report, folder: Path) -> dict[str, list[str]]:
    """The roles on the rows, by document id (a row holds the file's sha)."""
    by_sha = {e["content_hash"]: doc_id for doc_id, e in manifest(folder).items()}
    return {by_sha[r["doc_id"]]: list(r["roles"]) for r in rows(report)}


def test_rows_carry_the_roles_of_their_document(tmp_path, docs):
    config = write(tmp_path, access=folder_access())
    report = Pipeline.from_file(config).index.sync(docs)
    assert roles_by_doc(report, tmp_path) == {"hr/pay.pdf": ["hr"], "handbook.pdf": ["staff"]}


def test_the_manifest_records_roles_and_why(tmp_path, docs):
    config = write(tmp_path, access=folder_access())
    Pipeline.from_file(config).index.sync(docs)
    entries = manifest(tmp_path)
    assert entries["hr/pay.pdf"]["roles"] == ["hr"]
    assert entries["hr/pay.pdf"]["roles_reason"] == "folder rule hr/**"
    assert entries["handbook.pdf"]["roles"] == ["staff"]
    assert entries["handbook.pdf"]["roles_reason"] == "default"


def test_a_role_change_rebuilds_the_index_from_cached_chunks(tmp_path, docs):
    config = write(tmp_path, access=folder_access(roles="hr"))
    Pipeline.from_file(config).index.sync(docs)
    write(tmp_path, access=folder_access(roles="hr, legal"))
    report = Pipeline.from_file(config).index.sync(docs)
    assert all(d.stages["parse"].status == "cached" for d in report.documents.values())
    assert report.index.status == "executed"
    assert roles_by_doc(report, tmp_path)["hr/pay.pdf"] == ["hr", "legal"]
    assert report.config_changed is False


def test_without_an_access_block_nothing_changes(tmp_path, docs):
    config = write(tmp_path)
    pipeline = Pipeline.from_file(config)
    report = pipeline.index.sync(docs)
    entries = manifest(tmp_path)
    assert all("roles" not in e for e in entries.values())
    graph, _ = pipeline.index.graph(pipeline.index.indexed())
    assert "doc_roles" not in next(n for n in graph.nodes if n.id == "index").config
    assert all(r == [] for r in roles_by_doc(report, tmp_path).values())


# --- searches filter by roles and fail closed -------------------------------

from pandion.access import ALL_ROLES, AccessDenied
from pandion.filters import where_sql

QUESTION = "salaries office opens month morning"


def docs_found(result, folder: Path) -> set[str]:
    by_sha = {e["content_hash"]: doc_id for doc_id, e in manifest(folder).items()}
    return {by_sha[h.chunk.doc_id] for h in result.stages["search"].output.hits}


@pytest.fixture
def synced(tmp_path, docs):
    def make(search="dense", access=None):
        config = write(tmp_path, access=folder_access() if access is None else access, search=search)
        Pipeline.from_file(config).index.sync(docs)
        return Pipeline.from_file(config)

    return make


@pytest.mark.parametrize("search", ["dense", "bm25", "hybrid_rrf"])
def test_a_user_sees_only_chunks_of_their_roles(tmp_path, synced, search):
    p = synced(search)
    assert docs_found(p.retrieve(QUESTION, roles=["staff"]), tmp_path) == {"handbook.pdf"}
    assert docs_found(p.retrieve(QUESTION, roles=["hr"]), tmp_path) == {"hr/pay.pdf"}
    assert docs_found(p.retrieve(QUESTION, roles=["hr", "staff"]), tmp_path) == {"hr/pay.pdf", "handbook.pdf"}


def test_a_row_with_no_roles_is_never_returned(tmp_path, synced):
    p = synced(access="access:\n  default: []\n")
    assert docs_found(p.retrieve(QUESTION, roles=["staff", "hr"]), tmp_path) == set()


def test_roles_empty_list_finds_nothing(tmp_path, synced):
    assert docs_found(synced().retrieve(QUESTION, roles=[]), tmp_path) == set()


def test_access_on_and_no_roles_is_refused(synced):
    events = []
    with pytest.raises(AccessDenied, match="needs the user's roles"):
        synced().retrieve(QUESTION, on_event=events.append)
    with pytest.raises(AccessDenied):
        synced().ask(QUESTION)
    assert events == []


def test_access_off_ignores_roles(tmp_path, synced):
    p = synced(access="")
    assert docs_found(p.retrieve(QUESTION, roles=["nobody"]), tmp_path) == {"hr/pay.pdf", "handbook.pdf"}
    assert docs_found(p.retrieve(QUESTION), tmp_path) == {"hr/pay.pdf", "handbook.pdf"}


def test_all_roles_sees_everything(tmp_path, synced):
    assert docs_found(synced().retrieve(QUESTION, roles=ALL_ROLES), tmp_path) == {"hr/pay.pdf", "handbook.pdf"}


def test_two_users_with_different_roles_get_different_cached_answers(tmp_path, synced):
    p = synced()
    first = p.retrieve(QUESTION, roles=["hr"])
    second = p.retrieve(QUESTION, roles=["staff"])
    assert first.stages["search"].artifact_id != second.stages["search"].artifact_id
    again = p.retrieve(QUESTION, roles=["hr"])
    assert again.stages["search"].artifact_id == first.stages["search"].artifact_id
    assert again.stages["search"].status == "cached"


def test_where_sql_adds_the_roles_condition_and_quotes_it():
    assert where_sql({"roles": ["o'k", "hr"]}, {}) == "(array_has_any(roles, ['o''k', 'hr']))"
    assert where_sql({"roles": []}, {}) == "(1 = 0)"
