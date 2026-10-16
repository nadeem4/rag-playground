"""The app's own words for each stage: what it is for, and its Learn lesson.

They are the playground's teaching copy, not part of the engine, so they live
here rather than in `pandion.ports`. `playground/backend/routes/registry.py` serves them with
the registry schema.
"""

from __future__ import annotations

from pandion.extend import Stage

#: What each step is for in RAG, in one plain paragraph. The UI shows it in
#: every card's explanation, so a newcomer learns the pipeline by reading it.
STAGE_WHAT: dict[Stage, str] = {
    Stage.SOURCE: (
        "Every RAG pipeline starts from the documents you want to ask questions "
        "about. This step picks the file. It is stored once, by the fingerprint "
        "of its bytes, so the same file used in many pipelines is kept only once."
    ),
    Stage.QUERY: (
        "The question you want answered. Retrieval looks for the pieces of your "
        "document that best match it, so the wording matters: a question that "
        "uses the document's own terms is easier to match."
    ),
    Stage.PARSE: (
        "A PDF stores letters at positions on a page, not paragraphs or "
        "headings. Parsing turns it into a structured document of blocks "
        "(paragraphs, headings, tables) that every later step works from."
    ),
    Stage.CLEAN: (
        "Parsed documents carry noise: running heads, page numbers, repeated "
        "boilerplate. Cleaning removes blocks that would otherwise end up inside "
        "the pieces you search, where they add nothing and crowd out real "
        "matches. Cleaners can be stacked, one after another."
    ),
    Stage.CHUNK: (
        "A retriever never returns your whole document, only pieces of it. "
        "Chunking decides where those pieces start and end, and that decides "
        "what one search hit can contain."
    ),
    Stage.ENRICH: (
        "Enrichment adds context to each piece before it is indexed: a chat "
        "model writes one short sentence that says which document and part the "
        "piece comes from, so a piece that makes little sense on its own can "
        "still be found. The piece that is shown and cited does not change. It "
        "is optional, needs an API key and makes one model call per piece."
    ),
    Stage.INDEX: (
        "Indexing makes the pieces searchable. Each piece is turned into a "
        "vector, a list of numbers that captures its meaning, and optionally "
        "into a keyword index as well. Searches later compare the question "
        "against these."
    ),
    Stage.QUERY_TRANSFORM: (
        "A query transform rewrites the question before retrieval, for example "
        "into several phrasings or into a made-up answer that looks more like "
        "the document text. It helps when the question and the document use "
        "different words. No query transform is available yet."
    ),
    Stage.RETRIEVE: (
        "Retrieval finds the pieces that best match the question: by meaning "
        "(vectors), by shared keywords, or by both. Only the pieces it returns "
        "can reach the answer, so a fact it misses cannot be used later."
    ),
    Stage.RERANK: (
        "Reranking takes the retrieved pieces and puts them in a better order, "
        "or picks a better subset, before they are used. It sees only what "
        "retrieval returned, so it can reorder but never recover a missed piece."
    ),
    Stage.USE_CASE: (
        "The last step turns the retrieved pieces into something you use: a "
        "list of search results, or an answer written by a language model that "
        "cites the pieces it relied on."
    ),
}

#: The longer lesson Learn mode shows at the top of a stage's card, as
#: paragraphs. Only stages whose lesson is written appear here.
STAGE_LESSON: dict[Stage, list[str]] = {
    Stage.CHUNK: [
        "Before a search can find anything, the document is cut into smaller "
        "pieces called chunks. The search compares your question with each chunk "
        "and returns the ones that match best.",
        "So the way you cut the document decides what the search can find. If "
        "the answer to a question is cut in half, neither half may match well "
        "enough to be found.",
    ],
}

