# Lessons from building a RAG pipeline

This is a working document. We keep it up to date as we build RAG Playground. Each entry is one real problem we hit in the pipeline, in the order the pipeline runs: parsing, chunking, retrieval, reranking, caching and evaluation. Every entry can be read on its own.

## Parsing

### pdfium gave us lines, not paragraphs

2026-09-20, commit `c680427`

**The problem.** With the `pdfium` parser, every visual line of a paragraph came out as its own block. The chunker then cut the text wherever the size ran out, so pieces often stopped in the middle of a sentence.

**Why it was broken.** pdfium marks a line break after every line it draws on the page, and it never marks the end of a paragraph. Our `recursive_character` chunker tries to cut at paragraph breaks first. Because there were no paragraph breaks, that first choice never applied.

**What fixed it.** A `join_lines` option on the pdfium parser, on by default. It joins lines back into paragraphs by looking at the vertical gap between lines. With `join_lines` off, the old output comes back exactly, so the two can be compared side by side.

**Why the fix worked.** Lines in the same paragraph sit close together, and a new paragraph starts after a bigger gap. Measuring that gap rebuilds the paragraphs the PDF never recorded, so the chunker has real paragraph breaks to cut at.

**What we learned.** A PDF stores text as positioned lines, not as paragraphs. Check what your parser actually returns before you tune the chunker, because the chunker can only cut at breaks the parser gives it.

### A scanned PDF has no text to read

