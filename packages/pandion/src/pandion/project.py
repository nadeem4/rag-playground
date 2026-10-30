"""`new_project`: a folder with a pipeline, a script that runs it and a README.

The folder is what someone takes home from the playground or starts with
`pandion init`: pipeline.yaml, run.py, requirements.txt, README.md, an empty
docs/ for their documents and, when given, questions.json. Every path in
pipeline.yaml is relative and uses forward slashes, so no folder of the machine
that wrote it leaks into it, and no key value is ever written: the README only
names the environment variable a key is read from.
"""

from __future__ import annotations

import json
import re
from pathlib import Path, PureWindowsPath
from typing import Any

import yaml

from pandion.formats import declared_formats, listed, suffixes as format_suffixes

#: A path that may name a folder outside the project: a URL scheme or a drive
#: (`file:`, `C:`), a root or share (`/`, `\\`) or a home folder (`~`).
_OUTSIDE = re.compile(r"^(?:[A-Za-z][A-Za-z0-9+.-]*:|[\\/]|~)")

def parse_suffixes(parser: str) -> tuple[str, ...] | None:
    """The file extensions the parser named `parser` reads, from the formats it
    declares. None for a parser that declares none: it reads every file, as far
    as run.py knows."""
    formats = declared_formats(parser)
    return format_suffixes(formats) if formats else None

#: The question asked when the project has no question set.
EXAMPLE_QUESTION = "What is this document about?"


def _relative(value: str, default: str) -> str:
    """`value` as a relative posix path starting with ./. A path that may lead
    out of the project (absolute, a drive, a URL, `~` or `..`) keeps only its
    last part, so no folder of the machine that wrote it leaks."""
    parts = [part for part in value.replace("\\", "/").split("/") if part not in ("", ".")]
    if _OUTSIDE.match(value) or ".." in parts:
        last = next((part for part in reversed(parts) if part not in ("..", "~") and not part.endswith(":")), "")
        parts = [last] if last else [default]
    return "./" + "/".join(parts or [default])


def _check(pipeline: Any) -> None:
    """Refuse what a project cannot carry: plugin modules, and a custom endpoint with a user or token in it."""
    from urllib.parse import urlsplit

    plugins = pipeline.get("plugins") if isinstance(pipeline, dict) else pipeline.config.plugins
    if plugins:
        raise ValueError(
            "The pipeline loads plugins (" + ", ".join(map(str, plugins)) + "), and plugin modules cannot be "
            "packed into a project. Use a pipeline made of Pandion's own strategies."
        )
    data = pipeline if isinstance(pipeline, dict) else pipeline.to_dict()
    steps = [*(data.get("retrieve") or {}).values(), data.get("answer")]
    for step in [s for value in steps for s in (value if isinstance(value, list) else [value])]:
        url = step.get("custom_base_url") if isinstance(step, dict) else None
        if url and "@" in (urlsplit(str(url).strip()).netloc or ""):
            raise ValueError(
                "custom_base_url has a user name or password in it, which would be written into the "
                "project. Remove it from the address; the key goes in OPENAI_COMPATIBLE_API_KEY."
            )


def _pipeline_dict(pipeline: Any) -> tuple[Any, dict[str, Any]]:
    from pandion.pipeline import Pipeline

    if not isinstance(pipeline, Pipeline):
        _check(pipeline)
    p = pipeline if isinstance(pipeline, Pipeline) else Pipeline.from_dict(pipeline)
    _check(p)
    data = p.to_dict()
    # A dict still holds its paths as given; Pandion may have resolved them.
    given = pipeline if isinstance(pipeline, dict) else {}
    data["path"] = _relative(str(given.get("path") or data["path"]), "pandion-index")
    models = data.get("models") or {}
    # A server for strangers turns this on; at home the default applies.
    models.pop("public_endpoints_only", None)
    if models.get("cache_dir"):
        cache = (given.get("models") or {}).get("cache_dir") or models["cache_dir"]
        models["cache_dir"] = _relative(str(cache), "models")
    if not models:
        data.pop("models", None)
    return p, data


def _keys(p: Any) -> list[tuple[str, str]]:
    """(environment variable, provider) for the key of each chat model the pipeline calls."""
    from pandion.cli import ENV_KEYS
    from pandion.llm import CHAT_MODELS, CREDENTIAL
    from pandion.pipeline import CHAT_STEPS
    from pandion.plugins import discover
    from pandion.ports import Stage
    from pandion.registry import registry

    config = p.config
    steps = [config.index.enrich]
    if config.retrieve is not None:
        steps += [config.retrieve.rewrite, *config.retrieve.rerank]
    steps.append(config.answer)
    discover()
    found: list[tuple[str, str]] = []
    for step in steps:
        if step is None or step[0] not in CHAT_STEPS:
            continue
        use, settings = step
        provider = CHAT_MODELS[registry.get(Stage(CHAT_STEPS[use]), use).config_model(**settings).model].provider
        key = (ENV_KEYS[CREDENTIAL[provider]], provider)
        if key not in found:
            found.append(key)
    return found


