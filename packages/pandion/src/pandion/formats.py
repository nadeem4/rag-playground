"""Which document formats each parser reads, and the check that uses it.

A parser declares the formats it reads in `provides["formats"]`, for example
`{"formats": ["pdf"]}`. A pipeline checks every file's extension against its
parser before any step runs, so a Word file given to pdfium fails at once with
a plain message instead of deep inside pdfium. A parser that declares no
formats is not checked, and neither is a file with no extension.
"""

from __future__ import annotations

from pathlib import PurePosixPath

#: Each format: its short name, what one file of it is, and its extensions.
FORMATS: dict[str, tuple[str, str, tuple[str, ...]]] = {
    "pdf": ("PDF", "a PDF file", (".pdf",)),
    "docx": ("Word", "a Word file", (".docx",)),
    "pptx": ("PowerPoint", "a PowerPoint file", (".pptx",)),
    "html": ("HTML", "an HTML file", (".html", ".htm")),
    "md": ("Markdown", "a Markdown file", (".md",)),
    "txt": ("text", "a text file", (".txt",)),
    "png": ("PNG", "a PNG image", (".png",)),
    "jpg": ("JPG", "a JPG image", (".jpg", ".jpeg")),
}


def format_of(filename: str) -> str | None:
    """The format of `filename` by its extension, or None if it is not one."""
    suffix = PurePosixPath(filename.replace("\\", "/")).suffix.lower()
    for name, (_, _, suffixes) in FORMATS.items():
        if suffix in suffixes:
            return name
    return None


def suffixes(formats: list[str]) -> tuple[str, ...]:
    """Every extension of `formats`, such as (".pdf", ".docx")."""
    return tuple(s for name in formats for s in FORMATS[name][2])


def declared_formats(parser: str) -> list[str] | None:
    """The formats the parser named `parser` declares, or None if it declares none."""
    from pandion.plugins import discover
    from pandion.ports import Stage
    from pandion.registry import registry

    discover()
    return registry.get(Stage.PARSE, parser).provides.get("formats")


def listed(words: list[str]) -> str:
    """`a, b and c`."""
    return words[0] if len(words) == 1 else f"{', '.join(words[:-1])} and {words[-1]}"


def check_readable(parser: str, filename: str) -> None:
    """Raise ValueError if the parser named `parser` cannot read `filename`.

    The message names what the parser reads, what the file is, and a parser
    that reads it when there is one: "pdfium reads PDF files; notes.docx is a
    Word file. Use docling."
    """
    formats = declared_formats(parser)
    name = PurePosixPath(filename.replace("\\", "/")).name
    if not formats or not PurePosixPath(name).suffix:
        return
    kind = format_of(name)
    if kind in formats:
        return
    reads = f"{parser} reads {listed([FORMATS[f][0] for f in formats])} files"
    if kind is None:
        raise ValueError(f"{reads}; {name} is not one of them.")
    message = f"{reads}; {name} is {FORMATS[kind][1]}."
    others = [p for p in _parsers_reading(kind) if p != parser]
    if others:
        message += f" Use {listed(others)}."
    raise ValueError(message)


def _parsers_reading(kind: str) -> list[str]:
    from pandion.ports import Stage
    from pandion.registry import registry

    return sorted(
        name
        for name, cls in registry.all_for(Stage.PARSE).items()
        if kind in cls.provides.get("formats", [])
    )