2026-09-29, commit `c41bef7` (the `scanned-notes` sample); 2026-10-06, commit `283ee0f` (PR #52)

**The problem.** A scanned PDF is a set of pictures of pages. The parse returned no text, so the pipeline made no pieces and every question missed.

**Why it was broken.** A normal PDF carries a text layer: the letters themselves, stored as text. A scanned PDF only has images. A parser that reads the text layer finds nothing to read, and it does not fail loudly. It just returns an empty document.

**What fixed it.** OCR (optical character recognition), which reads letters out of the page images. Docling has it as `do_ocr`. It is off by default because it is slow: about 10 seconds a page. Since `283ee0f`, a parse that finds no text says the PDF may be scanned and offers to turn OCR on. The miss trace also treats parsed text with fewer than 20 words as a sign of a scanned page.

**Why the fix worked.** OCR creates the text layer the scan was missing. In the `scanned-notes` sample, all 8 questions miss without OCR and all 8 are found with it.

**What we learned.** An empty parse is a result, not an error, so nothing tells you it happened. Check how much text the parser found before you blame search, and decide on purpose whether to pay for OCR.

### Docling hid the last lines of a resume as a page footer

2026-10-03, commits `efb07f6` (v0.10.1) and `9f10368` (v0.11.0)

**The problem.** On the author's one-page resume, the Education lines at the bottom of the page were missing from the index. Questions about education could never be answered.

**Why it was broken.** Docling's layout model decides what each region of a page is, mostly from where it sits. It labelled lines about 71 points from the bottom edge as `page_footer`. Docling files page headers and footers in a separate content layer called furniture, and its `iterate_items()` reads only the body layer by default. Our plugin read only the body layer, so those lines never reached the text, and nothing said so.

**What fixed it.** First (v0.10.1), the plugin read both layers, showed header and footer blocks in the parse view, and wrote a note saying how many blocks were set aside. Then (v0.11.0) we replaced our own on and off switch with Docling's real option, `content_layers`, which is Docling's `included_content_layers`. It defaults to `["body"]`. Adding `furniture` reads page headers and footers into the text. The run note always counts what is in the furniture layer, and says to add `furniture` if something near a page edge is missing.

**Why the fix worked.** The lines were never lost by Docling. They were filed in a layer we did not read. Counting that layer on every run makes the drop visible, and reading it brings the lines back.

**What we learned.** Layout models classify by position, so real content near a page edge can be taken for a footer. Silent drops are the worst kind of failure, because nothing looks wrong. Every step that removes text should say how much it removed. Use the library's own option names, so a learner can copy them into their own code.

### Docling put every heading at the same level

2026-10-03, commit `e389bbf`

**The problem.** On the resume, Docling found 10 headings and gave them all the same level. A job title did not sit under Experience; it sat beside it. So a piece's heading path, the list of headings above it, was only one heading deep.

**Why it was broken.** Docling's layout model marks a region as a section header but does not give it a level. Without more work, every heading is level 1.

**What fixed it.** Docling's `heading_hierarchy` option, which is `HeadingHierarchyOptions.enabled`. It infers levels from PDF bookmarks first, then numbering such as 1. and 1.1, then font size and style. It also needs `generate_parsed_pages`, because Docling drops the page details it reads fonts from unless that is set. We turn both on together.

**Why the fix worked.** With real levels, the roles nest under Experience, and the chunkers can prefix a piece with a heading path that names its section. On the resume, 7 of 8 pieces then got a heading prefix.

**What we learned.** A heading path is only as good as the heading levels the parser gives you. This did not fix the resume's "current employer" question (see the retrieval section), so measure before you assume structure will help search.

## Chunking

### A heading became a piece on its own

2026-10-01, commits `a41fc75` and `65d7c99`

**The problem.** The By layout block chunker (`layout_blocks`) sometimes made a piece that held nothing but a heading, such as "# Data". The heading's content went into the next piece, without its title.

**Why it was broken.** The chunker started a new piece at every heading. When the block below a heading was too big to fit with it, such as a large table kept whole or a long paragraph, the heading was left alone. A run of headings, such as a chapter title followed by its first section title, had the same problem.

**What fixed it.** A heading now always joins the piece below it, even when that piece is a table kept whole or the first part of a long paragraph. Headings in a row open one section together and join the body below them. The only heading that stands alone is a last heading with nothing below it.

**Why the fix worked.** A heading only means something next to the text it introduces. Keeping them in one piece gives search both the title words and the content words in the same place.

**What we learned.** A piece that holds only a heading wastes a search slot and can match a question while giving no answer. Check your smallest pieces, not only your average size. A piece can run a little over the size limit when a heading joins it, and that is the better trade.

### Cutting by size breaks sentences

2026-10-01, commit `291262e`

**The problem.** Size-based chunkers such as `recursive_character` cut where the size runs out. A sentence longer than what is left of a piece is split across two pieces, and neither piece holds the whole answer.

**Why it was broken.** A size limit in characters or tokens knows nothing about sentences. In our chunking primer sample, one answer is a sentence longer than a piece at the default `chunk_size` of 400, so it is lost at the chunking step.

**What fixed it.** A By sentence chunker (`sentence_window`). It splits the text into sentences, then makes each piece from `sentences_per_chunk` whole sentences (5 by default), with `overlap_sentences` shared between neighbours (1 by default). Bigger pieces (800 characters) also find the primer's long sentence.

**Why the fix worked.** The chunker only cuts where a sentence ends, so a sentence is never split. A heading line, a list item and a table row each count as one sentence.

**What we learned.** Pick where pieces may end, not only how big they are. A size limit is easy to set, but the cut points decide whether an answer survives chunking.

## Retrieval

### Retrieve handed on only the final top results

2026-09-21, commit `2485cba`

**The problem.** A reranker could only shuffle the same 5 pieces that search had already chosen. It could never bring up a better piece from lower down.

**Why it was broken.** The retrievers fetched 20 rows but handed on only `top_k=5`. A reranker reorders what it is given, so with 5 in, it had 5 to choose from.

**What fixed it.** The retrievers (`dense`, `bm25` and `hybrid_rrf`) now hand on a candidate pool: `top_k=20`. The reranker picks its own top 5 from that pool. The separate `fetch_k` setting was removed. In the same week (commit `c0131b2`), the sample pipeline moved to smaller pieces, `chunk_size` 400 and `chunk_overlap` 80 instead of 1000 and 200, so a short sample makes more pieces than search shows.

**Why the fix worked.** Reranking is a second, more careful look at a wider list. It only helps when the list it gets is wider than the list it returns.

**What we learned.** Retrieve wide, then rerank narrow. Check how many candidates reach the reranker, not only how many come out.

### The question used words the document never uses

2026-10-03, commits `f84d9e1` (PRF) and `0894c20` (LLM rewrite)

**The problem.** On the author's resume, "Who is my current employer?" returned the summary or the education block. The right piece was retrieved, but it ranked 5th of 12, so it was not near the top.

**Why it was broken.** The words "current" and "employer" never appear in the resume; it says "Present". So keyword search (BM25) matched no piece at all, and hybrid search fell back to dense search alone. Dense search compares meaning as vectors, but on a one-person document every piece is about the same person, so the scores were flat: 0.15 to 0.33. Several pieces scored above the right one. This is called a vocabulary gap: the question and the answer use different words.

**What fixed it.** Rewriting the question before search, in two ways. PRF (pseudo-relevance feedback), set with `query_expansion: prf` on `hybrid_rrf`, borrows words from the top dense hits (2 hits and 6 terms by default) and adds them to the keyword search. An LLM rewrite step, `llm_rewrite`, asks a language model to restate the question in the words a document would use, and keeps the question as typed for the answer.

**Why the fix worked.** A rewrite gives keyword search a word it can match. A rewrite in the resume's own words ("current employer company present role") put the right piece at rank 1. PRF alone moved it from 5 to 3 or 4. The LLM rewrite reached rank 1 with the right words, but only 2 or 3 until its prompt asked for section and date words and never names.

**What we learned.** When a question shares no words with the answer, better ranking cannot fix it; the question needs new words. PRF cost a place when the question already matched, so it is off by default and is a teaching option. The LLM rewrite is the real fix. Measure on the real document before promising a rank.

## Reranking

### MMR threw away hybrid search's ranking

2026-10-03, commit `41db1a0`

**The problem.** MMR (maximal marginal relevance), a reranker that trades a little relevance for variety, made good results worse. On the resume, the right piece fell from hybrid rank 5 to 6 to 8, and even a rank 1 after a rewrite fell to 5. Setting `lambda_mult=1.0`, which should mean "relevance only, keep the order", still changed the order.

**Why it was broken.** MMR worked out relevance itself, as the dense cosine between each piece and the question. That ignored the keyword half of hybrid search, which was the half that found the match. Then MMR pushed down pieces that looked like other pieces, and on a resume many pieces look alike.

**What fixed it.** MMR now uses the retriever's own score as relevance, scaled from 0 to 1 across the pool (min-max). It still uses the index's vectors, but only to judge how alike two pieces are.

**Why the fix worked.** Scaling keeps the retriever's order, whatever kind of score it is: a cosine, a BM25 score or a small RRF score. So `lambda_mult=1.0` now returns exactly the order it was handed, and a keyword match found by hybrid search counts in full.

**What we learned.** A reranker should build on the retriever's judgement, not quietly replace it with a weaker one. Test that the "do nothing" setting really does nothing.

### Rerankers judged the rewritten question

2026-10-03, commit `d698ef4`

**The problem.** After we added the LLM rewrite, the cross-encoder and LLM rerankers scored each piece against the rewritten question, not the question the person typed. We caught this the same evening, before release.

**Why it was broken.** The rewrite replaces `Query.text`, and the rerankers read `Query.text`. A rewrite is made for search: it is a bag of likely words, such as "capital France city". A reranker's job is to judge whether a piece answers the real question, and it cannot do that well against a list of keywords.

**What fixed it.** The rewrite keeps the typed question in `Query.original`, and `Query.asked` returns it. The `cross_encoder` and `llm_rerank` rerankers now score against `Query.asked`. Tests check that the reranker sees the typed question and never sees the rewrite.

**Why the fix worked.** Only retrieval sees the rewrite. Every step that judges or answers, the rerankers, the answer and the evaluation, sees what the person actually asked.

**What we learned.** When you rewrite a query, decide which steps see the rewrite and which see the original. A rewrite that helps search can quietly hurt every later step if it leaks.

## Caching

### MMR's cache key ignored its own settings

2026-09-20, commit `4b795c8`

**The problem.** Any pipeline that contained the MMR reranker crashed before the reranker ran.

**Why it was broken.** Each step's cache key (its recipe hash) includes a fingerprint of the model it uses, so a different model gives a different saved result. The engine calls `fingerprint(config)`. MMR declared `fingerprint(self)` without the config, so the call failed. MMR's fingerprint also read the default settings rather than the step's own settings, so a step with a different embedder would have had the same fingerprint as the default. The contract tests missed it because they only ever called `fingerprint()` with no argument.

**What fixed it.** MMR's `fingerprint` now takes the step's config and reads the embedder from it. The contract tests call it both ways, with and without a config, for every plugin.

**Why the fix worked.** The fingerprint now matches what the step will actually use, so changing the embedder changes the cache key, and the engine's call works.

**What we learned.** A cache key must include everything the result depends on, read from the step's real settings, never from defaults. When a step's behaviour changes, change its key too; we bump a plugin's `version` for that, as `d698ef4` did for both rerankers. Test plugins the way the engine calls them.

## Evaluation

### Too few pieces make every question pass

2026-09-21, commit `c0131b2`; 2026-09-30, commit `bb33e3d`

**The problem.** On a short document with big pieces, the pipeline made only a handful of pieces. When the evaluation checks the top 5 and there are only 5 pieces, every question finds its answer, and the score looks perfect.

**Why it was broken.** The score asks "is the answer in the top k pieces?". When k is close to the total number of pieces, that is true by chance. The score then says nothing about how good search is.

**What fixed it.** The sample pipeline uses smaller pieces (`chunk_size` 400, `chunk_overlap` 80), so there are more pieces than search shows. Evaluate now warns: with no more pieces than the top k, every question finds its answer and the score says nothing; with up to twice the top k, most questions find the answer by chance, so use smaller pieces or a lower `top_k`. The sample tests require at least 20 pieces.

**Why the fix worked.** A score only means something when most pieces are not checked. The warning makes a flattered score visible instead of trusted.

**What we learned.** Always read a retrieval score next to the number of pieces it was picked from. A perfect score on a tiny index is not evidence.

### Sample questions that never miss teach nothing

2026-10-10, commit `3bb27eb` (PR #64)

**The problem.** The bundled samples were 2 or 3 pages long, and none of their questions was built to miss on the default pipeline. Evaluate had nothing to explain, so a learner never saw a step fail.

**Why it was broken.** Easy questions on short documents pass whatever the settings. A test set that always passes cannot show the difference between two pipelines.

**What fixed it.** Bigger samples (4 to 6 pages, 8 to 12 questions each) with planted misses: questions designed to miss at a known step, each with a known fix. For example, in the chunking primer one answer is a sentence longer than a piece (lost at chunking), and one question uses words the document never uses (ranked far down; a PRF rewrite finds it). In the scanned notes, every question misses without OCR. Tags say which questions are planted, and `tests/test_sample_plants.py` checks every plant against the real pipeline.

**Why the fix worked.** Each plant fails for one reason, so a learner can change one setting and watch that question move from miss to found. The tests keep the plants true when a default changes elsewhere.

**What we learned.** A good evaluation set includes questions you expect to fail, and says why. Test that they still fail, because a change in one step can quietly turn a planted miss into a pass.

### Results on Windows and Linux were not the same

2026-10-10, commit `9dfbdd6` (PR #64)

**The problem.** Sample questions that were found at rank 5 on the Windows laptop missed on Linux, and a planted miss at rank 6 on Windows was found on Linux. Docling made 17 blocks of the chunking primer on Linux against 71 on Windows, and the repeated paragraph was not removed by the cleaning step there.

**Why it was broken.** Docling's layout model and the Qwen3 embedding model give slightly different results on different machines. Docling split the pages very differently, and Qwen3 ranks moved a place or two. The hosted app runs on Linux, so the Windows numbers were not the ones users see.

**What fixed it.** Linux is the source of truth. The slow model tests run on GitHub's Linux machines in the Release checks workflow (`release-checks.yml`). The sample questions now have margins: an ordinary question must be found in the top 3, not just the top 5; a planted search miss must come back 10th or lower; and every fix must find its plant in the top 3 (`FOUND_BY = 3` and `MISSED_FROM = 10` in `tests/test_sample_plants.py`). Recorded lesson checks test facts that hold on both systems, not exact counts.

**Why the fix worked.** A margin absorbs a shift of a place or two, so the result is the same on both machines. Checking on Linux checks what users actually get.

**What we learned.** Model outputs are not identical across platforms. Test on the platform you ship, and never write a test that depends on a result sitting exactly at the cut-off.

### A reworded passage counts as a miss

Found 2026-10-12 on a sample auto insurance policy PDF.

**The problem.** Search returned the right passage at rank 1, but the evaluation counted the question as a miss, and the miss trace said "Lost at Parse".

**Why it was broken.** Docling changed the text in two ways. It rewrote a numbered list ("1. $2,000; or 2. the Coverage CC limit") as bullets ("- $2,000; or"). It also mixed letters from a vertical "SAMPLE DOCUMENT" watermark into the sentences ("D If an insured person dies", "O 2. the Coverage"). The evaluation looks for the expected answer inside each piece: first exactly, then after a narrow clean-up that collapses spaces and line breaks, rejoins a word split by a hyphen at a line end, ignores capital letters, treats straight and curly quotes alike and expands ligatures such as "fi". There is deliberately no fuzzy matching, so a list marker that changed or a stray letter in the middle makes the passage "different text". The miss trace uses the same rule, so it blamed the parser.

**What fixed it.** Not fixed yet. The proposed fix is to also ignore list markers and stray single letters when matching, and to report a new kind of result, "found but reworded", so it is counted apart from an exact or normalised match.

**Why the fix worked.** Not fixed yet. The idea is that list markers and watermark letters are layout noise, not words of the answer. Ignoring only them would match this passage while still refusing real near misses. Reporting it as its own kind keeps the score honest about how loose the match was.

**What we learned.** A text-match evaluation measures the parser as well as the search. When search looks right but the score says miss, read the piece itself. Parsers reword more than spacing: list markers and watermarks change the text too.
