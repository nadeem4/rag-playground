"""`/api/health`: what a deploy check reads to know the right build is live."""

from importlib.metadata import version


def test_health_says_ok_with_the_package_version_and_no_commit_by_default(client, monkeypatch):
    monkeypatch.delenv("RAG_PLAYGROUND_COMMIT", raising=False)
    monkeypatch.delenv("RAG_PLAYGROUND_VERSION", raising=False)
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "version": version("rag-playground"), "commit": "", "demo": False}


def test_health_reports_the_published_commit_and_demo_mode(client, monkeypatch):
    monkeypatch.setenv("RAG_PLAYGROUND_COMMIT", "abc1234")
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    body = client.get("/api/health").json()
    assert body["commit"] == "abc1234"
    assert body["demo"] is True


def test_the_published_tag_is_the_version(client, monkeypatch):
    """The tag is the version: a publish sets RAG_PLAYGROUND_VERSION, and it wins over pyproject's."""
    monkeypatch.setenv("RAG_PLAYGROUND_VERSION", "v0.33.0")
    assert client.get("/api/health").json()["version"] == "v0.33.0"