def _pin() -> str:
    from pandion import __version__

    major, minor, *_ = __version__.split(".")
    return f"~={major}.{minor}.0"


def _requirements(extras: list[str]) -> str:
    package = f"pandion[{','.join(extras)}]" if extras else "pandion"
    return (
        f"{package}{_pin()}\n"
        "\n"
        "# Uncomment the next line to install the much smaller CPU-only build of torch.\n"
        "# --extra-index-url https://download.pytorch.org/whl/cpu\n"
    )


def _readme(
    title: str, keys: list[tuple[str, str]], suffixes: tuple[str, ...] | None,
    named: list[str], has_questions: bool, extra: str,
) -> str:
    sentences = []
    for variable, provider in keys:
        if provider == "openai_compatible":
            sentences.append(
                f"The custom model's server may need a key: set {variable} in your environment "
                "only if your server asks for a key."
            )
        else:
            sentences.append(f"Set {variable} in your environment before you run it.")
    if keys:
        may = "may need" if all(provider == "openai_compatible" for _, provider in keys) else "needs"
        key = (
            f"A step in this pipeline calls a model through an API, so it {may} a key. "
            + " ".join(sentences)
            + " Never write a key into a file in this folder."
        )
    else:
        key = "Every step in this pipeline runs on your computer, so it needs no API key."
    if suffixes:
        reads = (
            f"Put your documents in `docs/`. The pipeline reads {listed(list(suffixes))} files; "
            "run.py skips any other file and says which. Files in subfolders of `docs/` are not read."
        )
    else:
        reads = "Put your documents in `docs/`. Files in subfolders of `docs/` are not read."
    run = (
        "It indexes the files in `docs/`, then searches for each question in `questions.json` and says "
        "whether the answer came back."
        if has_questions
        else f'It indexes the files in `docs/`, then asks one example question: "{EXAMPLE_QUESTION}"'
    )
    lines = [
        f"# {title}",
        "",
        "This folder runs a Pandion retrieval pipeline on your own documents. The pipeline is in `pipeline.yaml`.",
        "",
        key,
        "",
        "## Set it up",
        "",
        "You need Python 3.13. Create a virtual environment and install what the pipeline needs:",
        "",
        "```",
        "python -m venv .venv",
        "source .venv/bin/activate        # on Windows: .venv\\Scripts\\activate",
        "pip install -r requirements.txt",
        "```",
        "",
        reads,
        "",
        "## Run it",
        "",
        "```",
        "python run.py",
        "```",
        "",
        f"{run} It prints the results and what the run cost.",
        "",
        "To check the pipeline file after you change it, run `pandion validate pipeline.yaml`.",
    ]
    if named:
        lines += [
            "",
            "## The documents the questions name",
            "",
            f"The questions in `questions.json` name these documents: {', '.join(named)}. Those names refer to "
            "the original documents, so the files you put in `docs/` must match them exactly, extension "
            "included. run.py stops with a sentence naming a document it does not find in `docs/`.",
        ]
    if extra.strip():
        lines += ["", extra.strip()]
    return "\n".join(lines) + "\n"


