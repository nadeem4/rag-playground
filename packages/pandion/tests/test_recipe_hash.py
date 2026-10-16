"""Moving code must never move an artifact id.

The literal ids below were computed on main before the engine moved into this
package. An artifact id is the recipe hash (`pandion.ids.compute_artifact_id`),
and every cached artifact and every saved run is found by it, so if one of
these changes, every user's cache rebuilds.
"""

import pytest

from pandion.artifacts import ArtifactType
from pandion.embedding_cache import cache_key
from pandion.embeddings import get_embedder
from pandion.ids import compute_artifact_id
from pandion.plugins import discover
from pandion.ports import Stage
from pandion.registry import registry


def test_a_parse_recipe_keeps_its_id():
    assert compute_artifact_id(
        transform_name="pdfium",
        transform_version="2",
        fingerprint="none",
        output_type=ArtifactType.PARSED_DOC,
        config={"mode": "text", "join_lines": True},
        inputs={"file": "a" * 64},
    ) == "8869fbcb4ba83d60f4b765e03459c1d515a7e504af807f1371b7c3100bdf0e8f"


def test_a_default_dedupe_blocks_node_keeps_its_id():
    """Computed on main at 85e5cbf, while the cleaner still lived in the app."""
    discover()
    cls = registry.get(Stage.CLEAN, "dedupe_blocks")
    config = cls.config_model()
    assert compute_artifact_id(
        transform_name=cls.name,
        transform_version=cls.version,
        fingerprint=cls().fingerprint(config),
        output_type=cls.output,
        config=config.model_dump(mode="json"),
        inputs={"doc": "c" * 64},
    ) == "6e8640e11bee889ad16d73b2c0fcecadc610729e7fa4ca35866f97919ef1a2f6"


@pytest.mark.parametrize(
    "name,expected",
    [
        ("recursive_character", "e1768c47781afb61b72aafdb56311f892f529dbe8e67c17342fe36ca58553db3"),
        ("layout_blocks", "f376c71a8333c8cc1756913490e4e9721a687a34cc0c6ce2a0b57e9735d8c5cf"),
        ("markdown_header", "a6fa1c5d404d3ca267d4106d0d31c3a201950b0055d539234a8c6722197ddeb5"),
        ("token_based", "7f4d66151ef536a6ce04f0d274838d3e67a776c98e4ae7d6e5cebcd37011810c"),
        ("sentence_window", "55519eb90e6748294f5266fb949460f5c824812a23c95d281aed3b6dd426c7c6"),
    ],
)
def test_a_default_chunker_node_keeps_its_id(name, expected):
    """Computed on main at 26779a1, while the chunkers still lived in the app."""
    discover()
    cls = registry.get(Stage.CHUNK, name)
    config = cls.config_model()
    assert compute_artifact_id(
        transform_name=cls.name,
        transform_version=cls.version,
        fingerprint=cls().fingerprint(config),
        output_type=cls.output,
        config=config.model_dump(mode="json"),
        inputs={"doc": "d" * 64},
    ) == expected


def test_a_source_recipe_keeps_its_id():
    assert compute_artifact_id(
        transform_name="upload",
        transform_version="1",
        fingerprint="none",
        output_type=ArtifactType.RAW_FILE,
        config={"sha": "b" * 64, "filename": "sample.pdf"},
        inputs={},
    ) == "8aefb26a746ed00691b742fad40d657f406db0225bb6c6b10f9fe5cb9117ab96"


def test_the_moved_upload_node_keeps_its_id():
    """The same literal as above, through the class that now lives in the package."""
    discover()
    cls = registry.get(Stage.SOURCE, "upload")
    config = cls.config_model(sha="b" * 64, filename="sample.pdf")
    assert compute_artifact_id(
        transform_name=cls.name,
        transform_version=cls.version,
        fingerprint=cls().fingerprint(config),
        output_type=cls.output,
        config=config.model_dump(mode="json"),
        inputs={},
    ) == "8aefb26a746ed00691b742fad40d657f406db0225bb6c6b10f9fe5cb9117ab96"


