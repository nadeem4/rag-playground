# Evaluate, compare and measure

Evaluate a pipeline on a question set, compare settings, and see speed and cost.

[Manual index](index.md) | Previous: [index-and-search](index-and-search.md) | Next: [use-from-an-app](use-from-an-app.md)

## Evaluate a pipeline

`pandion.evaluate` asks every question in a question set and says whether the sentence
that answers it came back in the top pieces, at which rank, and, for a miss, where the
answer was lost.

```python
import pandion
from pandion import Pipeline

p = Pipeline.from_yaml("pipeline.yaml")
report = pandion.evaluate(p, "questions.json", top_k=5, documents="docs/")
report.found, report.total            # 10, 12
for q in report.questions:
    q.id, q.found, q.rank, q.lost_at  # "heading-sections", True, 2, None
    q.trace                           # for a miss: why, step by step
report.totals()                       # hit_rate, mrr, recall, mean_rank, median_rank
report.by_tag()                       # the same numbers per tag
report.by_document()                  # the same numbers per document a question names
report.to_dict()                      # all of it as plain JSON
print(report)                         # one line per question, then the totals
```

The pipeline needs a retrieve section. With `documents`, each question searches exactly
those documents (indexed first through the cache when needed), and `p.index` is left as
it was. Without it, the search covers what `p.index.run` or `p.index.sync` indexed last.

`on_event` and `cancel` work as for `p.retrieve`: each event carries the question's id
under `question`, a `question_finished` event follows each question, and a cancel stops
before the next one (`report.cancelled`).

`print(report)` gives one plain line per question and the totals:

```text
heading-sections found at rank 2
table-caption missed. Lost at Chunk. No piece holds the whole answer.
Found 10 of 12 (83%). Mean reciprocal rank 0.71.
```

A question whose retrieval failed prints `error:` and its message, and is not counted.

**The question set.** A JSON file in the format the bundled samples use
(`samples/*/questions.json`), a CSV file with the same columns, or the same list in code:

```json
[
  {
    "id": "two-steps",
    "question": "What are the two steps a retrieval-augmented system takes?",
    "gold_answer": "First it finds passages that look relevant, then it asks a language model to answer from those passages alone.",
    "tags": ["basics"]
  }
]
```

Each question needs `question` and at least one gold passage: `gold_answer`, or a list
in `gold_answers`, copied from the document word for word. `id`, `answer`, `tags` and
`document` (the document the evidence is in) are optional. A question without an `id` is
named by its place in the set, such as `question 3`. The file may also be an object with
a `questions` list, a `version` and a `document`, which every question that names no
document takes. One set can cover several documents: give each question the `document`
its evidence is in, and pass them all in `documents=`. A question that names its
document, by its id, its filename or its content hash, counts as found only when a piece
from that document holds a gold passage in the top `top_k`, and its miss is traced in
that document. A question that names none counts as found when a piece from any document
does. A question naming a document that is not searched is refused before anything
runs: "Question 3 names the document annex.pdf, which is not one of the documents
searched: handbook.pdf, report.pdf." (With a source other than upload, a question names a
document by its location or the location's last part, such as `report.pdf` for
`s3://bucket/report.pdf`; the content is not known before it is read, so there a named
question counts in any document too.) `report.by_document()` gives the totals for the questions naming each document, in
the order the set first names them, as `{"document": its content hash, ...the totals}`,
then one entry with `"document": None` for the questions naming none; each
`q.document` (also in `q.to_dict()`) says which, and `report.to_dict()` carries
`by_document`. The overall totals count every question as before. With one document,
naming it or not gives the same result. In a CSV file, several gold
passages share one cell, separated by `||`. A set with a problem is refused before
anything runs, with a `QuestionSetError` naming the question:
"The question set at questions.json cannot be used: question 3: no question text."
`pandion.evaluation.load_questions` reads a set on its own.
`pandion.evaluation.document_text(pandion.parse("report.pdf", use="pdfium"))` gives the
text gold passages are looked for in, and
`pandion.evaluation.check_questions(questions, text)` says, per gold passage, whether it
is really in that text. `pandion.evaluation.check_questions_across(questions, texts)`
does the same over several documents (`texts` is `{document key: its text}`): a question
whose `document` is a key is checked in that document only, one naming none in every
one, and each gold passage says the document it was found in (`document`, None when it
was not). `pandion.evaluation.documents_named(questions, documents)` says which of
`documents` (as `p.index.indexed()` returns them) each question names, and refuses a name
that is none of them. `pandion.evaluation.paragraph_spans(doc)` says where each
paragraph starts and ends in that text, as (start, end) pairs in order.
`pandion.evaluation.find_gold(golds, texts)` says which of `texts` (pieces in the order
a reader meets them) first holds any gold passage, by the same rule the `eval` step
scores with: a `GoldFound(index, gold, match)`, or None.

