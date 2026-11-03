"""The serve half of `new_project`: a folder to build into a container image.

Fixed files (serve.py, policy.py, the Dockerfile, .dockerignore, .gitignore and
tests/test_quality.py) are copied as they are from `pandion/templates/serve/`.
Only pipeline.yaml, pyproject.toml, .env.example, evals/ and the README are
written for the pipeline. No key, no folder of the machine that wrote them and
no document goes into any of them.
"""

from __future__ import annotations

import json
import re
from importlib.resources import files
from pathlib import Path
from string import Template
from typing import Any
from urllib.parse import urlsplit

import yaml

from pandion.project import SERVE_API_PIN, _keys, _relative

FIXED = ("serve.py", "policy.py", "Dockerfile", ".dockerignore", ".gitignore", "tests/test_quality.py")

#: Addresses a source or a store may be at, instead of a folder.
_REMOTE = ("s3://", "gs://", "az://")

ACCESS_EXAMPLE = """
# Access control is off. To turn it on, add a block like this, then fill in
# roles() in policy.py. A folder rule matches the document's path in the source.
# access:
#   default: []
#   folders:
#     - match: contracts/
#       roles: [legal]
"""


#: With the `local` extra, Linux takes CPU-only torch, not the multi-GB CUDA build.
CPU_TORCH = """
# On Linux (the Docker image) take CPU-only torch, not the multi-GB CUDA build.
[tool.uv.sources]
torch = [{ index = "pytorch-cpu", marker = "sys_platform == 'linux'" }]
torchvision = [{ index = "pytorch-cpu", marker = "sys_platform == 'linux'" }]

[[tool.uv.index]]
name = "pytorch-cpu"
url = "https://download.pytorch.org/whl/cpu"
explicit = true
"""


def _template(name: str) -> str:
    resource = files("pandion.templates.serve")
    for part in name.split("/"):
        resource = resource.joinpath(part)
    return resource.read_text(encoding="utf-8")


def _no_login(address: str, what: str) -> None:
    parts = urlsplit(address)
    if "@" in parts.netloc:
        raise ValueError(f"{what} has a user name or password in its address, which would be written into the project. Remove it; keys go in .env.")
    if parts.query:
        raise ValueError(f"{what} has a query string in its address, which could carry a key into the project. Remove it; keys go in .env.")


def serve_pipeline(data: dict[str, Any], source: str, index_store: str, index_url: str) -> dict[str, Any]:
    """The pipeline file's data for a server: version 1, a `source:` block, models that never download."""
    if index_store not in ("lancedb", "qdrant"):
        raise ValueError(f"index_store must be 'lancedb' or 'qdrant', not '{index_store}'.")
    _no_login(source, "The source")
    _no_login(index_url, "The index address")
    out = {"version": 1, **{k: v for k, v in data.items() if k != "version"}}
    out["path"] = "./index"
    out["models"] = {"download": "never", "cache_dir": "/models"}
    out["source"] = {"use": "files", "location": source if source.startswith(_REMOTE) else _relative(source, "docs")}
    store = {k: v for k, v in out["index"]["store"].items() if k != "settings"}
    if index_store == "qdrant":
        if not index_url.startswith(("http://", "https://")):
            raise ValueError("The Qdrant store needs the address of the server, such as https://qdrant.example.com:6333.")
        store.update(use="qdrant", settings={"url": index_url, "api_key_env": "QDRANT_API_KEY"})
    else:
        if index_url != "./index":
            raise ValueError("LanceDB keeps its index in the ./index folder of the server, so index_url must be './index'. For an index shared by several servers, use index_store='qdrant'.")
        store["use"] = "lancedb"
    out["index"] = {**out["index"], "store": store}
    return out


def _extras(p: Any) -> list[str]:
    return sorted({*p.extras(), "files", "sql"})


def render_pyproject(p: Any, name: str) -> str:
    from pandion.project import _pin

    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "pandion-serve"
    extras = _extras(p)
    return (
        "[project]\n"
        f'name = "{slug}"\n'
        'version = "0.1.0"\n'
        'requires-python = ">=3.13,<3.14"\n'
        "dependencies = [\n"
        f'    "pandion[{",".join(extras)}]{_pin()}",\n'
        f'    "pandion-api{SERVE_API_PIN}",\n'
        '    "uvicorn>=0.30,<1",\n'
        "]\n"
        "\n"
        "[dependency-groups]\n"
        'dev = ["pytest>=8"]\n'
        "\n"
        "# An application, not a library: `uv sync` installs the dependencies and nothing else.\n"
        "[tool.uv]\n"
        "package = false\n"
        f"{CPU_TORCH if 'local' in extras else ''}"
        "\n"
        "[tool.pytest.ini_options]\n"
        'testpaths = ["tests"]\n'
    )


