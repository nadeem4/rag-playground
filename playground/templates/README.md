# Pipeline templates

A template is a real starting point for a pipeline, chosen for a kind of document or a
kind of question. There are two families, and you pick one of each:

- A **document template** sets the index side: how the document is parsed, cleaned, cut
  into pieces, embedded and stored. It lives in `documents/`.
- A **question template** sets the retrieval side and the answer: how the question is
  rewritten, how the index is searched, how the hits are reranked, and what the answer
  step does. It lives in `questions/`.

Pick one of each, add a document and run. Every pair works on the hosted demo. The first
run downloads the models the pair uses.

## Document templates

| Template | File | Good for | Sample |
| --- | --- | --- | --- |
| Text documents | `text.yaml` | Articles, policies and plain reports set in one column, with few tables. | chunking-primer |
| Reports with tables | `tables.yaml` | Financial reports, data sheets and studies where answers sit in table rows. | table-of-figures |
| Scanned PDFs | `scanned.yaml` | Scanned paper, photographed pages and any PDF whose text cannot be selected. | scanned-notes |
| Manuals and guides | `manuals.yaml` | Manuals, handbooks, guides and specifications with numbered or clearly styled headings. | chunking-primer |

- **Text documents** reads the PDF's text layer with pdfium, removes running headers,
  footers and repeated blocks, and cuts pieces of five sentences that share one sentence.
- **Reports with tables** reads the layout with Docling, rebuilds tables with the
  accurate table model, and cuts along the layout so a table stays whole with its caption.
- **Scanned PDFs** reads the page images with Docling's OCR, removes near repeats, and
  cuts along the layout.
- **Manuals and guides** reads heading levels with Docling's heading hierarchy, starts a
  new piece at each heading down to level 3, and searches each piece with its heading path.

Every document template embeds with `qwen3-embedding-0.6b` and stores in lancedb with
its keyword index, which the hybrid search in every question template needs.

## Question templates

| Template | File | Good for | Key |
| --- | --- | --- | --- |
| Balanced | `balanced.yaml` | Everyday questions, and questions whose answer is spread over several places. | No |
| Exact terms | `exact.yaml` | Questions that name a part number, a product, a person, a code or a clause. | No |
| Best precision | `precision.yaml` | Single-fact questions, where the one right piece must come first. | No |
| Vague questions | `vague.yaml` | Short or loosely worded questions that use different words from the document. | Yes |
| Chat answer | `chat.yaml` | Questions you want answered in a sentence or two, with each claim pointing at its source. | Yes |

- **Balanced** runs hybrid search (`hybrid_rrf`, 20 candidates), then MMR, which keeps
  the top five from repeating each other.
- **Exact terms** runs a wide hybrid search (40 candidates) with a small fusion constant,
  so the keyword search's best match counts most, then the MiniLM cross-encoder.
  `hybrid_rrf` has no keyword weight, so the fusion constant is the setting that leans
  toward keywords.
- **Best precision** runs hybrid search (30 candidates), then the stronger
  `BAAI/bge-reranker-base` cross-encoder.
- **Vague questions** asks Claude Haiku 4.5 to restate the question in the document's
  words, then runs Best precision's search and reranker. It needs an Anthropic key.
- **Chat answer** is Best precision, then Claude Sonnet 5 answers from the top five pieces
  and cites them. It needs an Anthropic key.

The playground's Starter (`samples/starter.yaml`) is Docling, `dedupe_blocks`, the
`recursive_character` chunker and hybrid search with no reranker. It is closest to
Reports with tables and Balanced, but it is not one of the pairs.

## The format

Each file is part of a Pandion pipeline file, plus a `template:` block. A document
template holds `index`; a question template holds `retrieve` and `answer`. Every setting
has a one-line comment that says why it was chosen.

```yaml
template:
  name: Best precision              # shown in a picker
  summary: Hybrid search, then ...  # one line
  good_for: Single-fact questions, where the one right piece must come first.
  # sample: table-of-figures        # document templates only: the bundled sample that suits it
retrieve:
  search: {use: hybrid_rrf, top_k: 30}
  rerank: [{use: cross_encoder, model: BAAI/bge-reranker-base, top_k: 5}]
answer: {use: search, top_k: 5}
```

## Using them

`compose` in `playground/templates/__init__.py` joins a pair into a full pipeline and
leaves out the `template:` blocks. It reads YAML only, so it imports nothing from Pandion.

```python
from pandion import Pipeline
from playground import templates

p = Pipeline.from_dict(templates.compose("tables", "precision", path="./my-index"))
p.index.run("report.pdf")
print(p.ask("What was the revenue in 2024?").text)
```

- The playground serves both families at `GET /api/templates`, each template with its
  metadata and its pipeline part.
- [`examples/pandion/run_template.py`](../../examples/pandion/run_template.py) runs a
  pair with Pandion, and
  [`examples/pandion-api/run_pipeline.py --template`](../../examples/pandion-api/run_pipeline.py)
  runs one through pandion-api.
- `tests/integration/test_template_parity.py` checks that every pair is valid for
  Pandion and pandion-api. Its `models` test runs each pair that needs no key through
  both, and checks they make the same pieces, the same hits in the same order and the
  same result ids. Release checks run it.
