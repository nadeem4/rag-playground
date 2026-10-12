"""Loading pipeline.yaml: what it accepts, and how it says what is wrong."""

from __future__ import annotations

from pathlib import Path

import pytest

from pandion.config import ConfigError, load
from pandion.models import ModelSettings

GOOD = """\
path: ./my-index
models:
  download: never
  device: cpu
index:
  parse:
    use: pdfium
  clean:
    - use: header_footer_strip
    - use: dedupe_blocks
  chunk:
    use: recursive_character
    chunk_size: 400
    chunk_overlap: 80
  embed:
    use: fake-deterministic
    truncate_dim: 64
  store:
    use: lancedb
    metric: cosine
    build_fts: true
"""


def write(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "pipeline.yaml"
    path.write_text(text, encoding="utf-8")
    return path


def test_a_full_file_loads(tmp_path):
    config = load(write(tmp_path, GOOD))

    assert config.path == tmp_path / "my-index"
    assert config.models == ModelSettings(download="never", device="cpu")
    index = config.index
    assert index.parse == ("pdfium", {})
    assert index.clean == [("header_footer_strip", {}), ("dedupe_blocks", {})]
    assert index.chunk == ("recursive_character", {"chunk_size": 400, "chunk_overlap": 80})
    assert index.store == {
        "embedder": "fake-deterministic",
        "truncate_dim": 64,
        "metric": "cosine",
        "build_fts": True,
    }


def test_clean_and_models_may_be_left_out(tmp_path):
    text = GOOD.replace(
        "  clean:\n    - use: header_footer_strip\n    - use: dedupe_blocks\n", ""
    ).replace("models:\n  download: never\n  device: cpu\n", "")

    config = load(write(tmp_path, text))

    assert config.index.clean == []
    assert config.models == ModelSettings()


def test_an_absolute_path_is_kept(tmp_path):
    elsewhere = tmp_path / "elsewhere"
    config = load(write(tmp_path, GOOD.replace("./my-index", elsewhere.as_posix())))
    assert config.path == elsewhere


def test_a_relative_model_folder_is_read_from_the_file_folder(tmp_path):
    config = load(write(tmp_path, GOOD.replace("  device: cpu\n", "  device: cpu\n  cache_dir: models\n")))
    assert config.models.cache_dir == tmp_path / "models"


@pytest.mark.parametrize("stage", ["parse", "chunk", "embed", "store"])
def test_a_missing_required_step_is_named(tmp_path, stage):
    lines = GOOD.splitlines(keepends=True)
    start = lines.index(f"  {stage}:\n")
    end = start + 1
    while end < len(lines) and lines[end].startswith("    "):
        end += 1
    text = "".join(lines[:start] + lines[end:])

    with pytest.raises(ConfigError, match=f"no {stage} step"):
        load(write(tmp_path, text))


def test_an_unknown_setting_names_the_step_and_its_settings(tmp_path):
    text = GOOD.replace("    chunk_size: 400\n", "    size: 400\n")

    with pytest.raises(ConfigError) as caught:
        load(write(tmp_path, text))

    message = str(caught.value)
    assert "index.chunk" in message and "'size'" in message and "chunk_size" in message


def test_an_unknown_clean_setting_names_its_step_number(tmp_path):
    text = GOOD.replace("    - use: dedupe_blocks\n", "    - use: dedupe_blocks\n      scop: exact\n")
    with pytest.raises(ConfigError, match=r"index\.clean step 2.*'scop'"):
        load(write(tmp_path, text))


def test_an_unknown_strategy_lists_the_strategies(tmp_path):
    text = GOOD.replace("use: pdfium", "use: pdfminer")
    with pytest.raises(ConfigError, match="pdfminer.*docling, pdfium"):
        load(write(tmp_path, text))


def test_an_unknown_embedder_lists_the_embedders(tmp_path):
    text = GOOD.replace("use: fake-deterministic", "use: text-embedding-3-large")
    with pytest.raises(ConfigError, match="text-embedding-3-large.*qwen3-embedding-0.6b"):
        load(write(tmp_path, text))


def test_embed_and_store_settings_stay_in_their_own_step(tmp_path):
    text = GOOD.replace("    truncate_dim: 64\n", "    truncate_dim: 64\n    metric: l2\n")
    with pytest.raises(ConfigError, match=r"index\.embed has no setting 'metric'.*truncate_dim"):
        load(write(tmp_path, text))


def test_the_only_store_is_lancedb(tmp_path):
    text = GOOD.replace("use: lancedb", "use: qdrant")
    with pytest.raises(ConfigError, match="qdrant.*lancedb"):
        load(write(tmp_path, text))


def test_an_unknown_top_level_key_lists_the_valid_ones(tmp_path):
    with pytest.raises(ConfigError, match="'retrieve'.*path, models, index"):
        load(write(tmp_path, GOOD + "retrieve:\n  search:\n    use: dense\n"))


def test_an_unknown_index_key_lists_the_steps(tmp_path):
    with pytest.raises(ConfigError, match="'enrich'.*parse, clean, chunk, embed, store"):
        load(write(tmp_path, GOOD + "  enrich:\n    use: x\n"))


def test_a_bad_model_setting_is_named(tmp_path):
    with pytest.raises(ConfigError, match="models.*device"):
        load(write(tmp_path, GOOD.replace("device: cpu", "device: tpu")))


def test_a_missing_path_is_explained(tmp_path):
    with pytest.raises(ConfigError, match="path"):
        load(write(tmp_path, GOOD.replace("path: ./my-index\n", "")))


def test_a_step_without_use_is_explained(tmp_path):
    with pytest.raises(ConfigError, match="index.parse.*use"):
        load(write(tmp_path, GOOD.replace("    use: pdfium\n", "    mode: text\n")))