**How a question is scored.** By the `eval` step, the same one the playground's
Evaluate page runs. A piece holds the answer when it contains a gold passage exactly,
or after spacing, line-end hyphens, capital letters, curly quotes and ligatures such as
fi are evened out, or with list markers and stray single letters set aside on both
sides. `q.score["match"]` says which (`exact`, `normalized`, `reworded`). `top_k`
(default 5) is how many of the top pieces are checked: an answer below it is a miss.
It cannot check more pieces than the retrieve section returns, so set the search step's
`top_k` (or the last reranker's) at least as high.
With several gold passages, any one counts as found, and `golds_found` out of
`golds_total` feeds recall.

**Where a miss was lost.** `q.lost_at` is the first step that no longer holds the
answer: `parse`, `clean`, `chunk`, or one of the three ways an answer is lost at rank:
`search` (it never came back), `rerank` (the reranker dropped it) and `top_k` (it came
back below the pieces checked). `q.trace` has a one-sentence `finding`, a suggested
`fix`, every step's sentence and evidence, and the `document` it was traced in: the one
the question names, else the first whose pieces hold the answer whole, else the first
whose parsed text holds it. With several rerankers, the trace checks the last one,
whose result was scored.

A retrieval step that fails is reported, not raised: `q.error` names it, and the
question is left out of the rates.

`q.result_id`, also in `q.to_dict()` as `"result_id"`, is the artifact id of the final
retrieval result (the last reranker's, or the search's), so the hits can be read back
by id later. It is None when the retrieval failed.

### Compare with a baseline

`report.against(baseline)` says which questions this run missed that an earlier run
found, and the other way round. The baseline is an earlier report, its `to_dict()`, or
the path of a file that `pandion eval --json` wrote.

```python
before = pandion.evaluate(p, "questions.json", documents="docs/")
# ... change a setting, then run again
now = pandion.evaluate(p2, "questions.json", documents="docs/")
r = now.against(before)          # or now.against("base.json")
r.found_before, r.found_now      # 9, 8
r.newly_missed, r.newly_found    # ["q4", "q7"], []
r.ok()                           # False: a question was newly missed
r.ok(allow=2)                    # True: up to 2 newly missed questions are allowed
print(r)                         # Found 8 of 12; the baseline found 9 of 12. Newly missed: q4, q7.
```

`pandion.evaluation.regression(now, baseline)` does the same when both runs are plain
dicts, such as reports kept as JSON: each needs only `top_k`, and each question's `id`,
`question`, `found` and `error`, with the set's `questions_fingerprint` or every
question's `golds`. `pandion.evaluation.best(reports)` takes reports or their dicts and
gives the places of the best ones.

The `Regression` it returns has these fields:

- `compared` is how many questions both runs asked. `found_before` and `found_now`
  count the found ones among them.
- `newly_missed` and `newly_found` are the ids of the questions whose verdict changed.
- `unmatched` names the questions only one run asked: this run's first, then the
  baseline's.
- `partial` is True when the two runs did not ask the same set, or did not check the
  same number of pieces. `notes` then says so in a plain sentence.
- `notes` holds every plain sentence about the comparison, and `print(r)` prints them
  under the counts.
- `by_category` holds, for each category, `compared`, `found_before`, `found_now`,
  `newly_missed` and `newly_found`. A question's category is the name in its
  `category:<name>` tag (`pandion.evaluation.category_of(question_dict)`), else
  `uncategorized`. `r.gate_ok(allow=0)` is True when every category has at most `allow`
  newly missed questions, and `r.failed_categories(allow=0)` names the ones that do not.
  So a category that lost a question fails the gate even when the total went up.
  `ok()` still counts the whole set. A named category with fewer than 10 questions adds
  the note `The "billing" category has 4 questions, so its gate is weak.` Baselines saved
  before categories existed still compare: categories are read from each question's `tags`.
  `to_dict()` carries `by_category` and `gate_ok` beside its old keys.

**Follow-up questions.** A question may carry a `history`: the earlier turns it comes
after, as `{"question", "answer"}` pairs (JSON files only; the key is left out when there
is none, so older sets and their fingerprints do not change).

```json
{
  "id": "notice",
  "question": "And the notice?",
  "gold_answer": "Notice is 30 days.",
  "history": [{"question": "Tell me about the lease.", "answer": "It runs for two years."}]
}
```

`evaluate` makes such a question standalone first, the way a chat turn does
(`standalone_question`), and searches with that. The rewrite uses the chat settings'
rewrite model: pass `chat=ChatSettings(rewrite_model=...)` to choose one, else the chat
default (`claude-haiku-4-5`) runs, so the key for it goes in `credentials`. A question
without a history makes no model call. If the rewrite fails or comes back too long, the
question is searched as written and counted in `report.rewrites_failed`. Each follow-up
result records `history`, `rewrite` and `rewrite_reason` (`rewritten`, `failed` or
`too long`) in `to_dict()`, and a follow-up with no `category:` tag counts as its own
category, `follow-up`, in `by_category`. `reask_missed` takes the same `chat=`;
`stale_check` searches nothing, so it needs no rewrite.
`pandion eval` uses the default rewrite model, `claude-haiku-4-5`, and needs `ANTHROPIC_API_KEY` for it; without a key the follow-ups are searched as written and counted in `rewrites_failed` (on stderr too with `--json`). The rewrite model is listed in a recorded baseline's models when the set has follow-ups, so changing it gets a note, and the rewrite is listed as `chat rewrite` in `nondeterministic`, so a newly missed follow-up is asked once more. `follow-up` is its own category, so it is gated on its own. The rewrite's tokens and cost are not in `report.cost()`.

**Tag your questions by category.** Put `category:<name>` in a question's `tags`, and keep
one file per category as a habit, such as `evals/billing.json` and `evals/returns.json`
(then run `pandion eval` on a merged set, or one file at a time). About 10 questions per
category or more makes a gate that one flipped question cannot decide.

**Where a baseline was made.** `pandion.evaluation.environment(p)` gives
`{"platform": "linux-x86_64", "models": [...], "pandion": "0.7.0"}`: the lower-case
system and machine, every model id the pipeline uses (the embedder and each chat model;
a custom or OpenRouter endpoint records the model name typed there), and the Pandion
version. `pandion eval --record-baseline` stores it under `"environment"`.
`check_environment(baseline, environment(p))` raises a `ValueError` when the platform or
the models differ ("This baseline was recorded on linux-x86_64 with models X; this run is
on windows-amd64 with models Y, so the comparison would not be fair. Re-record it here
with --record-baseline, or run on the machine that recorded it."), returns a note when
the baseline has no `environment` (an older file), and returns `[]` when they match. The
Pandion version is recorded but never compared.
- `ok(allow=0)` is True when at most `allow` questions were newly missed.

Questions are paired by their `id`. A question the set gave no id (named by its place,
such as `question 3`) is paired by its text, so a reordered set still pairs up. Ids are
paired first, over the whole set; a named question whose id has no partner then falls
back to its text, among the questions still unpaired. A question that could not be
scored in either run is left out, and a note says how many. When
the question sets differ, only the questions both runs asked are compared, and the
note says so. When `top_k` differs, a note says the counts are not like for like.

To tell a changed set from the same one, `report.to_dict()` carries
`questions_fingerprint`, a hash of the questions and their gold passages that does not
depend on their order. It also carries `document_shas`, the searched documents' content
hashes, and `top_k`. When the documents differ, a note says so.

**The noise warning.** Some steps can give a different result each time they run, for
example `llm_rewrite` and `llm_rerank`, which ask a model. When either run used such a
step, `report.nondeterministic` names it, and a note says that a newly missed question
may be noise: the model may simply have answered differently this time. Run it again
before you trust the change. A pipeline without a model step gives the same result
every run. `pandion eval --baseline` does that for you: see
[Ask again before failing](#ask-again-before-failing).

### Check the question set first

A passage that is gone from the documents fails its question however good the retrieval
is, so check the set before you score it. `pandion.evaluation.stale_check(p, questions,
documents)` parses and chunks the documents (it embeds and searches nothing) and looks
for every expected passage in the parse, by the rule the `eval` step matches by. It
returns a `StaleCheck`: `stale` (the ids of the questions with a passage missing, or
`question N` for a question with no id), `warnings`, `ok`, `str()` and `to_dict()`. A
passage longer than the biggest piece of its document adds a warning, because no piece
can ever hold it whole. A document that does not parse is a `ValueError` naming it. A
library caller runs `stale_check` before `evaluate`; `pandion eval` does it for you.

### Ask again before failing

`pandion.evaluation.reask_missed(p, report, baseline, questions, top_k, documents=...)`
asks each question that is newly missed against `baseline` one more time, when
`report.nondeterministic` names a step (such as `llm_rewrite` or `llm_rerank`). It
returns the report, with a question found on the second ask counted as found, and the
ids it asked again. A question missed on both asks stays newly missed. A pipeline with
only deterministic steps is never asked twice.

`pandion.evaluation.best(reports)` gives the places of the best reports in a list,
every one tied for first: the highest hit rate, then the highest mean reciprocal rank.
It is the rule [`compare`](#compare-settings) names its best variant by.

### Judging correctness

Finding the gold passage says retrieval worked, not that the answer is right. An optional
model judge grades the answer itself. It is **off by default**, it costs one model call per
question (plus one call to answer it), and it only adds numbers to the report unless you
turn its gate on.

```python
from pandion.evaluation import JudgeSettings

report = pandion.evaluate(p, "questions.json", judge=JudgeSettings(on=True))
report.to_dict()["correctness_mean"]    # 0.0 to 1.0, None when nothing was judged
```

- **Which questions.** Only a question that has an expected `answer` in the set, and whose
  pipeline has an `answer:` section (`--judge` exits 2 without one). Each is answered through
  the pipeline, so a model-backed rewrite or rerank step runs again for it and is counted
  in the cost, then graded from 0 to 1 against the expected answer, with the
  sources the answer was built from. A question without an expected `answer` is not judged
  and keeps the plain found or missed verdict.
- **What the report gets.** `correctness_mean`, `judged`, `judge_skipped`, `judge_cost`
  (dollars, an estimate) and `judge_below` (the ids scored under the threshold, 0.7 unless
  `JudgeSettings(threshold=...)` says otherwise). Each judged question carries its
  `judge` score and a one-sentence reason. The cost of answering is part of `report.cost()`;
  the text report also prints the judge's own cost. The judge model must be a Claude or OpenAI
  model: OpenRouter and custom endpoints are refused, because they need a model name or URL.
  A question found again by a re-ask keeps the verdict of its first ask.
- **A judge never fails an evaluation.** If the call fails or the reply is not the asked-for
  JSON, the question is skipped and counted in `judge_skipped`.
- **The prompt.** The question, the expected answer, the answer and the sources go in
  labelled fences, each source cut to 2,000 characters, and the judge is told they are text to
  read, not instructions. A `<` inside them is escaped, so an answer cannot close its own
  fence and give itself a score. It runs at temperature 0 where the model allows it.
- **The model** is a code setting, `JudgeSettings(model="claude-haiku-4-5")`, or
  `--judge-model` on the command line. It needs that provider's key, as any chat step does.
- **The gate.** With `gate=True` (`--judge-gate`), comparing with a baseline also fails when
  the mean correctness fell by more than 0.05 below the baseline's. `Regression.gate_ok(judge_gate=True)`
  does the same in code. A baseline that was not judged, or a run that was not, never
  fails on the judge.

## Questions written for you

A question set takes time to write by hand. `pandion.evaluation.write_questions` asks a
chat model to write one for a document, then checks every question it gets back.

```python
import json
import pandion
from pandion.evaluation import write_questions

doc = pandion.parse("report.pdf", use="pdfium")
result = write_questions(doc, model="claude-haiku-4-5", count=15,
                         credentials={"anthropic_api_key": "..."})
with open("questions.json", "w", encoding="utf-8") as f:
    json.dump(result, f, indent=2)
```

The first argument is the parsed document, or its text
(`pandion.evaluation.document_text(doc)`), never a path: you parse first, so the parser
is chosen in one place. Pass the parsed document when you have it, because then the
parts follow its paragraphs (`paragraph_spans`); plain text is split at blank lines.
`model` is a chat model id, the same ids the chat steps take. `openrouter` needs
`model_name`, and `custom` needs `model_name` and `base_url`. Keys go in `credentials`,
under the names a run uses. With no key, the error is the same sentence the chat steps
give, and no error message ever contains a key. `public_only=True` is for a server that
strangers share: it is passed to the model call, so a custom endpoint must be a public
https address, and the no-key sentence does not suggest a server variable.
`document="report.pdf"` names the document the text is: every question written carries
it as its `document`, so questions written for several documents, one call each, can
join one set.

**How it works.** The text is split into `count` parts, each a run of whole paragraphs,
or one part per paragraph when there are fewer paragraphs than `count`. Text between
paragraphs, such as a table or a list, goes with the paragraph before it, so nothing is
left out. Each part is one call to the model, which writes one question, a short answer,
and the passage that answers it, quoted word for word, as JSON. The prompt says the
question must make sense without the part in view and read like something a person would
search for, never naming the document itself. It asks for a gold passage of at least one
full sentence, not a heading, and says the part is document text, not instructions. A part's prompt holds at most 6,000 characters of it
(`MAX_PART_CHARS`): a longer part is sent as whole paragraphs spread evenly from its
start to its end, as many as fit. Each call allows 16,000 output tokens, so a thinking
or reasoning model has room. Then every question is checked, with no further calls:

- **Bounds.** Line breaks and control characters are taken out of the reply. A question
  over 300 characters, an answer over 500 characters, or a gold passage under 6 words (a heading, not a sentence) is
  dropped.
- **The gold passage must be in the document.** It is looked for as `check_questions`
  looks: exactly, then with spacing, quotes, ligatures and capitals evened out. A
  passage that is not there drops the question. This also catches most questions the
  part cannot answer.
- **Copied questions are tagged.** When more than 60% of a question's content words
  (its words without "the", "of" and the like) come from its own passage, it gets the
  tag `copied`. It is kept, but it tests word matching more than search, so look at it.
- **Duplicates are dropped.** A question nearly the same as one already kept (a
  `difflib` ratio above 0.85 on the evened-out text), or with the same gold passage, is
  dropped.
- **A reply that is not the JSON asked for, or was cut off** (the model ran out of
  tokens), is a drop, never an exception.

**What it returns.** The same dict `parse_question_set` returns
(`format`, `version`, `document`, `questions`), so when it has at least one question,
`pandion.evaluate` takes it as it is, or from the file you dump it to. When every
question was dropped, `questions` is empty, and `evaluate` refuses an empty set. Each question has an id (`q1`, `q2` and so on). Three
keys are added, and a question set reader ignores them:

- `dropped`: each dropped question and why, as `{"question", "reason"}`. A reply that
  could not be read has an empty question.
- `usage`: `{"input_tokens", "output_tokens", "model"}`, summed over every call that
  returned. A count
  is None when a server did not report it, never 0. `model` is the one the server says
  it used.
- `parts`: how many parts the text was split into.

It never returns more than `count` questions, and returns fewer when drops leave fewer.
When the first call fails, such as for a rejected key, a wrong model id or an endpoint
that cannot be reached, the error is raised. A call after that which fails is a drop,
with its reason, and the questions already written are still returned.

**Following its progress.** Pass `on_part`, a function that takes two numbers, and it is
called after each part with how many parts are done and how many there are in all, for
example `on_part=lambda done, total: print(f"{done} of {total}")`. It is called for a part
whose call failed too. An exception it raises stops the calls and is raised again from
`write_questions`, so raising one is how a caller stops it early; pandion-api does this
when a run is cancelled.

From the command line, `pandion questions` does the same; see
[The pandion command](cli.md#the-pandion-command).

## Compare settings

`pandion.compare` runs a pipeline once per variant of one stage, with everything else
the same, and evaluates each.

```python
import pandion

results = pandion.compare(
    p, "chunk",
    [{"use": "recursive_character", "chunk_size": 400, "chunk_overlap": 80},
     {"use": "recursive_character", "chunk_size": 800, "chunk_overlap": 80},
     {"use": "sentence_window"}],
    documents="docs/", questions="questions.json",
)
for r in results:
    r.variant, r.report.found, r.report.total   # each variant's evaluation
```

The stage is one of `parse`, `clean`, `chunk`, `enrich`, `embed`, `store`, `rewrite`,
`search` and `rerank`. A variant is what the pipeline file takes for that stage: a block,
`"none"` for `enrich` or `rewrite`, a name such as `"bm25"`, a step class such as `RecursiveCharacter(chunk_size=800)`, or for `clean` and
`rerank` a list. Every variant is checked before any runs, and a problem names the
variant: "variant 2: index.chunk (recursive_character) has no setting 'chunk_sise'."

Every variant indexes `documents` into the same store, so the steps above the changed
one run once: comparing three chunkers parses each document once and chunks it three
times. Comparing a retrieval stage builds the index once.

Without `questions`, each result holds the changed step's output, in `r.outputs`: per
document for parse, clean and chunk (`r.outputs["report.pdf"].output.chunks`), or under
`"index"` for embed and store. A retrieval stage needs questions, because without them
nothing is searched. Without questions, `through` stops each variant's index run after
that step, as `index.run(through=...)` does, so comparing ten chunkers with
`through="chunk"` embeds nothing. It must not stop before the varied step (comparing
`chunk` with `through="parse"` is a `ValueError`), and with questions it is a
`ValueError`, because answering needs the whole index. `r.index` is the variant's index run, `r.pipeline` the pipeline
with that stage changed (`r.pipeline.to_yaml()` writes it as a file), and `r.to_dict()`
is all of it as plain JSON. A variant whose index run fails is reported, with
`r.index.ok` false and no `report`.

Categories chosen by hand with `p.index.assign` carry over to every variant.

In a pipeline with categories, comparing `parse`, `clean` or `chunk` sets each variant in every
category. `pandion.evaluation.with_stage(data, stage, block)` does this to a pipeline file's
dict, and `p.index.step_names()` lists the steps `through` can name: `parse`, `clean`,
`clean.N` for as many cleaners as the category with the most has, `chunk` and `index`.

`print(results)` gives one plain line per variant and names the best one: the variant
with the highest hit rate (answers found out of the questions scored), then the one with
the higher mean reciprocal rank. The results are a list, `pandion.Comparisons`; a slice
of it is a plain list.

```text
chunk recursive_character chunk_size=400 chunk_overlap=80: found 9 of 12
chunk recursive_character chunk_size=800 chunk_overlap=80: found 10 of 12
chunk sentence_window: found 8 of 12
Best: recursive_character chunk_size=800 chunk_overlap=80, found 10 of 12.
```

A variant without questions prints `indexed, no questions asked`, and one whose index
run failed prints `the index run failed`. When several variants tie for best, the line
names the others after `tied with`. When no variant found an answer, the last line
says `No variant found an answer.` instead.

`results.best` is the list of best comparisons, every one tied for first, in order. It
is empty when no variant was scored or none found an answer. `results.to_dict()` is
plain JSON with `comparisons`, each comparison's `to_dict()`, and `best`, the places of
the best ones in the list, such as `[1]`.

`on_event` gets every event with the variant's number under `variant` and the number of
variants under `variants`. An evaluation's own fields, such as `total` (the number of
questions) on `question_finished`, are left as they are. `cancel` starts no further
variant. A variant whose index run a cancel stopped prints `stopped`, and one whose
evaluation was stopped partway prints its count followed by `(stopped early)`. Neither
can be the best: when no variant finished, there is no `Best:` line. The last line is
then `Stopped before every variant had finished.` `results.cancelled`, also in
`results.to_dict()`, is one flag for the whole comparison: a cancel stopped it. Each
comparison has its own `r.cancelled`, also in `r.to_dict()`, which says whether a cancel
stopped that variant.

## Speed and cost

Every report has `cost()`: `Retrieval`, `Answer`, `IndexReport` (and so `SyncReport`),
`EvaluationReport`, one `Comparison`, and the `Comparisons` that `pandion.compare`
returns. It says how long the steps took, how many tokens the model steps used, and
about what that cost.

```python
answer = p.ask("How big should a chunk be?", credentials=keys)
answer.cost()
# {"seconds": 1.84, "input_tokens": 2310, "output_tokens": 412, "dollars": 0.0041,
#  "unpriced_models": [], "uncounted_models": [], "steps_run": 5, "steps_cached": 2, "prices_as_of": "2026-10-15"}
```

- `seconds` is the time of the steps that ran in this run, including a step that failed.
- `input_tokens` and `output_tokens` add up what the model steps reported. They are None
  when no step reported any. A local step, such as an embedder or a cross-encoder, gives
  time only. Pandion never guesses a count with a tokenizer.
- `dollars` is an estimate for the steps whose model has a price. It is None when no step
  could be priced.
- `unpriced_models` lists the model ids that used tokens but have no price, such as an
  OpenRouter model or a custom endpoint. Their cost is unknown, so it is never counted
  as 0. A model is found in the table by the id the server reported, then by that id
  without a date at the end (`claude-haiku-4-5-20251001` is priced as
  `claude-haiku-4-5`), then by the id that was sent.
- `uncounted_models` lists priced models whose server did not report both token counts,
  so their calls could not be priced either.
- `steps_run` counts the steps that ran in this run, and `steps_cached` the steps that
  came from the cache. Each cached step is counted once per report, even when every
  question of an evaluation read the same stored index. A step the same report also ran,
  such as a chunk step that a later question reads back, counts only as run.
  A cached step takes almost no time and uses no tokens, so a run
  that reused the cache looks fast and cheap. The two counts show how much of it did.
- `prices_as_of` is the date of the price table, or `"custom"` when you passed your own.

Only steps that ran in this run count. A step that failed after its model call still
counts, with the tokens it recorded, so a failed run never looks free. A search or an
answer also counts the document steps (parse, clean, chunk) it ran or read from the cache
on the way to the index. They are kept in `Retrieval.upstream`, without their outputs,
and only `cost()` reads them.

The prices are in `pandion.llm.PRICES`: US dollars per million input tokens and per
million output tokens, for each Anthropic and OpenAI model Pandion offers, taken from
each provider's published list price on the date in `pandion.llm.AS_OF`. They are the
standard rates. Cached prompts, batch requests and long prompts are billed differently,
so the dollars are an estimate, not a bill. Prices never go in the pipeline file. To use
your own, pass them in the same shape:

```python
answer.cost(prices={"claude-sonnet-5": (2.0, 10.0), "openai/gpt-4o-mini": (0.15, 0.6)})
```

### Part of a run, and several runs together

`cost()` takes `since` and `before`, each a stage name. `since="rerank"` counts only the
steps at that stage or after it, and `before="rerank"` only the steps before it, so the
two split a run in two. The order is the pipeline's: source, parse, clean, chunk, enrich, the index
(`embed`, `store` and `index` all name it), rewrite, search, rerank, answer. A name that
is not a stage raises `ValueError`.

`pandion.total_cost(reports)` is the cost of several reports together, with each step
counted once across all of them. A cached read of a result that another of the reports
ran is not counted, and a cached step that several reports read counts once. It takes
`prices`, `since` and `before` too. `Comparisons.cost()` is `total_cost` of its variants.

This is how to compare variants fairly. `compare` runs the shared steps for the first
variant only, and the later variants read them from the cache, so each variant's whole
`cost()` depends on its place in the list. `Comparisons.varied_from` is the stage that
`compare` was told to vary. `pandion.varied_costs(reports, since=...)` gives each
variant's cost from that stage on, as if the variant had run on its own:

```python
results = pandion.compare(p, "rerank", ["mmr", "cross_encoder"], docs, questions)
for c, own in zip(results, pandion.varied_costs(results, since=results.varied_from)):
    print(c.settings, own)
print("shared", pandion.total_cost(results, before=results.varied_from))
```

Some steps from the varied stage on are the same in several variants. Two lists of
rerankers or cleaners that start the same way make the same first results, and a step
that does not read the varied one, such as the question's rewrite, is the same in every
variant. One variant runs such a step and the others read it from the cache.
`varied_costs` charges it to every variant that uses it, with the time and tokens of the
run that made it, so a variant's cost does not depend on the order. `total_cost` still
counts what was really spent, each step once.

Two more rules. A step that no variant ran this time, because an earlier run had already
stored it, is counted only as cached. When every shared step came from the cache, the
shared cost has `steps_run` 0 and `seconds` 0: say that the shared steps came from the
cache rather than that they were free. Loading a model the first time it is used is timed
in the step that loads it, so the first variant to use a reranker or an embedder can look
slower. `pandion.preload_reranker` and `pandion.preload_embedder` load them before the run.

`pandion eval` and `pandion compare` print the cost as one line (see
[The pandion command](cli.md#the-pandion-command)).
pandion-api returns each step's `usage` and each report's `cost` in its JSON (see
[pandion-api.md](../pandion-api/index.md#speed-and-cost)).
