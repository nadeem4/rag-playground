"""The index artifact is a small JSON binding; the rows live in the store."""

import json

from pandion.index_store import Binding, open_binding
from test_index_lancedb import build, chunk_set, descriptor_of


def test_the_index_artifact_is_a_json_binding_not_a_directory(tmp_path):
    binding, _, store = build(tmp_path, chunk_set("alpha"))

    assert isinstance(binding, dict)
    folder = store.path_for("a" * 64)
    kept = json.loads((folder / "payload.json").read_text(encoding="utf-8"))
    assert kept == {**binding, "settings": {"fts": True}}
    assert not (folder / "lancedb").exists()


def test_the_binding_names_the_store_collection_and_recipe(tmp_path):
    binding, _, _ = build(tmp_path, chunk_set("alpha"), recipe_hash="ab" * 32)
    parsed = Binding.model_validate(binding)

    assert parsed.store == "lancedb"
    assert parsed.collection == f"{'ab' * 8}-{'a' * 12}"
    assert parsed.recipe_hash == "ab" * 32
    assert open_binding(binding).meta().recipe_hash == "ab" * 32


def test_two_document_sets_of_one_recipe_get_two_collections(tmp_path):
    first, _, _ = build(tmp_path, chunk_set("alpha", doc_id="d1"), artifact_id="1" * 64)
    second, _, _ = build(tmp_path, chunk_set("beta", doc_id="d2"), artifact_id="2" * 64)

    assert first["collection"] != second["collection"]
    assert set(open_binding(first).documents()) == {"d1"}
    assert set(open_binding(second).documents()) == {"d2"}


def test_a_forced_rerun_replaces_its_own_collection(tmp_path):
    build(tmp_path, chunk_set("alpha", doc_id="d1"))
    binding, _, _ = build(tmp_path / "again", chunk_set("beta", doc_id="d2"), location=tmp_path / "lancedb")

    assert set(open_binding(binding).documents()) == {"d2"}


def test_the_binding_holds_no_secret(tmp_path):
    binding, _, _ = build(tmp_path, chunk_set("alpha"))

    assert set(binding["settings"]) == {"location", "fts"}


def test_the_descriptor_is_still_in_artifact_meta(tmp_path):
    binding, ctx, _ = build(tmp_path, chunk_set("alpha"))

    assert ctx.extras["meta"]["index_descriptor"] == descriptor_of(binding)
    assert {"max_page", "doc_count", "metric"} <= set(descriptor_of(binding))
