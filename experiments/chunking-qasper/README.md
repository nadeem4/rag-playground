# Chunking: what the strategy, the size and the overlap actually buy

**Status:** designed

## The question

On long documents, how much does the chunking strategy change whether a retriever can find
the answer, and what does each choice cost in tokens indexed?

Three sub-questions:
1. Does cutting at headings beat cutting at paragraphs, and does either beat cutting every
   N tokens?
2. Where does chunk size peak, and how sharply does it fall away either side?
3. Does overlap earn the tokens it duplicates?

## Motivation

The playground can show what a setting does to one document, but not whether it matters. Its
sample is three pages, and every strategy answers all ten of its questions, so the app
currently teaches chunking with no evidence that the choice changes anything. Meanwhile the
common advice ("use structure-aware chunking", "use ten to twenty percent overlap") is
repeated far more often than it is measured.

There is also a specific claim to check in our own code: `recursive_character` repeats only
whole parts, so with the default overlap of 200 characters and paragraphs longer than that,
it produces **no overlap at all**. If that holds on real documents, the default is
misleading.

## What we expect

Written before the run. Commit history is the timestamp.

1. **Structure-aware wins on containment, less on answers.** `markdown_header` will keep the
   gold paragraph whole in one chunk at least 5 points more often than `recursive_character`,
   but the gap in hit rate at 5 will be smaller, at most 3 points, because retrieval
   tolerates a lot.
2. **Fixed-size loses.** `token_based` will be last on both containment and hit rate at 5.
3. **Size has a peak.** Hit rate at 5 will peak between 256 and 512 tokens and fall away on
   both sides, with the fall steeper below than above.
4. **Overlap is a poor trade.** Going from no overlap to twenty percent will raise hit rate
   at 5 by at most 2 points while indexing about twenty percent more tokens.
5. **Our overlap default does nothing.** On QASPER paragraphs, `recursive_character` at its
   default settings will show a duplication factor below 1.02, meaning the 200-character
   overlap almost never fires.

If prediction 1 fails and structure-aware chunking wins on answers too, the lesson we ship
is wrong and needs rewriting.

## Data

**QASPER** (`allenai/qasper`): full scientific papers with questions written by readers of
the paper and the paragraphs that answer them. Chosen because the documents are long, the
evidence is paragraph-level, and the papers have real section structure, which is what the
strategies differ on.

- Unit of work: one question.
- Sample: a fixed random sample of questions, shuffled before limiting, seed recorded.
- Excluded and counted separately: questions marked unanswerable, and questions whose
  evidence is a table or figure rather than text, because no text chunker can win those.

## Method

One arm per configuration. Everything except the arm's variable is held fixed: the same
papers, the same questions, the same order, the same seed, the same embedder, the same
retriever.

- **Fixed:** the paper text as QASPER provides it (no PDF parsing, so parsing cannot
  confound the result), `bge-small-en-v1.5` as the embedder, `hybrid_rrf` as the retriever,
  pool of 20.
- **Arms:**
  - strategy: `recursive_character`, `markdown_header`, `token_based`, each at its defaults;
  - size: 128, 256, 512, 1024 tokens, with `recursive_character`;
  - overlap: 0, 10 and 20 percent, with `recursive_character` at 512.

The harness calls this repository's own plugins, so what is measured is the code the
playground ships, not a re-implementation.

## Metrics

**Per chunk set, before any retrieval:**
- gold paragraph contained whole in one chunk (share of questions);
- gold paragraph split across chunks (share);
- chunk token counts: median, p95, minimum, maximum;
- duplication factor: indexed tokens divided by document tokens;
- coverage: share of document text present in at least one chunk, which should be 1.0 and
  catches bugs;
- chunk count per paper.

**After retrieval, paired per question:**
- hit rate at 1, 5, 10;
- precision at 5, because several paragraphs can be relevant;
- recall at 5 and at the pool size, the latter being the ceiling any reranker could reach;
- MRR at 10;
- nDCG at 10, using QASPER's evidence as the relevant set.

**Cost:**
- chunks indexed, tokens indexed, index build seconds, index size;
- query latency, p50 and p95, timed on successful attempts only.

**Reported separately, not folded into any average:** unanswerable questions, and questions
whose evidence is not text.

## Assumptions and limits

- QASPER gives parsed text, not PDFs, so this experiment says nothing about parsing. That is
  deliberate: it isolates chunking.
- Scientific papers have clean section headings. Structure-aware chunking will look better
  here than on documents with weak structure, and the write-up must say so.
- One embedder and one retriever are fixed, so these results do not generalise to every
  combination. The index and retrieve experiments vary those.
- nDCG depends on how QASPER's evidence is graded. It is reported for comparison between our
  own arms, not against other papers' numbers.

## How to run it

```bash
python -m experiments.chunking_qasper.harness.run --limit 50 --out runs/pilot.jsonl   # pilot
python -m experiments.chunking_qasper.harness.run --out runs/full.jsonl               # full
python -m experiments.chunking_qasper.harness.report --runs runs/full.jsonl
```

The pilot must report: the baseline arm's numbers, the count of excluded questions, and the
projected wall clock and memory for the full run. Nothing long starts without that.

## Protocol amendments

None yet. Amendments are appended here with a date, never written over the text above.
