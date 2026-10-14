# Strategies

Every step of the pipeline is a strategy you can swap. This page lists each one, what it
does, what its settings change and when to use it. Most of the wording comes from the
strategies' own descriptions, which the app shows in each card's info button.

Each strategy is listed with its plain name, as the app shows it, and its code name, as
the API and exported files use it.

## Contents

- [The steps](#the-steps)
- [Document](#document)
- [Parse](#parse)
- [Clean](#clean)
- [Chunk](#chunk)
- [Index](#index)
- [Query and rewrite](#query-and-rewrite)
- [Search](#search)
- [Rerank](#rerank)
- [Answer](#answer)
- [What each step passes to its library](#what-each-step-passes-to-its-library)

To write a strategy of your own for any step, see "Write your own strategy" in
[pandion.md](pandion.md#write-your-own-strategy).

## The steps

Indexing runs once per document: Document, Parse, Clean, Chunk, then Index. Asking runs
once per question: the question (optionally rewritten), Search, Rerank, then Answer.

Clean and Rerank are stackable: their input and output are the same kind of thing, so you
can add more than one, for example two cleaners in a row.

## Document

**Upload** (`upload`) takes a file you uploaded, or a bundled sample. Files are stored
once, named by a fingerprint of their bytes, so the same file used in several pipelines is
a single copy on disk.

## Parse

Parsing turns the PDF into text elements (headings, paragraphs, lists and tables) with
their pages and positions.

### Fast text (`pdfium`)

Reads the text stored in the PDF, in the order the PDF drew it. It cannot tell a heading
from a paragraph, so every block comes out as a plain paragraph, and a scanned page with
no stored text comes out empty. Fast, with no model to load.

- `join_lines` (on by default): rebuilds paragraphs from the page layout. Off, it keeps
  one element per extracted line.
- `paragraph_gap_ratio` (1.5): with lines joined, a line starts a new paragraph when the
  gap above it is more than this many times the page's usual line spacing. Raise it when
  paragraphs come out split; lower it when they run together.

**Use it** as a fast baseline, or to see what a parser without a layout model misses.

### Docling (`docling`)

Renders each page as an image and runs a layout model that labels every region: title,
section heading, list item, table, page header and footer. A reading-order model then
puts the regions in sequence. Much slower than Fast text, with far more structure.

Its options are Docling's own parameters:

| Setting | Default | What it does |
|---|---|---|
| `do_ocr` | off | Docling's `PdfPipelineOptions.do_ocr`. Reads text from page images with OCR. Only needed for scanned PDFs with no text layer; it is much slower. |
| `do_table_structure` | on | Docling's `PdfPipelineOptions.do_table_structure`. Recovers the rows and columns of detected tables, so a table reaches the chunks as a markdown table instead of loose text. |
| `table_mode` | `fast` | Docling's `TableStructureOptions.mode`, `fast` or `accurate`. Fast is fine for simple grids; accurate handles merged cells better and takes longer. |
| `content_layers` | `body` | Docling's `included_content_layers`: which layers of the page are read into the text. `body` is the main content and is always read. `furniture` is page headers and footers. `background` is watermarks. `invisible` is hidden text. `notes` are author or speaker notes. |
| `heading_hierarchy` | off | Docling's `HeadingHierarchyOptions.enabled`. Docling infers heading levels from the layout, reading PDF bookmarks first, then numbering such as 1. and 1.1, then font size and style, so a subsection sits under its section instead of beside it. When off, every heading is at the same level. Turning it on also turns on Docling's `generate_parsed_pages`, which keeps the parsed pages in memory so font style can be read. |

With only the body layer read, page headers and footers stay out of the text, and the run
note says how many were set aside. Add `furniture` if Docling mistook a real line near a
page edge for one.

**Use it** for real documents. It is the recommended parser. Turn on `do_ocr` for the
Scanned notes sample, and `heading_hierarchy` when you want By layout block to keep whole
sections together.

## Clean

Cleaners remove text that would pollute retrieval. Each one says what it removed.

### Remove headers and footers (`header_footer_strip`)

Finds running heads, running feet and page numbers: short blocks that sit first or last
on a page and repeat across pages, or look like a page number. It checks again after each
pass, because removing a page number can expose another footer behind it.

- `min_page_ratio` (0.5): the fraction of pages a block must appear on, at the same page
  edge, to count as a running head or foot.
- `drop` (on): removes the blocks found. Off, they are only retyped, which keeps them out
  of the text that is chunked while leaving them visible for inspection.
- `max_running_chars` (120): the longest a header or footer can be, in characters. A
  longer repeated block is the duplicate cleaner's job.
- `min_pages` (2): the fewest pages a header or footer must repeat on, whatever
  `min_page_ratio` says.

### Remove duplicate blocks (`dedupe_blocks`)

Removes a block whose text repeats an earlier block, keeping the first copy in reading
order. Blocks are compared only with blocks of the same kind, so a heading and a paragraph
with the same words are both kept.

- `scope`: `exact` (the default) compares normalized text; `near` compares by similarity.
- `similarity` (0.95): with `near`, how alike two blocks must be to count as duplicates.

### Remove matching text (`drop_matching`)

Removes every block whose text contains a pattern you name. Use it for boilerplate the
other cleaners miss, such as a notice repeated in the middle of pages.

- `pattern`: the text to look for. Empty removes nothing.
- `mode`: `contains` matches the pattern as plain text; `regex` treats it as a regular
  expression found anywhere in the block.
- `case_sensitive` (off): off means "Notice" also matches "notice".

## Chunk

Chunking cuts the text into the pieces that get indexed and retrieved.

### Heading context

`recursive_character` and `layout_blocks` have a `heading_context` setting, on by default.
When on, the heading path where a piece starts, for example "Experience > a role", is put
in front of the piece's text before it is turned into a vector, less the headings the
piece already opens with. Retrieval then sees the section name, while the piece that is
shown and cited does not change. A document without headings is not affected.

### Recursive, natural breaks (`recursive_character`)

Cuts at paragraph breaks first. A paragraph too long for one piece is cut at line breaks,
then at sentence ends, then at spaces, so each cut lands on the most natural boundary
available. The parts are then packed together until a piece is full.

- `chunk_size` (400 characters) and `chunk_overlap` (80 characters).
- `heading_context` (on).

**Use it** as a sound default that works with any parser.

### By heading (`markdown_header`)

Cuts at headings, so each piece is one section: a heading and everything under it, up to
the next heading. A section too long for one piece is cut between its blocks, and only a
single block that is itself too long is cut mid-text. Pieces do not overlap.

- `max_tokens` (512).

It prefers a parser that finds headings. With Fast text, which finds none, it falls back:
the whole document is treated as one section and cut by size, and the card says so before
you run.

### Fixed token count (`token_based`)

Counts tokens and cuts each time the count is reached, wherever that falls. A token here is
a word or a single punctuation mark. It ignores the structure of the text completely.

- `max_tokens` (512) and `overlap` (64).

**Use it** as a baseline to compare the other chunkers against.

### By layout block (`layout_blocks`)

Cuts along the page's own blocks: headings, paragraphs, lists and tables. A table stays
with its caption and its heading, and each section starts a new piece. Blocks are packed
together up to the size limit, and a block is only cut when it is too long on its own.

- `max_tokens` (400).
- `keep_tables_whole` (on): a table too long for one piece stays whole. Off, it is cut
  like any other long block, which is cut at sentence ends.
- `heading_context` (on).
- `section_level` (6, from 1 to 6): how deep a heading can be and still start a new
  section. A new section starts only at a heading whose level is at or above this depth;
  6 means every heading starts one. Levels are Docling's heading levels: a title is 1 and
  section headings start at 2. With `heading_hierarchy` on, subsections nest below their
  section; with it off, section headings share one level. A deeper heading stays inside
  the piece as text and still names the pieces below it in their heading path. The run
  note lists the levels in the document.

It prefers Docling. Without headings it falls back to cutting by size, and says so.

**Use it** with Docling, especially for tables and documents with clear sections. To keep
whole sections together, turn on `heading_hierarchy` on Parse and lower `section_level`
to the level of the sections.

### By sentence (`sentence_window`)

Cuts only where a sentence ends, so an answer sentence is never cut in half. Each piece is
a fixed number of sentences in a row, and neighbouring pieces can share a few sentences.

- `sentences_per_chunk` (5) and `overlap_sentences` (1), which must be fewer.

A list item and a table row each count as one sentence. A heading line is not a sentence
of its own and joins the sentence after it, so no piece ends on a bare heading. It works
with any parser.

**Use it** when answers are single sentences and you never want one cut.

## Index

### LanceDB (`lancedb`)

Turns every piece into a vector (a list of numbers that captures its meaning) with an
embedding model, and stores it in a LanceDB table with a keyword index over the same rows.
Vector search and keyword search then read the same pieces, which is what lets hybrid
search combine them fairly.

- `embedder`: `qwen3-embedding-0.6b` (the default, 1024 dimensions) or `bge-small-en-v1.5`
  (384 dimensions). `fake-deterministic` is a hashing embedder for tests. See
  [models-and-keys.md](models-and-keys.md).
- `truncate_dim`: Matryoshka truncation for Qwen3: keep only the first dimensions of each
  vector. Full width gives the best matches; a smaller width is cheaper. It cannot be set
  for bge-small. Compare offers 1024, 512, 256, 128 and 64.
- `metric`: `cosine` (the default) or `l2`.
- `build_fts` (on): builds the keyword index. BM25 and Hybrid need it.

## Query and rewrite

### The question (`text`)

The question, exactly as you type it. It is a step of its own, so trying another question
reruns only retrieval and what follows. It can also carry the gold answer: the sentence or
sentences in the document that answer it, which Evaluate uses.

### PRF

Pseudo-relevance feedback is a setting of Hybrid search, `query_expansion: prf`. It adds
the most distinctive words of the top dense hits to the keyword search; the dense search
is unchanged.

- `prf_docs` (2, from 1 to 10): how many of the top dense hits the words are borrowed from.
- `prf_terms` (6, from 1 to 20): how many words are added, chosen by tf-idf (frequent in
  those hits, rare in the whole document).

It needs no key. It helps a question asked in your own words, and can cost a place when
the question already matches the document. Choosing PRF in the Ask panel switches the
search to Hybrid.

### LLM rewrite (`llm_rewrite`)

Asks a chat model to restate your question in the words the document would use, and
searches with that, reading the first 1,500 characters of the parsed document. The answer
still uses your question as typed. It needs an API key and makes one model call per
question.

- `model`: the same choices as the chat answer. Claude Haiku 4.5 by default.
- `style`: `document words` restates the question in the document's words; `keywords`
  turns it into six to ten search words.

**Use it** when the question and the document use different words for the same thing.

## Search

Each search hands on a pool of candidates, 20 by default (`top_k`).

### Dense (`dense`)

Turns the question into a vector with the same model the index used, and returns the
pieces whose vectors are closest. It matches meaning, so it finds paraphrases, but it can
miss exact names, codes and rare words.

### BM25 (`bm25`)

Scores pieces by the words they share with the question, counting rare words for more
than common ones (the BM25 formula). It finds exact names, codes and terms that vector
search can miss, but it does not know that different words can mean the same thing.

### Hybrid, RRF (`hybrid_rrf`)

Runs vector search and keyword search side by side, then merges the two ranked lists by
position rather than by score (reciprocal rank fusion). A piece near the top of both lists
wins, so it gets the strengths of both searches.

- `rrf_k` (60): the fusion constant. A larger value flattens the difference between ranks.
- `query_expansion`, `prf_docs` and `prf_terms`: see [PRF](#prf).

**Use it** as the default. It is the safest choice when you do not know whether the
question shares words with the answer.

## Rerank

A reranker picks the best few from the search's candidates, 5 by default (`top_k`).

### Cross-encoder (`cross_encoder`)

Reads the question and each candidate piece together and gives the pair one relevance
score. It is slower than the search's comparison but more accurate, so it only reorders
the small pool of candidates the search found.

- `model`: a sentence-transformers CrossEncoder. `cross-encoder/ms-marco-MiniLM-L-6-v2`
  (the default) is small and fast; `BAAI/bge-reranker-base` is stronger;
  `BAAI/bge-reranker-v2-m3` is strongest and slow on a CPU.

**Use it** for single-fact questions. It needs no key.

### MMR (`mmr`)

Maximal Marginal Relevance picks results one at a time, each time taking the piece the
search scored highest while being least like the pieces already picked. It trades
relevance for variety, so it can drop near-duplicates instead of only reordering them. It
reuses the index's own vectors to judge likeness, so it needs no extra model. It does need
numpy, from the `local` extra; see "mmr (numpy)" below for what it sets.

- `lambda_mult` (0.5): the balance between relevance and variety.

**Use it** for questions with several good answers, not a single-fact question, where no
reranker or the cross-encoder does better.

### LLM (`llm_rerank`)

Asks a chat model to read the question and every candidate piece and put the pieces in
order of relevance. It reads the first 600 characters of each piece. It needs an API key,
makes one model call per question, and its order can change between runs.

- `model`: the same choices as the chat answer. Claude Haiku 4.5 by default.

## Answer

### Search (`search`)

Shows the retrieved pieces as a ranked list with their scores and pages. No language
model, no API key and no cost: you see exactly what retrieval found.

- `top_k` (5) and `max_snippet_chars` (400).

### Chat with a model (`chat`)

Sends the retrieved pieces and your question to a chat model, which answers using only
those pieces. Every claim points at the passages it relied on, and each citation is
checked against the parsed document; one that does not match is marked unverified.

- `model`: Claude Opus 5 (the default), Sonnet 5 or Haiku 4.5; GPT-6 Astra, GPT-5.6 Sol or
  GPT-5.6 Luna; a model on OpenRouter; or a custom OpenAI-compatible endpoint. See
  [models-and-keys.md](models-and-keys.md).
- `citation_method`: `auto` uses Claude's own citations for a Claude model and sentence
  ids for any other; `sentence_ids` uses sentence ids for every model. With sentence ids,
  each retrieved sentence gets an id, the model writes the ids after each claim, and the
  playground quotes those sentences itself.
- `support_threshold` (0.55): with sentence ids, each claim is compared with the sentences
  it cites using the index's embedder. Above the threshold it counts as cited; below, as
  weak. A claim that cites nothing but matches a shown sentence is marked matched by
  similarity, and one with no match is not grounded.
- `max_chunks` (5): how many pieces the model reads.

It needs a key for the chosen provider. A custom endpoint's key is optional.

### Evaluate's check (`eval`)

Checks whether the retrieved pieces contain the sentence that answers the question, and
reports where it was found: hit or miss, the rank, and which piece. No language model, no
API key and no cost: it compares text with text. The Evaluate page runs it over every
question in a set, and so does `pandion.evaluate` (see [the pandion guide](pandion.md#evaluate-a-pipeline)). It is not an answer step: `answer: {use: eval}` is refused.

- `top_k` (5): how many pieces are checked.
  `pandion.evaluate(p, questions, top_k=5)` sets it.

## What each step passes to its library

Many steps call a library to do the work. This section says, for each built-in step, which
of the library's options Pandion sets and which it leaves at the library's own default, so
you know what a result depends on. A setting that is not listed here is not passed, and
the library's default applies.

These steps call no library and run only Pandion's own code: `upload`, `header_footer_strip`,
`drop_matching`, `recursive_character`, `markdown_header`, `token_based`, `layout_blocks`,
`sentence_window`, `text`, `search` and `eval`. `hybrid_rrf` runs LanceDB's two
searches, then fuses them with Pandion's own code.

### pdfium (pypdfium2)

- Sets: the PDF is opened from its bytes with `PdfDocument(data)`. Each page's text is read
  with `get_text_range()`. With `join_lines` on, the box of each character is read with
  `get_charbox(i, loose=True)`, to rebuild paragraphs from the layout.
- Leaves at the default: `get_text_range` reads the whole page (`index=0`, `count=-1`) and
  ignores characters it cannot decode (`errors="ignore"`). No password is given. pdfium
  has no OCR.

### docling (Docling)

- Sets in `PdfPipelineOptions`: `do_ocr`, `do_table_structure`,
  `table_structure_options.mode` (from `table_mode`), `heading_hierarchy_options.enabled`
  (from `heading_hierarchy`), and `generate_parsed_pages`, which is on only when
  `heading_hierarchy` is. The text is read with
  `iterate_items(included_content_layers=...)` from `content_layers`, and each table with
  `export_to_markdown()`.
- Leaves at the default: the OCR engine (`ocr_options`, `auto`), table cell matching
  (`do_cell_matching`, on), the device and threads (`accelerator_options`, `auto`), the
  page image scale (`images_scale`, 1.0), the layout model (`layout_options`, Heron),
  picture classification and description, chart extraction, code and formula enrichment
  (all off), page, picture and table images (off), and the time limit per document
  (`document_timeout`, none).

Note that Docling's own default for `table_structure_options.mode` is `accurate`;
Pandion's default `table_mode` is `fast`.

### dedupe_blocks (Python's difflib)

- Sets: with `scope: near`, two blocks are compared with `SequenceMatcher(None, a, b)`
  and its `ratio()`.
- Leaves at the default: `autojunk` (on), which ignores very common characters in texts
  of 200 characters or more.

### lancedb (LanceDB and pyarrow)

- Sets: one table called `chunks`, with the vector column as a fixed-size list of float32
  numbers, so LanceDB can search it. With `build_fts` on, a full-text index on the `text`
  column with `FTS()`.
- Leaves at the default: every `FTS()` option: the `simple` tokenizer, English, lower
  case, stemming, stop words removed, ASCII folding, and no positions (so no phrase
  search). No vector index is built, so a search compares the question with every vector
  exactly instead of approximately.

### dense, bm25 and hybrid_rrf (LanceDB)

- Sets: `dense` runs `table.search(vector).distance_type(metric).limit(top_k)`, with the
  metric the index was built with. `bm25` runs
  `table.search(question, query_type="fts").limit(top_k)`. `hybrid_rrf` runs both, each
  with `limit(top_k)`.
- Leaves at the default: LanceDB's BM25 scoring parameters, and no filter.

### Embedders (sentence-transformers)

`qwen3-embedding-0.6b` and `bge-small-en-v1.5`; `fake-deterministic` calls no library.

- Sets in `SentenceTransformer(...)`: the model id and a pinned `revision` (a commit), the
  `device`, `cache_folder` and `local_files_only` from the model settings, and float32
  (`model_kwargs={"dtype": torch.float32}`). In `encode(...)`: `batch_size=16` and
  `normalize_embeddings=True`. For a question, Qwen3 gets its own `query` prompt
  (`prompt_name="query"`), and bge-small gets the prefix "Represent this sentence for
  searching relevant passages: ".
- Leaves at the default: the longest text the model reads (`max_seq_length`, the model's
  own; a longer text is cut by the model), and the model's pooling.

### cross_encoder (sentence-transformers)

- Sets in `CrossEncoder(...)`: the model id, the `device`, `cache_folder` and
  `local_files_only` from the model settings. In `predict(...)`: one (question, piece)
  pair per candidate.
- Leaves at the default: the model's revision (its main branch, not pinned), the longest
  pair it reads (`max_length`, the model's own), `batch_size` (32), and the activation, so
  the scores are the ones the model gives.

### mmr (numpy)

MMR needs the `local` extra, which brings numpy.

- Sets: the hits' vectors, embedded again with the index's own embedder and width
  (through the embedding cache, so usually a lookup), become a float64 array
  (`np.asarray(..., dtype=float)`). The likeness of two pieces is the dot product of their
  vectors (`vectors @ vectors.T`), which is the cosine because the vectors have length 1.
  The search scores are scaled to 0 to 1 with numpy. The first pick is the most relevant
  piece, and each next pick is the `np.argmax` of `lambda_mult` times relevance minus
  `1 - lambda_mult` times the highest likeness to a piece already picked.
- Leaves at the default: nothing else is passed to numpy. The embedder's own options are
  as listed under Embedders.

### llm_rewrite, llm_rerank and chat (Anthropic and OpenAI SDKs)

- Sets: the model, a system prompt, one user message, and a limit of 16,000 output
  tokens (`max_tokens`, or `max_completion_tokens` for OpenAI). For Claude Opus 5 and
  Sonnet 5, adaptive thinking is on. `chat` with a Claude model and `citation_method:
  auto` sends each piece as a document with citations on, through
  `client.beta.messages.create`.
- Leaves at the default: `temperature`, `top_p` and the other sampling settings, so the
  provider's defaults apply and two runs can give different text.
