# Experiments

Measurements of what each stage of a RAG pipeline actually buys you, run with this
repository's own engine on public datasets.

The playground answers "what does this setting do to my document". These experiments answer
"which settings matter, on real data, and by how much". The sample document that ships with
the playground is three pages, and every strategy scores full marks on it, which is why
these runs use public corpora instead.

## The index

| Experiment | Stage | Status | Finding |
|---|---|---|---|
| `chunking-qasper` | chunk | designed | |
| `retrieval-beir` | index, retrieve, rerank | planned | |
| `parsing-financebench` | parse, clean | planned | |
| `answers-qasper` | answer | planned | |

Status is `designed`, `piloted` or `complete`. The finding is one sentence, filled in from
the experiment's own `RESULTS.md`, never written here first.

## How an experiment is laid out

```
experiments/<name>/
  README.md      the protocol, written BEFORE the run
  RESULTS.md     what happened, written AFTER the run
  harness/       the code, using this repo's plugins
  tests/         its own tests
  results/       committed metrics, summaries and figures
  runs/          raw per-call records, gitignored (the repo already ignores runs/)
```

The protocol and the results are separate files so the commit history proves the prediction
came before the answer. A protocol is never edited in place once a run has started:
corrections are appended as dated amendments, because changing the method mid-run is itself
a fact about the experiment.

## Rules that every experiment follows

These are not style preferences. Each one exists because ignoring it produces a number that
looks fine and is wrong.

1. **Pilot first.** Run a small slice, stop, and check that the baseline reproduces a
   published figure. If our keyword search does not land near the published BM25 score on
   the same dataset, the instrument is broken and every later comparison measures something
   else. The pilot also gives the timing estimate for the full run.
2. **Resumable.** One record per unit of work, appended to a JSONL file, keyed so finished
   work is skipped. A run that dies resumes.
3. **Paired comparisons.** The same questions, the same seed, the same order in every arm.
   Report per-question differences, not two averages that happen to overlap.
4. **Shuffle before limiting.** A dataset sorted by label, cut to the first N, measures N of
   one kind.
5. **Latency excludes retries.** Time the successful attempt. Report wall clock separately.
6. **Record versions.** Model ids and revisions, library versions, GPU or CPU, date, commit.
7. **Count what cannot move.** Questions whose answer is not in the corpus dilute every
   average. Report them separately.
8. **A negative result is a result.** If the expensive option loses, that goes in the
   finding, including in the title.

## Running on Colab

The runs happen on Colab, where a GPU is available. The repository is installed from GitHub
and the results come back as files.

```python
!git clone https://github.com/nadeem4/rag-playground.git
%cd rag-playground
!pip install -e . -r experiments/requirements.txt
```

**Install with pip, not uv.** This repository pins CPU-only torch on Linux, so the Docker
image stays small. That pin is right for the image and wrong for a GPU notebook: `uv sync`
on Colab would give you a CPU build and a very slow run. `pip install -e .` takes the
default index and the CUDA build that Colab already has.

Then, for a given experiment:

```python
!python -m experiments.chunking_qasper.harness.run --limit 50 --out runs/pilot.jsonl
!python -m experiments.chunking_qasper.harness.report --runs runs/pilot.jsonl
```

**Getting results back into the repository.** The run writes raw records to `runs/`, which
git ignores, and a summary plus figures to `results/`, which is committed. Download the
`results/` directory from Colab and commit it here. Do not put a GitHub token in a
notebook.

**Record the machine.** The harness writes the GPU name, the library versions and the commit
into the summary, so a result measured on a T4 is never quietly compared with one measured
on a laptop CPU.

## Datasets

Chosen so each stage has ground truth that actually exists, rather than a number we invent.

| Dataset | What it gives | Which stages |
|---|---|---|
| **QASPER** | Full scientific papers with questions and the paragraphs that answer them | chunk, answer |
| **BEIR SciFact** | 5k abstracts, 300 queries, published baselines | index, retrieve, rerank |
| **BEIR NFCorpus** | A harder, noisier corpus of the same shape | retrieve, rerank |
| **FinanceBench** | Real annual-report PDFs with questions and the evidence text | parse, clean, answer |

Availability and licences are checked during each pilot, not assumed here.

**One honest gap:** parsing metrics such as reading order and structure recall need
page-level layout labels, which the datasets above do not carry. Where we lack labels we
report parser disagreement and the share of evidence that survives parsing, and we do not
invent an accuracy.

## Publishing

When an experiment is complete, its summary feeds a page in the playground itself, so the
lessons can point at measured numbers instead of advice. Figures are generated by the
experiment's own report script from its results file, never drawn by hand, so a chart and
the table beside it cannot drift apart.
