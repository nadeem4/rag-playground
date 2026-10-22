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

### Docling cut a sentence in two, but only on the hosted app

2026-10-13, PR #95

**The problem.** On the hosted app, the default pipeline found 9 of the chunking primer's 12 questions. GitHub's Linux machines found 10, with the same lockfile. The extra miss was "Why does structure-aware splitting cut at headings?". Its answer is one sentence that ended a paragraph: "...which is exactly what a good chunk should do."

**Why it was broken.** The sentence's last words, "chunk should do.", sat alone on the paragraph's short last line. On the hosted app's machine, Docling's layout model took the short last lines of three paragraphs on that page and put them together in one block of their own. The words were all still there, so nothing looked lost. But the answer now started in one block and ended in another, glued to the end of two other sentences, so no piece held it whole. We first guessed that Docling had filed the line as a page footer. Running Docling on the hosted app and reading its blocks showed the real cause.

**What fixed it.** We moved the answer sentence to the start of its section, right under the heading, so it no longer ends on a short last line. A new test, `test_no_answer_to_be_found_ends_on_a_short_last_line`, checks that no sample question meant to be found has its answer end on a line shorter than 45 characters. That fixed the hosted app, but GitHub's machines then ranked the answer 6th, one place below the 5 checked, because there Docling kept the whole section in one block and the piece holding the answer began with the end of the section before. So we tried six wordings of the question on both machines and kept the one in the top 3 on each: "What makes the text under one heading a good chunk?" (2nd on both).

**Why the fix worked.** Docling still groups the short lines on that page differently on the hosted app. Now no answer depends on one of them, so the answer stays whole in one block on every machine. A question that uses the answer's own words ranks it well however the pieces are cut.

**What we learned.** The same lockfile on a different machine can give a different parse. Test on the machine your users use: here that meant running Docling on the hosted app itself, not only on GitHub's Linux machines. And read the blocks before you name a cause: the guess was a footer, and the real cause was how Docling grouped lines into blocks. And a fix on one machine can break another: check every change on both before you merge.

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

### The Manuals template cut one level too high

2026-10-14, the `station-manual` sample and the template fix that followed it

**The problem.** The Manuals and guides template was meant to start a new piece at each heading numbered down to three parts, such as 1.2.3. On the new `station-manual` sample it cut only at headings such as 2.2. So two look-alike subsections, the frost alarm's and the wind alarm's "Choosing the threshold", which both say "set this threshold to 4", landed in one piece under the heading path "2 Setting up > 2.2 Setting the alarms". The two battery subsections, which both start "This part takes", shared a piece too.

**Why it was broken.** Docling's heading levels are offset by one. With `heading_hierarchy` on, it puts the document title and headings numbered like 1 at level 2, so 1.2 is level 3 and 1.2.3 is level 4. The template set `section_level: 3`, which counted levels as if 1 were level 1.

**What fixed it.** `section_level: 4` in the template, with a comment that says why. A fast test now pins the value, and a test that runs the real template on the sample checks that each look-alike subsection gets its own piece and its own heading path.

**Why the fix worked.** With 4, each subsection such as 2.2.1 Frost alarm starts its own piece, and its heading path names it. On the sample the pieces went from 14 to 26, each look-alike pair split into two pieces, and all 12 questions still ranked 1st.

**What we learned.** Read the levels the parser actually gives before you set a depth from them. Every question hit before and after the fix, so the hit rate hid the problem. Only looking at the pieces and their heading paths showed it, and a sample built with look-alike sections made it easy to see.

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

### A new rewrite was searched with the old results

2026-10-14

**The problem.** With the LLM rewrite on, asking the same question twice ran the rewrite again, but the search after it did not run. It handed back the search results of the first rewrite, even when the model had rewritten the question in different words. The same thing happened after the LLM reranker, and it would happen after any step marked `cacheable = False`, such as a source whose content can change.

**Why it was broken.** A step's cache key is a hash of its recipe: its settings and the keys of the steps above it, not their results. A step marked `cacheable = False` runs every time, but its key stays the same, because its settings do not change. So the search below it saw the same key as last time, found a stored result under that key and reused it, without looking at what the rewrite had just returned.

