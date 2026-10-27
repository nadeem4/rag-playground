# Guide

This page walks through each page of RAG Playground: Home, Build with its Ask panel,
Compare, Evaluate, Library, Read and the privacy page. For what each strategy does, see
[strategies.md](strategies.md).

## Contents

- [Pipelines and their documents](#pipelines-and-their-documents)
- [Home](#home)
- [Build](#build)
- [The Ask panel](#the-ask-panel)
- [Compare](#compare)
- [Evaluate](#evaluate)
- [Library](#library)
- [Take your pipeline with you](#take-your-pipeline-with-you)
- [Read](#read)
- [Your data and privacy](#your-data-and-privacy)

## Pipelines and their documents

You choose a pipeline first, and its documents come with it. A pipeline holds a list of
documents. Today the list has one document; a later version will let a pipeline run on
several, and nothing about saved pipelines, links or exported files will need to change.

- The **Starter pipeline** is always there, ready to run, and read-only: Docling for Parse
  (the page's body only), Remove duplicate blocks for Clean, Recursive at 400 characters
  with 80 of overlap for Chunk, LanceDB with Qwen3 for Index, Hybrid (RRF) returning 20 for
  Retrieve, no rerank and no rewrite, on the sample A primer on chunking.
- **Your pipelines** are the ones you saved. Each keeps its own documents.

On Build and Evaluate the **Pipeline** picker comes first. Wherever the app names a
document, it shows it the same way: a small picture of page 1, the title, then the file
name, the page count and a tag, **Sample**, **Your upload** or **From a link**, with a
**Preview** button. A document without pages shows its kind, such as DOCX, in place of the
picture, and a document from a link takes the link's host, such as en.wikipedia.org, as its
title.

- On **Build** the documents belong to the pipeline, so they are in its first step, the
  **Document** card. Its **Add a document** link opens a menu with the bundled samples, your
  uploads, **Upload a document** and **Or add a link**. What you pick joins the pipeline's
  documents. With two or more, each has a **Remove** button; a pipeline keeps at least one.
- On **Evaluate** they are listed under **Documents**, with **Change**. With two or more,
  each shows as a file tag (its colour and its name) and they change only on Build.
- **Compare** stays document first: a **Document** line above the recipes shows the
  picture and the title, with **Preview** and **Change**. It works on the pipeline on Build.
- **Library** shows every saved document the same way.

The header has no document control. Home, Read and Privacy show no document, because they
do not work on one. Home has its own **Try a sample** and **Use your own files** buttons.

**Preview** opens a side sheet with every page of the document. A row of page numbers at
the top jumps to a page, and the page in view is marked as you scroll. Each page is
captioned, such as Page 3 of 6. Escape or the close button closes it, and you are back
where you were. A document without pages says so in the sheet; its text shows on the
Parse step once the pipeline has run.

### Kinds of document, and links

**Upload a document** takes every kind of file a parser on the server reads. With the
parsers here that is PDF, Word, PowerPoint, HTML, Markdown, text, PNG and JPG. The file
picker offers only those, and the menu names them under the upload. On the demo the same
line gives the limits: a PDF up to 10 MB and 20 pages, other files up to 2 MB, and images up
to 5 MB.

**Or add a link** takes the address of a web page or a PDF. Paste it and press **Add**. The
server fetches the page once and keeps it like an upload: it counts as one of your uploads,
expires with them on the demo, and is never fetched again for a question. On the demo only
public https addresses work. When a link is refused, the menu shows the server's own
sentence, such as "That address is not on the public internet, so it was not fetched."

Not every parser reads every kind. In the Parse step's picker, a parser that cannot read
the document is greyed out with the reason, such as "pdfium reads PDF files only." If you
choose a Word file while Parse uses pdfium, the Parse card says the same thing under its
picker, and the run waits until you pick a parser that reads it, such as Docling.

Word files, web pages, Markdown and text have no pages. Images and PowerPoint slides do,
but their boxes are in pixels or slide units, not PDF points, so the app does not draw
them. For all of these, **Show in text** takes the place of **Show in PDF**: it opens the
document's text in a scrolling panel, with the cited or selected piece marked in its
chunk's colour.

The five samples were written for the playground, and each one shows a problem:

| Sample | Pages | What it shows |
|---|---|---|
| A primer on chunking | 6 | Headings, a running footer and a short glossary. It is the default. |
| Scanned notes | 4 | Pictures of text with no text layer. Without OCR the parse is empty. |
| Two-column report | 5 | Rows drawn across both columns. A plain parser joins halves of different sentences. |
| Table of figures | 6 | Two ruled tables, a bar chart with a caption, one scanned page and notes. A layout parser keeps each row together. |
| A weather station manual | 7 | Numbered headings four levels deep, a settings table, a running header and footer, and a warning on every page. Some answers only make sense with their heading path. It is the sample of the Manuals and guides template. |

Each sample has its own question set, so Evaluate scores the sample you loaded. Every
question carries an expected answer and tags, and some are **planted to miss** on the
default pipeline so that Evaluate has something to explain:

| Sample | Questions | Planted to miss, and the fix |
|---|---|---|
| A primer on chunking | 12 | One answer is a sentence longer than a piece (lost at Chunk; 800-character pieces or By sentence find it). One question uses words the document never does (ranked far below the pieces checked; a PRF rewrite finds it). |
| Two-column report | 12 | One fact is only in a page footer (lost at Parse; read headers and footers in Parse). One answer is ranked below the pieces checked (the cross-encoder reranker finds it). Six more miss if you switch Parse to Fast text. |
| Table of figures | 12 | One answer is on the scanned page (lost at Parse; turn on OCR). One question uses words the document never does (ranked far below the pieces checked; the cross-encoder reranker finds it). |
| Scanned notes | 8 | Every question misses without OCR and is found with it. |
| A weather station manual | 12 | None. Every question is found by the Manuals and guides template, which searches each piece with its heading path. |

The tags say which questions are planted ("designed to miss: ...") and which miss only after
a change ("misses if you change: ..."), so a planted miss is never mistaken for a broken
pipeline. Each sample's `sample.json` lists its plants under `teaches`, and
`tests/test_sample_plants.py` checks every one against the real pipeline.

When you choose another document, the results on the page are marked out of date, as
they are when you edit a step, and Evaluate opens a fresh evaluation for it.
A question you typed stays. A question the sample filled in is cleared, so you are not
asked about the old document; the empty box then suggests asking about the new one, and
Ask waits until there is a question.

When a saved upload has expired, or was uploaded in another browser, the document keeps its
name with the tag **Removed from the server**, and its Preview is off until you upload it
again. Build, Compare and Evaluate then say so in one
note with a **Pick a document** button, and their run buttons wait and say "Needs a
document." A sample saved with an older copy of its PDF is not missing: when its filename
is exactly a current sample's, and no upload in this browser has that filename, the page
switches to the sample's current copy and says so once. In a pipeline with several
documents, every such sample changes at once and the other documents stay. Uploads are never matched by
filename.

## Home

Home (`/`) is the first page, written for developers building search over their own
knowledge. It has:

- a hero with what you leave with (a Python project built on Pandion), and three actions:
  - **Try a sample** opens Build on the Starter pipeline with the default sample. An unsaved
    pipeline on Build is kept rather than replaced, and the Starter waits in its picker;
  - **Use your own files** opens a file picker that offers every kind of file a parser on the
    server reads, and opens Build once the upload is done. If the upload is refused, it says
    why under the buttons. One line under the buttons names each kind of file and, on the
    demo, its limit, as the Document menu does;
  - **See what you take home** jumps to the Pandion section;
- three facts: no sign in, where your files stay (private to your browser on the demo, on
  your machine when running locally), and a key only for model steps;
- a real finding from the scanned notes sample: 0 of 8 questions found with Docling's OCR
  off, 8 of 8 with it on (from [Lessons learned](lessons-learned.md));
- **From your files to a project you own**: four tabs, Build, Evaluate, Compare and Take it
  home. The first three play a short clip of the page, with a chip for each scene to jump to it; Take it home shows what the zip holds.
  The arrow keys, Home and End move between the tabs;
- **Start from what you have**: a sample, your own files, or a template. Your own files
  also takes a link: paste it and press **Add**, and Build opens on the page it fetched. A
  refused link says why under the box;
- three lessons from building it, each linking its entry in [Lessons learned](lessons-learned.md);
- Pandion: the commands and the output of a real `pandion init` project, with links to
  PyPI and GitHub.

The clips are muted and loop. Each has a Pause and Play button. With reduced motion turned
on, they hold still on their poster until you press Play. Any path the app does not know
opens Home.

## Build

Build opens on a pipeline. Arriving for the first time, it is the Starter pipeline on the
default sample, ready to build. At the top of the column, the **Pipeline** picker lists the
Starter (marked Ready-made), your pipelines and **New pipeline**, which starts an unsaved
pipeline from the Starter's settings on the documents in use.

The column on the left of Build is the index pipeline: Document, Parse, Clean, Chunk and
Index, one card each with its own settings. The Document card lists the pipeline's
documents, each with **Preview**. Its **Add a document** link adds one more: every step
runs on each document, and the index and Ask cover them all. With two or more documents,
each has **Remove**, and a **Showing the steps for** picker above the column chooses which
document's results the cards show. To replace the only document, add the new one, then
remove the old one. Two documents with the same name cannot run together, since the server
tells them apart by their names: with several documents, adding one whose name is taken is
refused, and you remove the old one first or upload the new one under another name. With
only one document, a new file of the same name, such as an edited report.pdf uploaded
again, replaces it. On a first visit with no document, the first-visit card offers the
samples, **Upload a document**, and **Pick a document** for your earlier uploads.

- **Build the index** runs the steps. Each card also has its own **Run**. Each card runs
  the pipeline only as far as itself (`through` in `POST /api/v2/runs`); what is already
  stored comes from the cache.
- **Cancel** stops a run after the step it is on, since a step cannot be stopped half way.
  Until the run ends, the line beside the step bars says "Stopping after this step." The
  steps that finished stay in the cache, so the next build reuses them.
- The **gear** on a card opens its settings. Once the index is built, the line above the
  cards invites you to change a step, such as the chunk size, and build again, and points
  to Compare for several settings side by side.
- The **output** button on a card (a panel opening to the right), or a click on its result
  line, shows the step's output: the parsed elements with their types and pages, a diff of
  what each cleaner removed, the chunk boundaries drawn over the text, or the index
  contents. On a laptop or tablet it shows in the pane beside the cards, and the button
  stays lit for the step on show; clicking a card's title shows it there too. On a phone
  it opens in a sheet over the cards, with a close button.
- Results are cached by recipe, so changing the chunker never parses the PDF again.
- Each card has an info button that says what the step is for, how the chosen strategy
  works and what it will do with your settings. Every setting has its own info button too.
- Each strategy in a card's dropdown shows its plain name, its code name and one line of
  help. A strategy that does not fit the step above it is marked before you pick it:
  "Falls back" when it would still run but do something simpler (the card says why in
  amber), "Cannot run" when it could not run at all (it is greyed out and blocks Run with
  the reason in red), and "Needs a key" when it needs an API key and none is set.
- Settings that make no sense show a warning and disable Run.
- After a run, the card says what the step did compared with the previous run.
- When Parse finds no text, the card says the PDF may be scanned. With Docling it offers
  **Turn on OCR**, which switches OCR on so you can run Parse again. OCR takes about 10
  seconds a page.
- The **Sweep** button on a card opens Compare on that step.
- Any chunk or search hit can open its PDF page with its source paragraphs outlined.

**Add enrich step**, under Chunk, adds the optional Enrich step before Index. It asks a
chat model to write one short sentence that places each chunk in its document, and puts
that sentence in front of the chunk before it is searched. The chunk that is shown and
cited does not change; its output shows each chunk's `embed_text` with the context in
front. It costs one model call per chunk and needs the key for its model, so without one
the card says which key it needs and Run waits. The hosted demo writes context for at most
200 chunks in one run. The **x** on the card removes the step, and its **Sweep** opens
Compare with the step on against off. Fixed token count and By sentence also have a free
**Heading in front** setting that puts the heading path in front of each chunk instead.

### The guided run

When nothing has run yet on Build, an invite offers a guided run. It sits in the pane beside
the cards on a laptop or tablet, and above the cards on a phone. **Start the guided run**
replaces the working pipeline with a small chunking pipeline and a question about what sets
chunk size. It becomes a new working copy, so a saved pipeline you had selected is not
changed. If you have unsaved work, it warns you first. A coach then walks the steps in
order: Document, Parse, Clean, Chunk and Index. The first step only loads the document.
Each later step is a real run, started with its **Run** button (for example **Run Parse**),
and the coach reads the result back to you in plain words. The Inspector shows the card of
the step you are on. If a step fails, the coach shows the card's own error and stays on that
step, and **Run** is still there. The Ask step asks the question for real. The main pane
lists every piece Search returned, in rank order, marks the piece that holds the answer, and
draws a dashed line after the pieces the answer step reads. The coach says whether the answer
is among those pieces, below them, or not in the returned pieces at all, with the numbers from
your run. On a phone the list opens in the output sheet. The last step, Fix, takes you back
to the Chunk card: **Open Chunk settings** selects it, and **Build the index** stays blocked
until Chunk size is the value the coach names. After the index is built the button reads
**Ask again** and asks the same question. The coach then says where the piece with the
answer was before and where it is now. Only when it moved up does the coach add the one rule
to take away, and when it did not, it says one setting does not fix every miss. The main pane
keeps the first list until you ask again, then shows the new one.

While the guided run is on, the Ask panel is hidden, not closed. **Leave the guided run**
ends it and the panel comes back as it was. The invite shows again only while nothing has
run on Build. A reload keeps your step and results for as long as the tab is open.
**I know RAG, hide this** hides the invite in this browser. The only way to bring a hidden
invite back is to clear this site's data in the browser.

### Start from a template

**Start from a template**, beside the Pipeline picker, opens two sets of cards. The first,
**What are your documents like?**, sets how the document is read and cut: text documents,
reports with tables, scanned PDFs, or manuals and guides. The second, **What will you ask?**,
sets how the search and the answer work: balanced, exact terms, best precision, vague
questions, or a chat answer. Each card says what it does, what it is good for and the steps
it uses. A card marked **Needs a key** calls a language model, so add your key in Settings
before you Ask. **Your pipeline** lists the steps the two cards make and names a sample to
try them on.

Home's **Start from a template** opens Build with these cards already open. The link is
`/build?templates=1`; the cards open once, so reloading Build does not open them again.

**Use this pipeline** puts that pipeline on Build as a new, unsaved pipeline, on the
document and question you already have. A line then says what Build holds, with **Undo**,
which puts your previous pipeline back exactly. **Keep my current pipeline** closes the
cards and changes nothing.

### Saved pipelines

Changing a step marks the pipeline **edited**. A saved pipeline then offers **Save**, which
writes the change back, and **Save as new**, which asks for a name. The Starter cannot be
overwritten, so editing it offers **Save as new** only. Changing a saved pipeline's
document counts as an edit too, because the pipeline owns its documents; the Starter runs
on any sample, so for it only a step counts. Typing a different question is never an edit.
**Rename**, **Delete** and **Copy link** sit beside a saved pipeline.

Once a pipeline is saved, **Copy link** puts the whole configuration and its documents in a
URL. A link carries the pipeline's settings, its documents and its question. Whoever opens it
gets the pipeline on their Build page. Links made by older versions still open. One that
cannot be opened here, because it has a step this version has no place for or a strategy
this server does not have, or documents that are not uploaded files, stays in the address
bar. Build says why and keeps the pipeline you had before. A link that is not a pipeline at
all is refused and nothing is saved. If it was built on a bundled
sample, Build the index and Ask work at once. Your own uploads do not travel with the link:
the Document card tags the file Removed from the server, and picking a sample keeps every
shared setting.

A pipeline only keeps the settings this server offers on its cards. A link, an imported
file, a saved pipeline or the pipeline on Build may carry one it does not: a prompt or the
reranker revision, which are fixed in the playground, or a setting Pandion no longer knows.
That setting is dropped as the pipeline opens, from the saved copy too, and the page says
so in one sentence, such as "Removed a setting this server does not allow: answer prompt."
The pipeline then runs as usual.

When a bundled sample is updated, its fingerprint changes. A pipeline saved on the old
copy opens on the current one, says so once, and is not marked edited, so **Copy link**
works at once.

Opened from Evaluate's **Open on Build to watch each step**, Build shows **Back to
Evaluate**, and saving there goes back to Evaluate with the new pipeline selected.

Pipelines live in your browser, up to 20. Saving a 21st removes the oldest, and the page
says which. One saved by an older version that cannot be opened here is never removed
this way.

**How your browser holds a pipeline.** Build keeps one working pipeline: the copy you
edit, which Compare and Evaluate use too. Your saved pipelines are separate, named
copies. **Save** copies the working pipeline into your list, and opening a saved pipeline
copies it back onto Build. Editing on Build never changes a saved pipeline until you save
again. A link and an exported file carry the same settings. Pipelines saved by an older
version are converted once, and one that cannot be is kept with the reason.
[Architecture](architecture.md#how-the-web-app-holds-a-pipeline) has the details.

## The Ask panel

The Ask panel is docked at the right edge of Build, and the main pane shrinks to make
room, so nothing is covered.

- **Resize** it by dragging its inner edge, or focus the edge and use the arrow keys.
- **Move** it to the left edge with the button in its head.
- **Close** it, and a round **Ask** button sits at the bottom right with the number of
  results the last question found. Closing keeps the question and the results. While the
  index builds, the button is greyed out and Ask opens once the build is done.
- **Alt+A** opens and closes it from anywhere on Build.
- The side, the width and whether it is open are remembered in this browser.
- Below 1024 px wide (a tablet or a phone), the panel is a bottom sheet over the page
  instead, and the page behind it stays still while it is open.

### Ask's settings

The panel holds the question and three blocks of settings, summed up in one recipe line.
Above the question, **Answer with** chooses **Search** or **Chat with a model**. **Search**
shows the kept pieces and costs nothing. **Chat with a model** writes an answer with
citations, and needs a key. A short line beside the choice says what it means: with no key,
Chat is off and **Add a key** opens the key panel; on Chat, it names the model and whose key
it uses, and **Change model** opens the settings at the Answer card. With a key set, Search on and an answer
showing, a hint under the answer offers **Use Chat**; **Dismiss** hides it until you leave
the page or reload. The choice is locked while a question is running.

- **Retrieval.** The search strategy: Hybrid (RRF), Dense or BM25, and how many candidates
  it hands on (20 by default). **Compare searches** opens Compare on this step, with the
  question shown at the top. **Rewrite** chooses how the question is changed before the
  search:
  - **None** searches with the question as you typed it.
  - **PRF** borrows the most distinctive words of the top dense hits for the keyword
    search. It needs no key, and it switches the search to Hybrid.
  - **LLM** has a chat model restate the question in the document's words. It needs a key.

  With a rewrite on, a **Searched for** line under the question shows what the search
  used. The answer still uses the question as you typed it.
- **Rerank.** None, Cross-encoder, MMR or LLM, and how many pieces to keep (5 by default).
  LLM needs a key.
- **Answer: Search** or **Answer: Chat.** The fields of the chosen answer, such as how many
  pieces to show, or the chat model. Choosing Search or Chat happens above the question.

### Results

**Ask** runs the question against the index and shows the ranked pieces right under the
question. Ask sends the pipeline, its documents and your question to `POST /api/v2/ask`;
the documents are indexed first when they are not indexed yet. A question can be up to
2,000 characters long. When the answer arrives, the panel scrolls to it. The sample's
questions and the settings come after the answer, so you can change a setting and ask
again to see the pieces move. Picking one of the sample's questions takes you back up to
the question box.

- Under a fresh answer, a line reads "Try another search or a reranker, and ask again."
  Its **Change settings** button opens the settings and scrolls to them. When a key is
  set and Search is on, the line is the Chat hint instead (**Use Chat**, **Dismiss**), until
  you dismiss it.
- Change a setting and an amber note reads "Settings changed. Ask again to see what
  changed." The Ask button gets a soft ring until you press it.

- With a reranker on, the panel shows the search order against the reranked order, joined
  by a slope: one line per kept piece, rising in the accent colour and falling in grey.
  When the panel is narrower than 640 px (and always as a bottom sheet), the reranked list
  comes first and the search order folds under **Show search order**. Widen the panel to
  see the two side by side.
- With Chat, the answer cites the passages it relied on. Each citation is checked against
  the parsed document, and one that does not match is marked unverified. Clicking a
  citation opens the PDF page with the sentence highlighted. For a document without
  pages it opens the document's text with the cited words marked instead.
- Every part of a Chat answer gets a label, whichever model answered. A part is cited,
  weak, matched by similarity, has no source, or is not in the documents. A line above
  the answer counts them, for example "2 of 3 parts cite a piece." A part with no source
  is drawn in red with a small "No source" tag, because nothing in the retrieved pieces
  backs it. A part where the model says, in one sentence, that the documents do not
  answer something ("The documents do not say what the warranty covers.") is drawn in
  plain ink with a "Not in the documents" tag: the model is being honest, so it is not
  marked as a fault, and it is not counted in the line above. A similarity match only
  means a shown sentence is close in meaning, not that it proves the part. Untick
  **Mark parts with no source** to hide those marks; this browser remembers the choice.
- With two or more documents, **Search in** above the question chooses what Ask searches:
  **All N documents**, or one file. One file sends `where: {document: [sha]}` with the
  question, the header reads "Searching report.pdf only, 31 pieces" and the question box
  invites a question about that file. Changing Search in after a question has run puts the
  results away with "You changed where to search. Ask again to search report.pdf only.",
  since they no longer match it, and the earlier questions list says which file each one
  searched ("Working copy, no rerank, in report.pdf only: 5 pieces"). Each piece then names its file on its meta line, a
  coloured dot beside the filename; each document keeps its colour by its place in the
  pipeline's list, and the name is always there, so colour is never the only cue. The
  sentence above the pieces names the file too ("Found in the 2nd piece, from
  report.pdf"). Clicking a piece, or its **Show in PDF** or **Show in text**, opens that
  piece's own file with the piece marked, and a **Showing** picker there switches to the
  best piece of another file. Under a Chat answer, a **Sources** line names the files its
  cited pieces came from, and a citation opens its own file, its page or, for a file
  without pages, its text with the cited words marked. With one document none of this shows.
- A piece that holds a table shows it as a table when the piece is open, and says each row
  in words (Measure: Before, After) when it is cut to two lines, as on Compare.
- The questions asked earlier in the tab stay in a list below.
- Leaving Build for another page and coming back in the same tab keeps the built steps, the
  last answer and the questions asked. A step whose settings changed meanwhile comes back
  marked out of date.

## Compare

Compare runs up to ten recipes of one step and puts them side by side. The server holds
to the same cap.

1. **Pick a step:** Parse, Chunk or Retrieve.
2. **Set up the recipes.** Each recipe is a card that reads as a sentence. Tap a value to
   change it in a small editor under it. Add a recipe from a few suggestions or from
   defaults. A sentence above the cards says what the run is about to show.
3. **Run.** Each recipe says whether it is waiting, running (with the seconds counted) or
   finished, and **Stop the run** ends it. A recipe that fails says at which step and why,
   with **Change this recipe**, while the others finish.

Compare sends one comparison to `POST /api/v2/comparisons`. Through the step itself, each
recipe's result comes back by id. Through the search, the question's own gold passages,
when known, let Pandion score each recipe and name the best; without them, each recipe's
results are shown unscored.

### Reading the results

- **Three recipes or fewer** open as columns side by side (one at a time below 820 px),
  with a sentence that says what differs, such as "Halving the size doubles the pieces,
  from 6 to 12."
- **Four or more** open as an overview table you can sort by each number (a list with
  **Sort by** on a narrow screen), with a sentence that names the extremes. From the table,
  open one recipe beside your pipeline, or tick up to three to read side by side, then step
  through the rest with **Previous** and **Next**. The browser's Back button returns to the
  table.
- Each recipe also says how long it took, how many model tokens it used and what that
  cost: three more columns in the table (**Time**, **Tokens** and **Cost**, each sortable),
  or one line under each recipe's name with three or fewer. They count only the step being
  compared and the steps after it, so the order the recipes ran in does not change them.
  Tokens show a dash when no model was called, and Cost says "local" when no paid model
  ran, "no price" when a model is not in Pandion's price table, and never $0 for something
  unknown. A recipe that an earlier run had already stored says "from cache", because its
  time and cost were not measured this time, and it sorts last.
- A line under the recipes says how long the shared steps before the compared one took,
  once, or that they came from the cache this time. Cost is an estimate, with the date of
  the prices. Results from an older server show none of these.
- The page says "the answer" only when Pandion scored the run: the question is one of the
  sample's own, or it carries its gold passages, and the run stops at the search. Each
  recipe's rank of the answer is Pandion's, and the recipe Pandion names best says **Best**
  beside its name. Before the run, the line under the title says "This question's answer is known, so
  Pandion scores each recipe." When every recipe ties for best, none is marked, since the
  finding already says so. With any other question, or through a chat answer, the Answer
  column is hidden and no recipe is marked. A stopped run names no best, and when the
  scores cannot be read, the page says so and does not say where the answer is.
- With several documents, every recipe runs on all of them, and the line under the title
  reads "Every page uses these documents" with a file tag (colour dot and filename) for
  each. On Chunk the counts are totals and the median and largest 5% are over every piece
  from every file, as Pandion sums them up; the picture becomes **The documents, to
  scale**, one line per file in its colour, and a column lists each piece with its file.
  On Retrieve the Answer cell names the file the answer came from ("Found 1st," and its
  file tag), and each square in **Top 5, by piece** takes its file's colour, with the file
  in its name and on hover. With three recipes or fewer, each search column's pieces name
  their file and are numbered by their place in it. While Pandion adds up the totals a
  chunk column says so, and if they cannot be read it says that, rather than show one
  file's numbers. With one document nothing changes.
- A setting the server refuses is said under the recipe it belongs to, each setting under
  its own name, with the first one's editor open. A problem with the whole step is said
  above the cards in the server's words.

### Experiments

**Save experiment** keeps the step, the recipes and the documents (all of them, when the
pipeline has several) by name in this browser, without the results; opening it puts them
all back. A suggested name says how many, such as "Chunkers on 3 documents". If one of them
is gone since (an upload on the demo expires), the page says it is missing and holds the run. **Your experiments** opens one again. You can keep up to 20; saving
another removes the oldest.

**Use on Build** puts a finished recipe on your pipeline.

## Evaluate

Evaluate scores a pipeline on its documents. It asks the pipeline every question in the
question set and says how many found their answer, at what rank and in which piece. It
needs no key.

Evaluate sends the whole question set in one request (`POST /api/v2/evaluations`). Pandion
scores every question; the page shows its numbers: the hit rate, mean reciprocal rank,
recall when a question has several passages, and the ranks, overall and by tag. Each
question's row fills in as it finishes.

Pick the pipeline first. The **Pipeline** picker lists **Ready to use** (the Starter
pipeline, marked Ready-made), **Your pipelines**, and **On Build** when Build has a pipeline
that is not saved (marked Not saved), then **Build your own…**. The Starter on a document
of your own counts as not saved, so Evaluate scores it on your document. Arriving with nothing
chosen, Evaluate opens on the Starter with its document and question set ready, so one
press of **Evaluate** scores it. Under the picker, **Documents** lists the pipeline's files,
each with **Preview**. **Change** tries the pipeline on another document; a saved pipeline keeps
its own, and the page says so. A document of your own needs your own questions, under
**Use your own questions**: a JSON or CSV file, started from the template, with a question and
the sentence that answers it on each line. On the hosted demo an uploaded set lasts until you
close the browser tab; run the playground locally to keep your sets. If that document
was part of an older set for several documents, that set is removed from all of them.

With two or more documents the page speaks of all of them: "How often the pipeline finds
the answer in 3 documents." **Documents** lists the pipeline's documents, all of them, as
file tags; add or remove documents on Build. The **Question set** card holds one set for
the pipeline: "24 questions from golden-set.csv, covering all 3 documents", then how many
questions name each document and how many name none (**no document named**, found in any
document). **Upload another set** replaces the set for every document at once
(`POST /api/v2/questions`); on the demo it is kept whole in the tab, tags and answers too.
A new set replaces in full any older set it overlaps: if an older set covered this
pipeline's documents and others too, it is gone from all of them, so its questions are
never asked with the new ones.
**Write questions for me** asks which documents to write for (**Write for**, one checkbox
per document with how many questions it already has) and how many **Questions per
document** (at most 25): "6 for each of 2 documents: 12 questions, written one document at a
time. They join your set; nothing in it is replaced." A model writes them one document at a
time, on your key, through each document's own generate run; the sheet says which document
it is on, and **Stop** cancels that one and starts no other, keeping what was already
written. The review is grouped by document, with Keep, Edit and Drop as for one document.
**Save** adds the kept questions to the one set: it sends the set as it is, every question
with its tags, answer and document, plus the new ones, each naming its document, so nothing
in it is lost. The card then says what was written: "30 questions: 24 from golden-set.csv
and 6 written by Claude Haiku 4.5" (or "from the samples"), and writing again adds to the
written count. **Start from the template** downloads the CSV template,
whose `document` column names each question's file. A question that names its document must
find its evidence in that document; one naming none is found in any. With nothing kept,
the bundled samples among the documents lend their own sets, each question naming its
sample. After a run the line reads "19 of 24 questions found the answer in the top 5. 5
missed.", a **By document** table gives each document's found of total with a bar, then the
questions naming none, and each question shows its file tag ("any document" when it names
none). **Show** narrows the list to one document's questions, and after a run to the
misses. Best so far is kept per set of documents and questions: adding or removing a
document, or questions, starts a new best. With one document the page is as it was.

**Build your own…** opens a side sheet with a name, the documents and one setting for each
step (Parse, Clean, Chunk and Index on the index side, then Rewrite, Retrieve and Rerank),
starting from the selected pipeline. **Save and select** saves it and scores it next; with
no name it asks for one. **Open on Build to watch each step** opens Build with those
settings and documents, and says first when that replaces an unsaved pipeline there.

**Change a step on Build** and **Change the search settings** open the selected pipeline on
Build, with **Back to Evaluate**; when that replaces an unsaved pipeline there, the page says
so first.

When the sample's question set has questions planted to miss, the set line says how many:
"2 questions are planted to miss. Open them after the run to see why."

The page says what it does under its title, and **How it is scored** opens a side sheet (a
sheet from the bottom on a phone) that explains the test: what it checks, how a question is
marked, how the text is matched step by step with examples, and every number with its sum
worked out. Under the question set, two lines show what is being scored: the **index side**
(Parse, Clean, Chunk and Index, with a link to change a step on Build) and the **search
side** (Rewrite, Retrieve with how many pieces it returns, and Rerank, with a link to the
search settings on Build).

**Pieces checked** is how many pieces from the top of each search are checked for the
answer. Its **i** button says what that means. Every question is listed before you run,
with its expected answer (when the set gives one, in your own words and never scored) beside
its evidence, the sentence or table row the score looks for.

### Question sets

Each question carries the sentence in the document that answers it, its gold answer. A
question counts as found when a retrieved piece contains that sentence, word for word.
Only differences parsers make on their own are ignored: spacing and line breaks, a word
hyphenated across a line, capital letters, curly against straight quotes, and joined
letters such as "fi". If the sentence is still not there, the score looks once more with
list markers ("1.", "b)", bullets) and letters standing alone set aside on both sides,
because a parser can turn a numbered list into bullets and a watermark printed down the
page can drop single letters into the text. Every other word must still be there, in
order. A question found this way says so: "after setting aside list numbers, bullets and
stray letters the parser changed". The upload check and the score use this same rule, so a sentence
the check finds is one the score can find. A question may carry several gold answers when
the document answers it in more than one place; any of them counts. A table row given both
with and without its `|` bars is one answer written two ways, so it counts once.

A set can hold up to 500 questions. Evaluate sends them all in one request and the
server scores them as one evaluation.

The bundled sets are about the bundled samples. Each question may name the document its
evidence is in, as `document` (a column in CSV). A question without one belongs to the set's
own `document`, or the first document a question names. On a pipeline with one document a
set covers one: a question that names another document is refused, with its row. On a
pipeline with several, one set covers them all, and each question names its document or
none (see [Evaluate](#evaluate)). To score your own PDF, bring your own questions:

1. Download the template on the Evaluate page, as JSON or CSV. The API serves it at
   `GET /api/questions/template?format=json` (or `format=csv`).
2. Fill in your questions, with the sentences from your document that answer them. Copy
   each gold answer from the document; do not retype it.
3. Upload the file on the Evaluate page.

The upload check looks for every gold answer in the document's own text, and tells you
which were not there, with the closest passage it did find. A stray curly quote or a typo
then shows at once, instead of looking like a retrieval failure. A set is stored against
the document's fingerprint, so it can never be scored against the wrong document. On the
demo the set is kept only in the tab; locally it is kept beside the document.

You can also let a model write the questions. Open Use your own questions and press Write
questions for me. A model reads the document part by part and writes one question for each
part, with the passage that answers it. It runs on your own key, so add an Anthropic or
OpenAI key with the Key button first, or set it in .env when running locally, and you pay
for the calls. Pick the model and how many
questions you want (15 to start with, at most 25 on the demo). Every question must quote
its passage word for word from the document. A question whose passage is not found, is
only a heading, or repeats another question is dropped, and you see why. A question that
reuses most of its passage's words is marked copied, because it is easier to find than a
real question would be. You can close the sheet while the model writes; the questions wait
for you there. Then read each one, edit its wording, drop it, or keep it. Nothing is used
until you press Save, which uploads the questions you kept like a file, with the same check.

### Reading a score and a miss

While it runs, one line says whether the index came from the cache or was built now, and a
second line and a bar count the questions: "Searching and scoring question 3 of 6. 2
searches came from the cache." While the index is still being built, that line says "Building
the index first. Questions are scored once it is ready." and every question waits.

The score reads as a sentence with the last run beside it, such as "3 of 5 questions found
the answer. The last run found 5 of 5." The line under it names what changed when one step
did, such as "Both misses are new since Parse changed to Fast text." Under that, every
number has its plain name and its technical name: Hit rate (Hit@5), Mean reciprocal rank
(MRR), Average rank when found (mean rank) and Middle rank when found (median rank), plus
Evidence found (recall) when a question has more than one passage. Each says what it was in
the last run when that differs. "What these mean" opens the explanation.

Under the score, **Best so far** compares the run with your best run for the same questions,
documents and Pieces checked. The first run becomes the best. A better run says "New best."
and names the questions it won, and any it lost. A worse run says how many fewer it found,
names the questions it lost, and offers **Load the best pipeline**, which puts that pipeline
on Build.

Both a worse and a better run offer **Compare the two**. It opens under the box, and pressing
it again closes it. A worse run is set against your best; a better run against the best it
replaced. **What differs** lists only the steps whose strategy or settings differ, each
side's strategy and the differing settings in plain words, then the steps that are the same
in both. **Question by question** puts each question in one of four groups: only the other
run finds it, only this run finds it, both find it, or both miss it. Each question shows
each run's rank, or the step where the answer was lost. Best so far keeps only found or
missed for each question, so the first time the panel opens, Evaluate runs the other
pipeline once on the same questions to get its ranks. Steps it shares with this run come
from the cache, so this is quick. That run does not count as a new run for Best so far. The
groups come from that run. If it found some questions differently from when the best was
saved, one line under the groups says how many, and names the steps that can give a
different result each run.

Only questions decide better and worse: hit rate first, then mean reciprocal rank to break a
tie, and a question either run could not score is left out. Pandion makes the comparison
(`report.against(baseline)`), and its notes show under the verdict when the two runs are not
quite like for like, such as "llm_rerank can give a different result each run, so a newly
missed question may be noise." If the comparison cannot be made, the box stays away for that
run rather than guess. The best is kept in this browser only, and **Forget best** clears it.

Changing Pieces checked after a run does not relabel the numbers: the page says "Scored at 5
pieces. Evaluate again to use 3."

**Cancel** stops the run before its next question. The questions that finished keep their
rows and the score counts only them: "Stopped after 4 of 10 questions. 3 of the 4
questions scored before the stop found the answer." The questions it never reached read
Not run. A stopped run is compared with no last run, and it is not kept as the last run
to compare against. If the scores cannot be read once the run ends, the page tries once
more, then says "The scores could not be read. Run it again." instead of showing an empty
score.

One mark per question sits under the score; pressing a mark brings its row into view. Each
row gives its verdict in a word and why in a sentence, such as "Found in the 1st piece, word
for word." or "Not in any of the 6 pieces that came back, so no number of pieces checked
would find it." **Details** opens the question in the side sheet: its evidence and expected
answer, and the top three pieces that came back, with the one that holds the answer marked.
On a phone the evidence folds away from the rows after a run, since Details shows it. The
previous score of each pipeline in this tab is kept.

### Why did this miss?

A missed row has a **Why did this miss?** button. It opens the side sheet, which follows
the answer sentence down the pipeline, one step at a time, and stops at the first step that
lost it. The server traces every miss as it scores it, so the trace arrives with the
scores:

- **Parse.** Is the answer sentence in the parsed text? When all its words are there but
  other text sits between them, the row shows the parsed text with the answer's words
  marked and the other words struck through. A parser that reads straight across two
  columns does this.
- **Clean.** Is it still there after each cleaner?
- **Chunk.** Is it whole inside one piece, or cut across two?
- **Search.** Did the piece that holds it come back?
- **Rerank.** When there is a reranker, where did it put that piece?
- **Top 5.** Was it among the pieces checked?

The steps after the one that lost it say "Not checked." The trace ends with a fix to try and
a button that opens that step on Build. The check is the same one Evaluate scores with, so
a trace never disagrees with the score.

## Library

The Library lists every saved pipeline and saved experiment, with All, Pipelines and
Experiments filters. Each row says what it runs, when it was saved and where its document
stands: a sample (always there), an upload and how many hours it has left on the demo,
gone, or on this machine when you run locally. A pipeline's row also names every document
it owns. Exported files carry that list, and a file exported before the list existed is
read as a pipeline with its one document. When an item has several documents, the row
speaks for the one that needs you: the first one gone, else the upload with the fewest
hours left on the demo, else the first. A sample listed first never hides an upload that
will expire.

Export writes version 2 files: each pipeline as its settings, documents and question.
Files from older versions still import. A pipeline in one that cannot be opened here is
imported as a kept item with the reason, never skipped, and the import line says how many
were kept. A kept item exported again comes back the same. A pipeline whose settings are not
a pipeline file's shape is skipped and counted.

- **Open** sends a pipeline to Build as the working pipeline, or an experiment to Compare.
- An item an older version saved that cannot be opened here is listed with the reason.
  Export keeps a copy; nothing removes it but Delete. Saving a new pipeline when twenty are
  kept removes the oldest one that can be opened, never one of these.
- When an upload that a saved item uses has under 6 hours left on the demo, an amber
  notice offers to export those items with the document. Every document counts, so an
  item with one document gone and another leaving soon is still in the notice.

### Export

Export one item, the ones you tick, or everything, as one
`rag-playground-<name>.ragplayground.json` file.

- **With the document:** **Include the document** puts the PDF in the file, so the items
  still work after the upload expires. On the demo it is on for uploads. Every upload an
  item uses goes in, not only its first document.
- **Without the document:** the file holds only the settings. A sample is always there, so
  items on a sample need nothing more. Items on an upload ask for the PDF again when opened.

### Import

Choose the file, or drop it on the Library page, in any browser.

- Items are merged by id and never duplicated, and an import never removes anything
  already saved.
- New items go in, newest first, while there is room (at most 20 pipelines and 20
  experiments). The page names any it left out, and any item in the file it could not
  read.
- An experiment is checked as Compare checks its own: 1 to 10 recipes.
- A PDF in the file is uploaded again. On the demo its limits still apply, and a refusal
  is said in plain words.

## Take your pipeline with you

**Copy as YAML** on Build puts your pipeline on the clipboard as a Pandion pipeline file.
Save it as `pipeline.yaml` and run it with the `pandion` command, such as
`pandion index pipeline.yaml report.pdf`, or with `Pipeline.from_yaml` (see
[the pandion command](pandion.md#the-pandion-command)).
The prompts and the reranker revision are Pandion's own, as in the playground. If the
pipeline has a problem, the page says what it is and copies nothing. If the browser refuses
the clipboard, the page says so.

### Take it home

**Take it home**, next to Copy as YAML, gives you the pipeline as a small Python project
in a zip. It opens a sheet that shows what the zip holds:

- `README.md`: how to set it up and run it. It names the environment variable for the
  key, if a step calls a model.
- `pipeline.yaml`: the pipeline with your settings.
- `run.py`: indexes the files in `docs/`, then asks your questions.
- `questions.json`: your question set, when you include it.
- `requirements.txt`: what pip installs.
- `docs/`: an empty folder for your documents.

Click a file to see its text. The server writes every file with `pandion.new_project`
(see [pandion.md](pandion.md)), so what you see is what you get.

The sheet also says what stays behind: your documents, your key and the saved index.
Keys are never written to a file, so the zip only names the variable to set. run.py builds
a fresh index the first time it runs.

When Evaluate has a question set for the pipeline's document, the sheet offers **Your N
questions**. When Evaluate also has a result for this exact pipeline and question set,
scored at 5 pieces checked as run.py scores, it offers **Scores to beat**, which adds
that result to the README. Untick either to leave it out. The hosted demo packs at most
50 questions; a larger set is shown unticked, and the zip goes without it. On the
demo, the README also lists any setting you set to the demo's cap, so you can raise it
at home.

**Download** saves the zip. Unzip it and follow the README. The project needs Python
3.13. If the pipeline cannot be packed, such as one that loads plugins, the sheet says
why in plain words.

## Read

The Read page lists the author's posts on each step, in pipeline order, with the date
each was published. Steps with no post yet say so.

## Your data and privacy

The **Your data and privacy** page (`/privacy`) lists what is kept in this browser and on
the demo server (or on this machine), where, and for how long. It can delete your saved
pipelines and experiments, and on the demo your uploads, at once. It asks on the page
before deleting anything. It is linked from Home's footer, from Read and Library, and from
the header as Privacy on wide screens. [privacy.md](privacy.md) has the same facts.
