"""Search filters: limit a search to some documents, pages or a section.

`p.retrieve(q, where={"document": [...], "pages": [10, 30], "section": "Installing"})`
takes any of the three keys. The rules:

- `document` names documents by their id (the name `index.run` gave them) or
  by their sha. A piece matches when it comes from one of them.
- `pages` is a pair of whole numbers, first to last, both included. A piece
  matches when its pages overlap them: a piece on pages 29 to 31 matches
  `[30, 40]`. A piece with no pages (from a Word, HTML, Markdown or other
  file without pages) never matches a `pages` filter.
- `section` matches a piece when one heading on its heading path is exactly
  that text, letter case included. An index built by a parser that finds no
  headings (pdfium) has no sections, so a `section` filter on it is an error.

Several keys must all hold. A filter belongs to a question, so it is never
part of the pipeline file.

The filter reaches a retriever on `Query.filters`, with document names
already turned into shas (`doc_ids`), and the retriever turns it into SQL
here. The SQL is built only from checked values: numbers are written as
numbers and every text is quoted, so no caller ever writes SQL.
"""

from __future__ import annotations

from typing import Any, Mapping

#: The keys `where` takes, in the order they are reported.
KEYS = ("document", "pages", "section")

_SHA_LENGTH = 64


def check_where(where: Any) -> dict[str, Any] | None:
    """`where` checked and in a plain form, or None when it sets nothing.

    Raises ValueError with a plain sentence for an unknown key, a wrong type,
    or pages that are not a pair of whole numbers, first not after last.
    """
    if where is None:
        return None
    if not isinstance(where, Mapping):
        raise ValueError(
            'where must be a mapping such as {"document": ["guide.pdf"], '
            '"pages": [10, 30], "section": "Installing"}.'
        )
    for key in where:
        if key not in KEYS:
            raise ValueError(
                f"where has an unknown key {key!r}. Use document, pages or section."
            )
    out: dict[str, Any] = {}
    if where.get("document") is not None:
        out["document"] = _documents(where["document"])
    if where.get("pages") is not None:
        out["pages"] = _pages(where["pages"])
    if where.get("section") is not None:
        out["section"] = _section(where["section"])
    return out or None


def _documents(value: Any) -> list[str]:
    if not isinstance(value, (list, tuple)):
        raise ValueError('where: document must be a list of names, such as ["guide.pdf"].')
    if not value:
        raise ValueError("where: document must name at least one document.")
    if not all(isinstance(name, str) and name.strip() for name in value):
        raise ValueError("where: document must be a list of names, each one text.")
    return list(value)


def _pages(value: Any) -> list[int]:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise ValueError("where: pages must be a pair, first page and last page, such as [10, 30].")
    if not all(isinstance(n, int) and not isinstance(n, bool) for n in value):
        raise ValueError("where: pages must be a pair of whole numbers, such as [10, 30].")
    first, last = value
    if first < 1:
        raise ValueError("where: Pages start at 1, so the first page must be 1 or more.")
    if first > last:
        raise ValueError(f"where: the first page must not be after the last; got [{first}, {last}].")
    return [first, last]


def _section(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError('where: section must be text, a heading such as "Installing".')
    if not value.strip():
        raise ValueError("where: section must not be blank.")
    return value


def resolve(where: Any, documents: Mapping[str, Any]) -> dict[str, Any] | None:
    """`where` as it travels on `Query.filters`: document names become shas.

    `documents` is {document id: stored file}, the documents the search
    covers. A name matches a document id; a sha matches a stored file's sha.
    """
    checked = check_where(where)
    if checked is None:
        return None
    out: dict[str, Any] = {}
    if "document" in checked:
        out["doc_ids"] = _shas(checked["document"], documents)
    for key in ("pages", "section"):
        if key in checked:
            out[key] = checked[key]
    return out


def _shas(names: list[str], documents: Mapping[str, Any]) -> list[str]:
    shas = {doc_id: getattr(file, "sha", None) for doc_id, file in documents.items()}
    if any(sha is None for sha in shas.values()):
        raise ValueError(
            "where: a document filter needs documents indexed from files (the "
            "upload source), whose contents are known before the search."
        )
    known = set(shas.values())
    out: list[str] = []
    for name in names:
        if name in shas:
            sha = shas[name]
        elif len(name) == _SHA_LENGTH and name in known:
            sha = name
        else:
            raise ValueError(
                f"where: there is no document named {name!r}. The documents are "
                f"{', '.join(sorted(shas))}."
            )
        if sha not in out:
            out.append(sha)
    return out


# --------------------------------------------------------------------------
# SQL, for LanceDB
# --------------------------------------------------------------------------


def _quote(text: str) -> str:
    """A SQL string literal: inside single quotes, a quote is written twice."""
    return "'" + str(text).replace("'", "''") + "'"


def _whole(value: Any) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError("A page in a filter must be a whole number.")
    return value


def where_sql(filters: Mapping[str, Any] | None, descriptor: Mapping[str, Any]) -> str | None:
    """The SQL condition for `Query.filters` on a LanceDB index, or None.

    `descriptor` is the index's own, which says whether it has the filter
    columns and how many pieces have a section.
    """
    if not filters:
        return None
    unknown = set(filters) - {"doc_ids", "pages", "section"}
    if unknown:
        raise ValueError(f"A search filter has an unknown key: {', '.join(sorted(unknown))}.")
    if ("pages" in filters or "section" in filters) and "sections" not in descriptor:
        raise ValueError(
            "This index was built before page and section filters existed. "
            "Run the index again to rebuild it."
        )
    parts: list[str] = []
    if "doc_ids" in filters:
        ids = filters["doc_ids"]
        if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids):
            raise ValueError("A document filter must list at least one document.")
        parts.append(f"doc_id IN ({', '.join(_quote(i) for i in ids)})")
    if "pages" in filters:
        first, last = (_whole(n) for n in filters["pages"])
        # Overlap: the piece starts on or before the last page and ends on or
        # after the first. A piece with no pages has nulls here and never matches.
        parts.append(f"page_start <= {last} AND page_end >= {first}")
    if "section" in filters:
        if not descriptor.get("sections"):
            raise ValueError(
                "This index has no sections: its parser found no headings (pdfium "
                "finds none), so a section filter would match nothing. Use a "
                "parser that reads headings, such as docling, or leave section out."
            )
        section = filters["section"]
        if not isinstance(section, str):
            raise ValueError("A section filter must be text.")
        parts.append(f"array_has(section, {_quote(section)})")
    return " AND ".join(f"({p})" for p in parts)


def no_pages_sql(filters: Mapping[str, Any] | None) -> str | None:
    """The condition for pieces a pages filter skipped for having no pages,
    within the same documents. None when there is no pages filter."""
    if not filters or "pages" not in filters:
        return None
    parts = ["page_start IS NULL"]
    if filters.get("doc_ids"):
        parts.append(f"doc_id IN ({', '.join(_quote(i) for i in filters['doc_ids'])})")
    return " AND ".join(parts)


def no_pages_note(count: int) -> str | None:
    """The sentence a search leaves when a pages filter skipped pieces with no pages."""
    if not count:
        return None
    pieces = "1 piece has" if count == 1 else f"{count} pieces have"
    return (
        f"{pieces} no page numbers (from a file without pages, such as Word or "
        "HTML), so the pages filter left them out."
    )