def _run_py(suffixes: tuple[str, ...] | None) -> str:
    from pandion.cli import ENV_KEYS

    keys = "".join(f'    "{name}": "{variable}",\n' for name, variable in ENV_KEYS.items())
    return f'''"""Index the files in docs/ with pipeline.yaml, then run the questions.

Run it with: python run.py
"""

import os
import sys
from pathlib import Path

import pandion
from pandion.evaluation import QuestionSetError

HERE = Path(__file__).resolve().parent

#: Each model key, and the environment variable it is read from. Keys are never written to a file.
KEYS = {{
{keys}}}

#: The file types the pipeline's parse step reads; None reads every file.
SUFFIXES = {suffixes!r}

#: Asked when there is no questions.json.
EXAMPLE_QUESTION = "{EXAMPLE_QUESTION}"


def show_cost(cost):
    parts = [f"{{cost['seconds']:.2f}} s"]
    if cost["dollars"] is not None:
        parts.append(f"about ${{cost['dollars']:.4f}} (estimate)")
    print("Cost: " + ", ".join(parts))


def main():
    os.chdir(HERE)
    if not Path("docs").is_dir():
        print("There is no docs/ folder. Make one next to run.py, put your documents in it and run this again.")
        return 1
    files = sorted(f for f in Path("docs").iterdir() if f.is_file() and not f.name.startswith("."))
    skipped = [f.name for f in files if SUFFIXES and f.suffix.lower() not in SUFFIXES]
    if skipped:
        print(f"Skipped {{', '.join(skipped)}}: this pipeline reads only {{', '.join(SUFFIXES)}} files.")
    documents = [f"docs/{{f.name}}" for f in files if f.name not in skipped]
    if not documents:
        print("There are no documents to index yet. Put your documents in docs/ and run this again.")
        return 1

    credentials = {{name: os.environ[var] for name, var in KEYS.items() if os.environ.get(var)}}
    p = pandion.Pipeline.from_yaml("pipeline.yaml")
    report = p.index.run(documents, credentials=credentials)
    for document, doc in report.documents.items():
        for name, step in doc.stages.items():
            print(f"{{document}}  {{name}}  {{step.status}}")
            if step.error:
                print(f"    {{step.error.strip().splitlines()[-1]}}")
    if not report.ok:
        print("Indexing failed; the lines above say which step.")
        return 1

    if Path("questions.json").is_file():
        try:
            result = pandion.evaluate(p, "questions.json", documents=documents, credentials=credentials)
        except QuestionSetError as exc:
            print(exc)
            return 1
        print(result)
    elif p.query is not None:
        print(f"Question: {{EXAMPLE_QUESTION}}")
        result = p.ask(EXAMPLE_QUESTION, documents=documents, credentials=credentials)
        print(result.text if result.ok else "No answer: a step failed.")
    else:
        print(f"Question: {{EXAMPLE_QUESTION}}")
        result = p.retrieve(EXAMPLE_QUESTION, documents=documents, credentials=credentials)
        for hit in result.hits:
            print(f"{{hit.rank}}. {{hit.score:.4f}}  {{' '.join(hit.chunk.text.split())[:160]}}")
    show_cost(result.cost())
    return 0


if __name__ == "__main__":
    sys.exit(main())
'''


def _all_suffixes(data: dict[str, Any]) -> tuple[str, ...] | None:
    """The file extensions any category's parser reads, or None when one of
    them declares none (it reads every file, as far as run.py knows)."""
    parsers = [c["parse"]["use"] for c in (data.get("categories") or {}).values()] or [data["index"]["parse"]["use"]]
    found: list[str] = []
    for parser in parsers:
        suffixes = parse_suffixes(parser)
        if suffixes is None:
            return None
        found.extend(s for s in suffixes if s not in found)
    return tuple(found)


def new_project(
    folder: str | Path,
    pipeline: Any,
    questions: str | Path | list[dict] | dict | None = None,
    *,
    readme_extra: str = "",
    overwrite: bool = False,
) -> list[Path]:
    """Write a ready-to-run project for `pipeline` into `folder`, and return the paths written.

    `pipeline` is a `Pipeline` or a pipeline dict. `questions` is an optional
    question set (a path, or a list or dict, as `pandion.evaluate` takes).
    `readme_extra` is plain text added at the end of the README. A folder that
    has files in it is refused unless `overwrite` is True; then only the
    project's own files are replaced, and an old questions.json is removed
    when there are no questions now.

    A pipeline that loads plugins, or whose custom endpoint has a user name or
    password in its address, is refused with a ValueError.
    """
    from pandion.questions import load_questions

    folder = Path(folder)
    if folder.is_file():
        raise NotADirectoryError(f"{folder} is a file, not a folder. Choose a folder for the project.")
    if folder.exists() and any(folder.iterdir()) and not overwrite:
        raise FileExistsError(
            f"{folder} already has files in it. Choose an empty folder, or pass overwrite=True "
            "(--overwrite for pandion init) to replace the project files in it."
        )
    p, data = _pipeline_dict(pipeline)
    question_set = load_questions(questions) if questions is not None else None
    named: list[str] = []
    if question_set is not None:
        for q in [question_set, *question_set["questions"]]:
            if q.get("document") and q["document"] not in named:
                named.append(q["document"])
    suffixes = _all_suffixes(data)

    files = {
        "pipeline.yaml": yaml.safe_dump(data, sort_keys=False, allow_unicode=True),
        "run.py": _run_py(suffixes),
        "requirements.txt": _requirements(p.extras()),
        "README.md": _readme(
            folder.resolve().name, _keys(p), suffixes, named, question_set is not None, readme_extra
        ),
        "docs/.gitkeep": "",
    }
    if question_set is not None:
        files["questions.json"] = json.dumps(question_set, indent=2, ensure_ascii=False) + "\n"
    else:
        (folder / "questions.json").unlink(missing_ok=True)

    written = []
    for name, text in files.items():
        path = folder / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
        written.append(path)
    return written