@pytest.mark.parametrize(
    "config,expected",
    [
        ({}, "a3f82f6a2d005b59bf0c24d41f146dd1ed6c8cefc218f0b96447c09fa17e911f"),
        (
            {"embedder": "fake-deterministic"},
            "fc000f2bae36ec1807b7773ff45d10e87871565086c9808a5efad17a19226143",
        ),
    ],
)
def test_a_lancedb_index_node_keeps_its_id(config, expected):
    """Computed on main at 8894d6d, while the index still lived in the app, and
    again for version 2, which added the columns search filters read."""
    discover()
    cls = registry.get(Stage.INDEX, "lancedb")
    settings = cls.config_model(**config)
    assert compute_artifact_id(
        transform_name=cls.name,
        transform_version=cls.version,
        fingerprint=cls().fingerprint(settings),
        output_type=cls.output,
        config=settings.model_dump(mode="json"),
        inputs={"chunks": ["e" * 64, "f" * 64]},
    ) == expected


@pytest.mark.parametrize(
    "name,kind,expected",
    [
        ("fake-deterministic", "document", "dbbd1fdc6934d3b28dba00e653337ff14efc442c566a116a1e1cb55ac987c352"),
        ("fake-deterministic", "query", "d566a80e187c195890dc7f09f03ccc0ee652877e920c35a1517b2ac638e67e6f"),
        ("qwen3-embedding-0.6b", "document", "3b7e6f31ac77b9354c1fc3f8ada5519ad96a21fae90f44e656af8a673644eac0"),
        ("qwen3-embedding-0.6b", "query", "7a8e8773c1047b1c1ef8c9234d6b84f7c8f6cc959bf045c8403edbd43c322c8e"),
    ],
)
def test_an_embedding_cache_key_stays_the_same(name, kind, expected):
    """Computed on main at 8894d6d. A moved key would make every cached vector a miss."""
    p = get_embedder(name)
    assert cache_key(p.model_id, p.revision, kind, "How big should a chunk be?", p.dtype) == expected


QUESTION = "How big should a chunk be?"


@pytest.mark.parametrize(
    "name,config,expected",
    [
        ("text", {}, "1f84ab7d7461a49703e5adfb3a0e2a2d86d22fe975c54769cc85592180618493"),
        (
            "text",
            {"text": QUESTION},
            "7e65b0c9455e026523a421126d47177cc18029428e47a01e0616be59d7f86b47",
        ),
        ("llm_rewrite", {}, "4413fa2b50f077ea8b338118ce00d93375998e24bfeac742efb5e041a15adf68"),
        (
            "llm_rewrite",
            {"text": QUESTION},
            "d346b0ea222f2c39e1ea4deac1c7e7c74791075839459d8c957638133f9f87d0",
        ),
    ],
)
def test_a_query_node_keeps_its_id(name, config, expected):
    """Computed on main at 8148f42, while the query steps still lived in the app."""
    discover()
    cls = registry.get(Stage.QUERY, name)
    settings = cls.config_model(**config)
    assert cls.__module__ == f"pandion.plugins.query.{name}"
    assert compute_artifact_id(
        transform_name=cls.name,
        transform_version=cls.version,
        fingerprint=cls().fingerprint(settings),
        output_type=cls.output,
        config=settings.model_dump(mode="json"),
        inputs={},
    ) == expected


@pytest.mark.parametrize(
    "name,config,expected",
    [
        ("dense", {}, "24d583bf7e4a1202421a47de71caf84e60d763a8029aca823037f08a341e68eb"),
        ("bm25", {}, "0eea8e79d356a2d3712c94ecdcfbd54e83868f12c0f004f2f38baa7a5b170826"),
        ("hybrid_rrf", {}, "eb943bf5d5dfe4c68804418cf137de563b04d0dfa1b94d0cf145c5474c57e390"),
        (
            "hybrid_rrf",
            {"query_expansion": "prf"},
            "c50aa263fb2e2b0d1c53e8eef29ff01dc13147961f566f16197ad533fb037905",
        ),
    ],
)
def test_a_retrieve_node_keeps_its_id(name, config, expected):
    """Computed on main at 410807c, while the retrievers still lived in the app."""
    discover()
    cls = registry.get(Stage.RETRIEVE, name)
    settings = cls.config_model(**config)
    assert cls.__module__ == f"pandion.plugins.retrieve.{name}"
    assert compute_artifact_id(
        transform_name=cls.name,
        transform_version=cls.version,
        fingerprint=cls().fingerprint(settings),
        output_type=cls.output,
        config=settings.model_dump(mode="json"),
        inputs={"index": "e" * 64, "query": "f" * 64},
    ) == expected


