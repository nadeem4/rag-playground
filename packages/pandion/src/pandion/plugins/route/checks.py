"""The seven built-in route checks.

Text matching ignores case. A glob is matched against lowercased text, and `*`
also matches `/`, so `legal/**` and `legal/*` both match `legal/a/b.pdf`. A
missing key, a missing property, or a check that does not apply to the file's
type is false, never an error.
"""

from __future__ import annotations

from fnmatch import fnmatchcase

from pydantic import BaseModel, Field, model_validator

from pandion.docinfo import DocumentInfo
from pandion.routing import route_check


def _glob(text: str, pattern: str) -> bool:
    return fnmatchcase(text.lower(), pattern.lower())


class FileTypeSettings(BaseModel):
    types: list[str] = Field(description="The file types to match, such as pdf or docx.")


@route_check(
    "file_type",
    summary="The file's type is one of the listed types, such as pdf or docx.",
    config=FileTypeSettings,
    because=lambda s: f"type is {' or '.join(s.types)}",
)
def file_type(info: DocumentInfo, s: FileTypeSettings) -> bool:
    return info.type is not None and info.type in {t.lower() for t in s.types}


class PatternSettings(BaseModel):
    pattern: str = Field(description="The text to match. * matches any text. Case is ignored.")


@route_check(
    "name",
    summary="The file name matches a pattern, ignoring case. * matches any text.",
    config=PatternSettings,
    because=lambda s: f"name matches {s.pattern}",
)
def name(info: DocumentInfo, s: PatternSettings) -> bool:
    return _glob(info.filename, s.pattern)


@route_check(
    "path",
    summary="The folder path the file was added from matches a pattern, ignoring case. "
    "* matches any text, including /.",
    config=PatternSettings,
    because=lambda s: f"path matches {s.pattern}",
)
def path(info: DocumentInfo, s: PatternSettings) -> bool:
    return bool(info.path) and _glob(info.path, s.pattern)


class KeySettings(BaseModel):
    key: str = Field(description="The name of the label or property. Case is ignored.")
    equals: str | None = Field(None, description="True when the value is exactly this. Case is ignored.")
    contains: str | None = Field(None, description="True when the value has this text in it. Case is ignored.")
    pattern: str | None = Field(None, description="True when the value matches this. * matches any text.")

    @model_validator(mode="after")
    def _one_operator(self):
        if sum(v is not None for v in (self.equals, self.contains, self.pattern)) != 1:
            raise ValueError("Give exactly one of equals, contains, pattern.")
        return self


def _lookup(values: dict[str, str], s: KeySettings) -> bool:
    value = next((v for k, v in values.items() if k.lower() == s.key.lower()), None)
    if value is None:
        return False
    value = value.lower()
    if s.equals is not None:
        return value == s.equals.lower()
    if s.contains is not None:
        return s.contains.lower() in value
    return _glob(value, s.pattern or "")


def _because(label: str, s: KeySettings) -> str:
    if s.equals is not None:
        return f"{label} {s.key} equals {s.equals}"
    if s.contains is not None:
        return f"{label} {s.key} contains {s.contains}"
    return f"{label} {s.key} matches {s.pattern}"


@route_check(
    "metadata",
    summary="A metadata label given when the document was added is present and matches. "
    "Give one of equals, contains or pattern.",
    config=KeySettings,
    because=lambda s: _because("metadata", s),
)
def metadata(info: DocumentInfo, s: KeySettings) -> bool:
    return _lookup(info.metadata, s)


@route_check(
    "properties",
    summary="A property stored inside the file, such as a PDF author, is present and matches. "
    "Give one of equals, contains or pattern.",
    config=KeySettings,
    because=lambda s: _because("property", s),
)
def properties(info: DocumentInfo, s: KeySettings) -> bool:
    return _lookup(info.properties, s)


class TextLayerSettings(BaseModel):
    has: bool = Field(True, description="True to match a PDF with selectable text, false to match one with only images.")


@route_check(
    "text_layer",
    summary="A PDF has text you can select (has: true), or only page images (has: false). "
    "False for files that are not PDFs.",
    config=TextLayerSettings,
    because=lambda s: "has a text layer" if s.has else "has no text layer",
)
def text_layer(info: DocumentInfo, s: TextLayerSettings) -> bool:
    return info.text_layer is not None and info.text_layer == s.has


class WordsSettings(BaseModel):
    words: list[str] = Field(description="True when any of these words is in the first page. Case is ignored.")


@route_check(
    "contains",
    summary="Any of the words is in the first page's text, ignoring case.",
    config=WordsSettings,
    because=lambda s: f"first page has {', '.join(s.words)}",
)
def contains(info: DocumentInfo, s: WordsSettings) -> bool:
    text = info.first_page_text.lower()
    return any(w.lower() in text for w in s.words)