**What fixed it.** When a step reads from a step marked `cacheable = False`, its key now also includes a hash of what that step actually returned this time. `Store.put` in `packages/pandion/src/pandion/storage.py` takes the hash on the run's own temp folder before it moves it into place, and `packages/pandion/src/pandion/executor.py` keeps it for the rest of the run. Reading the shared folder later would not be safe: two runs of the same question write the rewrite to the same place, so the second could change the hash under the first. The non-cacheable step keeps its own key, so it can still be fetched by it. A pipeline with no such step keeps exactly the keys it had before.

**Why the fix worked.** A different rewrite now gives the search a different key, so the search runs on the new words. The same rewrite gives the same key, so the search is still read from the cache. Everything below the search follows, because each key includes the key above it.

**What we learned.** A key built from how a result was made is only safe if every input to it is either fixed by its recipe or part of its key. A step that may return something new each time breaks that, so the steps after it must hash what it returned, not just how it was asked.

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

Found 2026-10-12 on a sample auto insurance policy PDF; fixed the same day.

**The problem.** Search returned the right passage at rank 1, but the evaluation counted the question as a miss, and the miss trace said "Lost at Parse". Two of ten questions on the policy scored this way.

**Why it was broken.** Docling changed the text in two ways. It rewrote a numbered list ("1. $2,000; or 2. the Coverage CC limit") as bullets ("- $2,000; or"). It also mixed letters from a vertical "SAMPLE DOCUMENT" watermark into the sentences ("D If an insured person dies", "O 2. the Coverage"). The evaluation looked for the expected answer inside each piece: first exactly, then after a narrow clean-up that collapses spaces and line breaks, rejoins a word split by a hyphen at a line end, ignores capital letters, treats straight and curly quotes alike and expands ligatures such as "fi". A list marker that changed or a stray letter in the middle made the passage "different text". The miss trace used the same rule, so it blamed the parser.

**What fixed it.** A third, last matching tier called `reworded` (`loosen` in `packages/pandion/src/pandion/textmatch.py`). It takes the normalised text and sets aside list markers ("1.", "b)", "(3)", "iv.", bullets) and letters standing alone, on both the expected answer and the piece, then compares again. The eval step (version 4, so scores made under the old rule are not reused), the miss trace and the "How it is scored" panel all use it, and a question found this way says so in its row.

**Why the fix worked.** List markers and watermark letters are layout, not words of the answer. Setting them aside on both sides lets the policy's passage match, while every other word and number must still be there, in order: a passage with "$3,000" instead of "$2,000" is still a miss. Reporting `reworded` as its own kind keeps the score honest about how loose the match was.

**What we learned.** A text-match evaluation measures the parser as well as the search. When search looks right but the score says miss, read the piece itself. Parsers reword more than spacing: list markers and watermarks change the text too. Loosen a match only by things you can name, apply it to both sides, and say when it was used.

### A citation named the wrong document

Found 2026-10-21 in review of the several-documents Ask (PR #185); fixed the same day.

**The problem.** With two documents in one index, a Chat answer that cited a piece from the second document said the citation came from the first. The new "Sources" line under the answer would have named only the first file.

**Why it was broken.** The chat step reads one parsed document, the first by name, to place and check its citations. Each citation took its `source_sha` from that document, not from the piece it cited. The offsets and page of a piece from the other document were also looked up in the first document's text, where they mean nothing.

**What fixed it.** A citation now takes `source_sha` from its own piece's `doc_id` (`_citation` in `packages/pandion/src/pandion/plugins/answer/chat.py`). When that document is not the one the step reads, the quote is checked against the piece's own text, the offsets stay in its own document, and the page is the piece's first page, so a correct citation is verified and opens its own file.

**Why the fix worked.** Every piece already records which document it was cut from, so the citation can name it without reading that document. The piece carries its own text, offsets and pages, so a citation can be checked and placed without reading its document; looking it up in another document's text would open the wrong place.

**What we learned.** With several documents, any field that says "where" must come from the piece itself, not from whichever document a step happened to read. Test with pieces from two documents, not one.
