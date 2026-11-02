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
already turned into shas (`doc_ids`), and the retriever turns it into a store
filter here. It is built only from checked values, so no caller
ever writes a query. A pages filter covers only pieces that have pages.
"""

from __future__ import annotations

from typing import Any, Mapping

from pandion.index_store import NO_FILTER, AnyOf, And, Filter, In

#: The keys `where` takes, in the order they are reported.
KEYS = ("document", "pages", "section")

_SHA_LENGTH = 64

#: The largest page number: the index keeps pages as 32-bit whole numbers.
MAX_PAGE = 2**31 - 1


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
    if last > MAX_PAGE:
        raise ValueError(f"where: A page number must be {MAX_PAGE} or less.")
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
    # Sorted, so the order the names were given in never changes the step's id.
    return sorted(out)


# --------------------------------------------------------------------------
# The store filter
# --------------------------------------------------------------------------


def store_filter(
    filters: Mapping[str, Any] | None, roles: list[str] | None, descriptor: Mapping[str, Any]
) -> Filter:
    """The store filter for `Query.filters` and the caller's roles.

    `descriptor` is the index's own, which says whether it has the filter
    columns, how many pieces have a section and the last page. `roles` is None
    when the search is not limited by role; an empty list matches nothing.
    The roles come from the run, never from `filters`: a step that rewrites the
    question may drop the filters, and that must not lift the role check.
    """
    filters = filters or {}
    unknown = set(filters) - {"doc_ids", "pages", "section", "roles"}
    if unknown:
        raise ValueError(f"A search filter has an unknown key: {', '.join(sorted(unknown))}.")
    if ("pages" in filters or "section" in filters) and "sections" not in descriptor:
        raise ValueError(
            "This index was built before page and section filters existed. "
            "Run the index again to rebuild it."
        )
    parts: list[Filter] = []
    if "doc_ids" in filters:
        ids = filters["doc_ids"]
        if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids):
            raise ValueError("A document filter must list at least one document.")
        parts.append(In("doc_id", tuple(ids)))
    if "pages" in filters:
        first, last = (_whole(n) for n in filters["pages"])
        # Overlap: a piece lists every page it touches, so it matches when one
        # of them is in the range. Pages past the last one indexed cannot match.
        last = min(last, int(descriptor.get("max_page", 0)))
        parts.append(AnyOf("pages", tuple(str(n) for n in range(first, last + 1))))
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
        parts.append(AnyOf("section", (section,)))
    if roles is not None:
        parts.append(AnyOf("roles", tuple(roles)))
    return And(tuple(parts)) if parts else NO_FILTER


def _whole(value: Any) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError("A page in a filter must be a whole number.")
    return value
