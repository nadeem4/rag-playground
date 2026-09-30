"""Uploads on the demo expire after a day; samples never do."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from api import demo, expiry
from api.routes.sources import META_DIR, _store

NOW = datetime(2026, 9, 30, 12, 0, tzinfo=timezone.utc)


def _stamp(sources: Path, sha: str, visitors: dict[str, datetime]) -> None:
    meta = sources / META_DIR / f"{sha}.json"
    body = json.loads(meta.read_text(encoding="utf-8"))
    body["visitors"] = {k: v.isoformat(timespec="seconds") for k, v in visitors.items()}
    meta.write_text(json.dumps(body), encoding="utf-8")


def test_an_expired_upload_is_deleted_and_a_fresh_one_kept(tmp_path):
    old = _store(tmp_path, "old.pdf", b"%PDF-1.4 old", "application/pdf", visitor="a")
    new = _store(tmp_path, "new.pdf", b"%PDF-1.4 new", "application/pdf", visitor="a")
    _stamp(tmp_path, old["sha"], {"a": NOW - demo.UPLOAD_TTL - timedelta(minutes=1)})
    _stamp(tmp_path, new["sha"], {"a": NOW - timedelta(hours=1)})
    assert expiry.sweep(tmp_path, NOW) == 1
    assert not (tmp_path / f"{old['sha']}.pdf").exists()
    assert not (tmp_path / META_DIR / f"{old['sha']}.json").exists()
    assert (tmp_path / f"{new['sha']}.pdf").exists()


def test_a_file_two_visitors_own_survives_until_both_expire(tmp_path):
    body = _store(tmp_path, "shared.pdf", b"%PDF-1.4 shared", "application/pdf", visitor="a")
    _stamp(tmp_path, body["sha"], {"a": NOW - timedelta(days=2), "b": NOW - timedelta(hours=1)})
    assert expiry.sweep(tmp_path, NOW) == 0
    meta = json.loads((tmp_path / META_DIR / f"{body['sha']}.json").read_text(encoding="utf-8"))
    assert meta["visitors"] == {"b": (NOW - timedelta(hours=1)).isoformat(timespec="seconds")}
    assert (tmp_path / f"{body['sha']}.pdf").exists()


def test_samples_are_never_touched(tmp_path):
    sample = _store(tmp_path, "chunking-primer.pdf", b"%PDF-1.4 sample", "application/pdf")
    assert expiry.sweep(tmp_path, NOW + timedelta(days=400)) == 0
    assert (tmp_path / f"{sample['sha']}.pdf").exists()


def test_a_malformed_timestamp_counts_as_expired(tmp_path):
    body = _store(tmp_path, "odd.pdf", b"%PDF-1.4 odd", "application/pdf", visitor="a")
    meta = tmp_path / META_DIR / f"{body['sha']}.json"
    data = json.loads(meta.read_text(encoding="utf-8"))
    data["visitors"] = {"a": "not a date"}
    meta.write_text(json.dumps(data), encoding="utf-8")
    assert expiry.sweep(tmp_path, NOW) == 1


def test_sweep_on_a_missing_folder_is_a_no_op(tmp_path):
    assert expiry.sweep(tmp_path / "nowhere", NOW) == 0


def test_an_invalid_sha_deletes_no_files_but_the_sidecar_is_removed(tmp_path):
    meta_dir = tmp_path / META_DIR
    meta_dir.mkdir(parents=True)
    meta = meta_dir / "bad.json"
    outside = tmp_path.parent / "evil-secret.pdf"
    outside.write_text("do not delete me", encoding="utf-8")
    try:
        meta.write_text(
            json.dumps(
                {
                    "sha": "../evil-secret",
                    "filename": "x.pdf",
                    "size": 1,
                    "content_type": "application/pdf",
                    "visitors": {
                        "a": (NOW - demo.UPLOAD_TTL - timedelta(minutes=1)).isoformat(timespec="seconds"),
                    },
                }
            ),
            encoding="utf-8",
        )
        assert expiry.sweep(tmp_path, NOW) == 0
        assert not meta.exists()
        assert outside.exists()
    finally:
        outside.unlink(missing_ok=True)


def test_uploading_a_samples_bytes_never_makes_the_sample_expire(tmp_path, monkeypatch):
    from api import sample_set
    from tests.api.conftest import make_client

    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    monkeypatch.setattr(expiry, "run_forever", _no_sweeper)
    dirs = {"artifacts": tmp_path / "artifacts", "sources": tmp_path / "sources", "web": tmp_path / "web"}
    sample = sample_set.default_sample()
    with make_client(dirs) as a, make_client(dirs) as b:
        sha = a.post("/api/sources/sample").json()["sha"]
        b.get("/api/settings/app")
        r = b.post("/api/sources", files={"file": (sample.pdf.name, sample.pdf.read_bytes(), "application/pdf")})
        assert r.status_code == 200 and r.json()["sha"] == sha
        assert expiry.sweep(dirs["sources"], datetime.now(timezone.utc) + timedelta(days=2)) == 0
        assert a.get(f"/api/sources/{sha}/pages/1.png").status_code == 200


def test_the_sweep_skips_a_sample_even_when_its_sidecar_has_visitors(tmp_path):
    from api import sample_set

    sample = sample_set.default_sample()
    body = _store(tmp_path, sample.pdf.name, sample.pdf.read_bytes(), "application/pdf")
    meta = tmp_path / META_DIR / f"{body['sha']}.json"
    data = json.loads(meta.read_text(encoding="utf-8"))
    data["visitors"] = {"a": (NOW - timedelta(days=2)).isoformat(timespec="seconds")}
    meta.write_text(json.dumps(data), encoding="utf-8")
    assert expiry.sweep(tmp_path, NOW) == 0
    assert (tmp_path / f"{body['sha']}.pdf").exists()


async def _no_sweeper(sources, interval_s=3600):
    import asyncio

    await asyncio.Event().wait()
