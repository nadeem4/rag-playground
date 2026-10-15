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

#: An absolute path: a drive (`C:\` or `C:/`), a share (`\\host`) or a POSIX root.
_ABSOLUTE = re.compile(r"^(?:[A-Za-z]:[\\/]|\\\\|/)")

#: The question asked when the project has no question set.
EXAMPLE_QUESTION = "What is this document about?"


def _relative(value: str) -> str:
    """`value` as a relative posix path starting with ./; an absolute path keeps only its last part."""
    text = value.replace("\\", "/")
    if _ABSOLUTE.match(value) or PureWindowsPath(value).is_absolute():
        text = text.rstrip("/").rsplit("/", 1)[-1]
    while text.startswith("./"):
        text = text[2:]
    return f"./{text}"


def _portable(data: Any) -> Any:
    """`data` with every absolute path replaced by a relative one, so no folder
    of this machine is written into the project."""
    if isinstance(data, dict):
        return {key: _portable(value) for key, value in data.items()}
    if isinstance(data, list):
        return [_portable(value) for value in data]
    if isinstance(data, str) and _ABSOLUTE.match(data):
        return _relative(data)
    return data


def _pipeline_dict(pipeline: Any) -> tuple[Any, dict[str, Any]]:
    from pandion.pipeline import Pipeline

    p = pipeline if isinstance(pipeline, Pipeline) else Pipeline.from_dict(pipeline)
    data = p.to_dict()
    data["path"] = _relative(data["path"])
    models = data.get("models") or {}
    if models.get("cache_dir"):
        # Pandion reads a relative cache_dir from the file's folder, so the
        # pipeline holds it absolute; a dict still has it as it was given.
        given = (pipeline.get("models") or {}).get("cache_dir") if isinstance(pipeline, dict) else None
        models["cache_dir"] = _relative(str(given or models["cache_dir"]))
    return p, _portable(data)


def _key_variables(p: Any) -> list[str]:
    """The environment variables that hold the keys of the chat models the pipeline calls."""
    from pandion.cli import ENV_KEYS
    from pandion.llm import CHAT_MODELS, CREDENTIAL
    from pandion.pipeline import CHAT_STEPS
    from pandion.plugins import discover
    from pandion.ports import Stage
    from pandion.registry import registry

    config = p.config
    steps = []
    if config.retrieve is not None:
        steps += [config.retrieve.rewrite, *config.retrieve.rerank]
    steps.append(config.answer)
    discover()
    found = []
    for step in steps:
        if step is None or step[0] not in CHAT_STEPS:
            continue
        use, settings = step
        model = registry.get(Stage(CHAT_STEPS[use]), use).config_model(**settings).model
        variable = ENV_KEYS[CREDENTIAL[CHAT_MODELS[model].provider]]
        if variable not in found:
            found.append(variable)
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


def _readme(title: str, keys: list[str], named: list[str], has_questions: bool, extra: str) -> str:
    if keys:
        names = " and ".join(keys)
        key = (
            f"A step in this pipeline calls a model through an API, so it needs a key. "
            f"Set {names} in your environment before you run it. Never write a key into a file in this folder."
        )
    else:
        key = "Every step in this pipeline runs on your computer, so it needs no API key."
    run = (
        "It indexes every file in `docs/`, then searches for each question in `questions.json` and says "
        "whether the answer came back."
        if has_questions
        else f'It indexes every file in `docs/`, then asks one example question: "{EXAMPLE_QUESTION}"'
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
        "Put your documents in `docs/`.",
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
            "the original documents, so the files you put in `docs/` must match them.",
        ]
    if extra.strip():
        lines += ["", extra.strip()]
    return "\n".join(lines) + "\n"


def _run_py() -> str:
    from pandion.cli import ENV_KEYS

    keys = "".join(f'    "{name}": "{variable}",\n' for name, variable in ENV_KEYS.items())
    return f'''"""Index every file in docs/ with pipeline.yaml, then run the questions.

Run it with: python run.py
"""

import os
import sys
from pathlib import Path

import pandion

HERE = Path(__file__).resolve().parent

#: Each model key, and the environment variable it is read from. Keys are never written to a file.
KEYS = {{
{keys}}}

#: Asked when there is no questions.json.
EXAMPLE_QUESTION = "{EXAMPLE_QUESTION}"


def show_cost(cost):
    parts = [f"{{cost['seconds']:.2f}} s"]
    if cost["dollars"] is not None:
        parts.append(f"about ${{cost['dollars']:.4f}} (estimate)")
    print("Cost: " + ", ".join(parts))


def main():
    os.chdir(HERE)
    credentials = {{name: os.environ[var] for name, var in KEYS.items() if os.environ.get(var)}}
    p = pandion.Pipeline.from_yaml("pipeline.yaml")
    documents = sorted(f"docs/{{f.name}}" for f in Path("docs").iterdir() if f.is_file() and not f.name.startswith("."))
    if not documents:
        print("There are no documents to index yet. Put your documents in docs/ and run this again.")
        return 1

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
        result = pandion.evaluate(p, "questions.json", documents=documents, credentials=credentials)
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
    project's own files are replaced.
    """
    from pandion.questions import load_questions

    folder = Path(folder)
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

    files = {
        "pipeline.yaml": yaml.safe_dump(data, sort_keys=False, allow_unicode=True),
        "run.py": _run_py(),
        "requirements.txt": _requirements(p.extras()),
        "README.md": _readme(
            folder.resolve().name, _key_variables(p), named, question_set is not None, readme_extra
        ),
        "docs/.gitkeep": "",
    }
    if question_set is not None:
        files["questions.json"] = json.dumps(question_set, indent=2, ensure_ascii=False) + "\n"

    written = []
    for name, text in files.items():
        path = folder / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
        written.append(path)
    return written