def render_env(p: Any, index_store: str) -> str:
    """.env.example: every variable the server reads, by name, never a value."""
    lines = ["# Names only. Put the values in .env (never commit it) or in your platform's secret store.", ""]
    for variable, provider in _keys(p):
        lines += [f"# The key for {provider.replace('_', ' ')} models.", f"{variable}=", ""]
    lines += ["# A SQLAlchemy url for conversations. Empty keeps them in a SQLite file in index/.", "DATABASE_URL=", ""]
    if index_store == "qdrant":
        lines += ["# The key for the Qdrant server.", "QDRANT_API_KEY=", ""]
    lines += [
        "# Optional, set in the environment and not here:",
        "# USER_ID_HEADER=x-user-id   the header your gateway puts the user's id in",
        "# MODELS_DIR=/models         where the models are",
    ]
    return "\n".join(lines) + "\n"


def render_readme(title: str, keys: list[tuple[str, str]], source: str, index_store: str, extra: str) -> str:
    if keys:
        key_note = (
            "The pipeline calls a model through an API, so the server needs: "
            + ", ".join(f"`{variable}`" for variable, _ in keys) + ". Set them in `.env`."
        )
    else:
        key_note = "Every step in this pipeline runs on the server itself, so it needs no model key."
    if source.startswith(_REMOTE):
        source_note = (
            f"Documents are read from `{source}`. The image needs the credentials your cloud's "
            "tools read from the environment, and the matching fsspec package (such as `s3fs` or `gcsfs`) in `pyproject.toml`."
        )
    else:
        source_note = (
            "Documents are read from the folder in `source:` (`./docs` by default). Create it and put your files in, "
            "or point `source:` at a bucket. With the local defaults, share one volume between the sync run and the "
            "server (`-v rag-index:/app/index`), and mount the documents folder for the sync run."
        )
    store_note = (
        "Qdrant, at the address in `pipeline.yaml`; the key is `QDRANT_API_KEY`."
        if index_store == "qdrant" else "LanceDB, in the `index/` folder of the server."
    )
    return Template(_template("README.md.tmpl")).substitute(
        title=title, key_note=key_note, source_note=source_note, store_note=store_note,
        extra=("\n" + extra.strip() + "\n") if extra.strip() else "",
    )


def write_evals(categories_questions: dict[str, Any] | None) -> str | None:
    """evals/questions.json: every category's questions in one set, each tagged
    `category:<name>` so the gate can count them per category. None when no
    category has a question."""
    from pandion.questions import load_questions

    merged: list[dict[str, Any]] = []
    for category, questions in (categories_questions or {}).items():
        loaded = load_questions(questions) if questions["questions"] else {"questions": []}
        for q in loaded["questions"]:
            q = {**q, "tags": [*(q.get("tags") or []), f"category:{category}"]}
            if loaded.get("document") and not q.get("document"):
                q["document"] = loaded["document"]
            merged.append(q)
    return json.dumps({"questions": merged}, indent=2, ensure_ascii=False) + "\n" if merged else None


def write_serve_project(
    folder: Path, p: Any, data: dict[str, Any], *, questions: Any = None,
    categories_questions: dict[str, Any] | None = None, source: str = "./docs",
    index_store: str = "lancedb", index_url: str = "./index", readme_extra: str = "",
) -> list[Path]:
    """Write the serve project for the pipeline `p` (`data` is its dict) into `folder`."""
    from pandion.pipeline import Pipeline

    served = serve_pipeline(data, source, index_store, index_url)
    server = Pipeline.from_dict(served)  # the pipeline as the server runs it: its store decides the extras
    rendered = {
        "pipeline.yaml": yaml.safe_dump(served, sort_keys=False, allow_unicode=True) + ACCESS_EXAMPLE,
        "pyproject.toml": render_pyproject(server, folder.resolve().name),
        ".env.example": render_env(server, index_store),
        "README.md": render_readme(folder.resolve().name, _keys(server), source, index_store, readme_extra),
    }
    evals = write_evals(categories_questions)
    if evals is None and questions is not None:  # one set, as given, with no category tags
        from pandion.questions import load_questions

        evals = json.dumps(load_questions(questions), indent=2, ensure_ascii=False) + "\n"
    if evals is not None:
        rendered["evals/questions.json"] = evals
    texts = {**{name: _template(name) for name in FIXED}, **rendered}

    written = []
    for name, text in texts.items():
        path = folder / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
        written.append(path)
    return written
