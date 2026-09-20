import pytest

from core.artifacts import ArtifactType
from core.ids import canonical_json, compute_artifact_id, shard_path, short_id


def base(**over):
    kw = dict(
        transform_name="chunker",
        transform_version="1",
        fingerprint="none",
        output_type=ArtifactType.CHUNK_SET,
        config={"size": 512, "overlap": 64},
        inputs={"doc": "aaa"},
    )
    kw.update(over)
    return kw


def test_id_is_64_hex_chars():
    aid = compute_artifact_id(**base())
    assert len(aid) == 64
    assert all(c in "0123456789abcdef" for c in aid)


def test_config_key_order_is_irrelevant():
    a = compute_artifact_id(**base(config={"size": 512, "overlap": 64}))
    b = compute_artifact_id(**base(config={"overlap": 64, "size": 512}))
    assert a == b


def test_config_value_change_changes_id():
    a = compute_artifact_id(**base(config={"size": 512, "overlap": 64}))
    b = compute_artifact_id(**base(config={"size": 256, "overlap": 64}))
    assert a != b


def test_version_bump_changes_id():
    assert compute_artifact_id(**base(transform_version="1")) != compute_artifact_id(
        **base(transform_version="2")
    )


def test_fingerprint_change_changes_id():
    """Swapping a model revision must invalidate the cache."""
    assert compute_artifact_id(**base(fingerprint="model@abc")) != compute_artifact_id(
        **base(fingerprint="model@def")
    )


def test_output_type_change_changes_id():
    """Prevents a raw_file and a query colliding in the global namespace."""
    assert compute_artifact_id(
        **base(output_type=ArtifactType.CHUNK_SET)
    ) != compute_artifact_id(**base(output_type=ArtifactType.PARSED_DOC))


def test_port_swap_changes_id():
    """THE regression test. sorted(input_ids) would make these equal."""
    a = compute_artifact_id(**base(inputs={"left": "aaa", "right": "bbb"}))
    b = compute_artifact_id(**base(inputs={"left": "bbb", "right": "aaa"}))
    assert a != b


def test_input_dict_order_is_irrelevant():
    a = compute_artifact_id(**base(inputs={"left": "aaa", "right": "bbb"}))
    b = compute_artifact_id(**base(inputs={"right": "bbb", "left": "aaa"}))
    assert a == b


def test_variadic_input_order_is_significant():
    """A corpus of [a, b] is a different index than [b, a] only if order matters
    to the transform; we preserve the list as given rather than sorting it."""
    a = compute_artifact_id(**base(inputs={"chunks": ["aaa", "bbb"]}))
    b = compute_artifact_id(**base(inputs={"chunks": ["bbb", "aaa"]}))
    assert a != b


def test_canonical_json_is_compact_and_sorted():
    assert canonical_json({"b": 1, "a": 2}) == '{"a":2,"b":1}'


def test_canonical_json_handles_none_unicode_float():
    out = canonical_json({"n": None, "u": "café", "f": 1.5})
    assert out == '{"f":1.5,"n":null,"u":"café"}'


def test_canonical_json_rejects_nan():
    """NaN is not valid JSON and would produce an unstable id."""
    with pytest.raises(ValueError):
        canonical_json({"f": float("nan")})


def test_canonical_json_rejects_infinity():
    with pytest.raises(ValueError):
        canonical_json({"f": float("inf")})


def test_short_id_and_shard_path():
    aid = "ab" + "cd" + "e" * 60
    assert short_id(aid) == aid[:16]
    assert shard_path(aid) == ("ab", "cd", aid[:16])