@pytest.mark.parametrize(
    "name,config,expected",
    [
        ("mmr", {}, "5b0304184926943bef826e88651784bdadce5f85c6ce413e475d5bcb46cd4f81"),
        ("cross_encoder", {}, "07b165284163911b6d6aaf7f109f41d6b8a9b771f078ce3c4ec2dc7771e85c07"),
        (
            "cross_encoder",
            {"model": "BAAI/bge-reranker-base"},
            "dd1704aeb8d71b24f36a16309640eb89fd460178dba19271051bd99d3943e215",
        ),
        ("llm_rerank", {}, "c129a6bd398b4812eb298a40bd9893b05eacdf4b3785c5e7118baac3850b2578"),
    ],
)
def test_a_rerank_node_keeps_its_id(name, config, expected):
    """Computed on main at 81e7329, while the rerankers still lived in the app."""
    discover()
    cls = registry.get(Stage.RERANK, name)
    settings = cls.config_model(**config)
    assert cls.__module__ == f"pandion.plugins.rerank.{name}"
    inputs = {"result": "a" * 64, "query": "b" * 64}
    if name == "mmr":
        inputs["index"] = "c" * 64
    assert compute_artifact_id(
        transform_name=cls.name,
        transform_version=cls.version,
        fingerprint=cls().fingerprint(settings),
        output_type=cls.output,
        config=settings.model_dump(mode="json"),
        inputs=inputs,
    ) == expected


ANSWER_INPUTS = {
    "search": {"result": "a" * 64},
    "chat": {"result": "a" * 64, "query": "b" * 64, "doc": "c" * 64, "index": "d" * 64},
}


@pytest.mark.parametrize(
    "name,config,expected",
    [
        ("search", {}, "5c77c85941c4fd54d1e0f2bc77f2c76c869977549725b312304b743df14fb631"),
        ("chat", {}, "195d5a4f919e10750d3c3c52d4ad4590fbd4b0452aaea20334b7b466e8dd8756"),
        (
            "chat",
            {"model": "claude-haiku-4-5"},
            "c236a3463fb1539bc70d622566a1fbc26db91ae766b4580f906ed1a136cc2347",
        ),
    ],
)
def test_an_answer_node_keeps_its_id(name, config, expected):
    """Computed on main at a274a19, while search and chat still lived in the app."""
    discover()
    cls = registry.get(Stage.USE_CASE, name)
    settings = cls.config_model(**config)
    assert cls.__module__ == f"pandion.plugins.answer.{name}"
    assert compute_artifact_id(
        transform_name=cls.name,
        transform_version=cls.version,
        fingerprint=cls().fingerprint(settings),
        output_type=cls.output,
        config=settings.model_dump(mode="json"),
        inputs=ANSWER_INPUTS[name],
    ) == expected


@pytest.mark.parametrize(
    "config,expected",
    [
        ({}, "1e82ebf61a8958e610daf1704eb57e182a2cba5cec469d69d4f4b4af60e38090"),
        ({"top_k": 10}, "4dcf6bfeee7b5da4ce714514714a25b02633bcaa3aa80c2e6dcb712187668db2"),
    ],
)
def test_the_eval_node_keeps_its_id(config, expected):
    """Computed on main at 1042e94, while eval still lived in the app (api/steps/eval.py)."""
    discover()
    cls = registry.get(Stage.USE_CASE, "eval")
    settings = cls.config_model(**config)
    assert cls.__module__ == "pandion.plugins.answer.eval"
    assert compute_artifact_id(
        transform_name=cls.name,
        transform_version=cls.version,
        fingerprint=cls().fingerprint(settings),
        output_type=cls.output,
        config=settings.model_dump(mode="json"),
        inputs={"result": "a" * 64, "query": "b" * 64},
    ) == expected
