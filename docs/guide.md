# Guide

This page walks through each page of RAG Playground: Home, Build with its Ask panel,
Compare, Evaluate, Library, Read and the privacy page. For what each strategy does, see
[strategies.md](strategies.md).

## Contents

- [The Document bar](#the-document-bar)
- [Home](#home)
- [Build](#build)
- [The Ask panel](#the-ask-panel)
- [Compare](#compare)
- [Evaluate](#evaluate)
- [Library](#library)
- [Read](#read)
- [Your data and privacy](#your-data-and-privacy)

## The Document bar

Build, Compare and Evaluate work on one document. The **Document** control in the header
of those three pages names it, and opens a menu with the bundled samples, your uploads and
**Upload a PDF**. Home, Read, Library and Privacy do not show it, because they do not work
on a document. Home has its own **Try a sample** and **Use your own PDF** buttons.

The four samples were written for the playground, and each one shows a problem:

| Sample | Pages | What it shows |
|---|---|---|
| A primer on chunking | 3 | Headings, a running footer and a repeated paragraph. It is the default. |
| Scanned notes | 2 | Pictures of text with no text layer. Without OCR the parse is empty. |
| Two-column report | 2 | Rows drawn across both columns. A plain parser joins halves of different sentences. |
| Table of figures | 2 | Answers in a ruled table. A plain parser loses the row labels; the heading chunker keeps the table whole. |

Each sample has its own question set, so Evaluate scores the sample you loaded.

When you choose another document, the results on the page are marked out of date, as
they are when you edit a step, and Evaluate opens a fresh evaluation for it.
A question you typed stays. A question the sample filled in is cleared, so you are not
asked about the old document; the empty box then suggests asking about the new one, and
Ask waits until there is a question.

When a saved upload has expired, or was uploaded in another browser, the control turns
amber and reads Missing with the filename. Build, Compare and Evaluate then say so in one
note with a **Pick a document** button, and their run buttons wait and say "Needs a
document." A sample saved with an older copy of its PDF is not missing: when its filename
is exactly a current sample's, and no upload in this browser has that filename, the page
switches to the sample's current copy and says so once. Uploads are never matched by
filename.

## Home

Home (`/`) is the first page. It has:

- a **Try a sample** button, which loads the first sample (unless your document is already
  a sample) and opens Build;
- a **Use your own PDF** button, which opens a file picker and opens Build once the upload
  is done. If the upload is refused, it says why under the buttons. One line under the
  buttons says what happens to your file: on the demo, the page and size limits and how
  many hours until it is deleted; running locally, that it stays on your machine;
- a **See how it works** link, and three facts: no sign in, samples or your own PDF, and a
  key only for chat answers;
- the steps you can look inside;
- one section each for Build, Compare and Evaluate, with a short clip and a **Try it
  yourself** button. With no document yet, the button loads the first sample, then opens
  the page. One line under the button names the document the page will use, and its
  **Change** button opens the Document menu;
- links to Read, to running it on your machine and to the source on GitHub.

The clips are muted and loop. Each has a Pause and Play button. With reduced motion turned
on, they hold still on their poster until you press Play. Any path the app does not know
opens Home.

## Build

The column on the left of Build is the index pipeline: Document, Parse, Clean, Chunk and
Index, one card each with its own settings. The Document card only says which document is
in use.

- **Build the index** runs the steps. Each card also has its own **Run**.
- **Settings** on a card opens its settings. Once the index is built, the line above the
  cards invites you to change a step, such as the chunk size, and build again, and points
  to Compare for several settings side by side.
- Selecting a card shows its output in the main pane beside the column: the parsed
  elements with their types and pages, a diff of what each cleaner removed, the chunk
  boundaries drawn over the text, or the index contents. Until a card is selected, the
  main pane says to pick a step.
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

### Saved pipelines

Name the pipeline on Build and save it. Switch between saved pipelines from the bar under
the Index pipeline header, and edit any of them. A pipeline carries its document, so
loading one changes the Document control too.

Once a pipeline is saved, **Copy link** puts the whole configuration in a URL. Whoever
opens it gets the pipeline on their Build page. If it was built on a bundled sample, Build
the index and Ask work at once. Your own uploads do not travel with the link: the
Document control reads Missing, and picking a sample keeps every shared setting.

Pipelines live in your browser, up to 20. Saving a 21st removes the oldest, and the page
says which.

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
- **Answer.** **Search** shows the kept pieces. **Chat with a model** writes an answer with
  citations, and needs a key.

### Results

**Ask** runs the question against the index and shows the ranked pieces right under the
question. When the answer arrives, the panel scrolls to it. The sample's questions and the
settings come after the answer, so you can change a setting and ask again to see the pieces
move. Picking one of the sample's questions takes you back up to the question box.

- Under a fresh answer, a line reads "Try another search or a reranker, and ask again."
  Its **Change settings** button opens the settings and scrolls to them.
- Change a setting and an amber note reads "Settings changed. Ask again to see what
  changed." The Ask button gets a soft ring until you press it.

- With a reranker on, the panel shows the search order against the reranked order, joined
  by a slope: one line per kept piece, rising in the accent colour and falling in grey.
  When the panel is narrower than 640 px (and always as a bottom sheet), the reranked list
  comes first and the search order folds under **Show search order**. Widen the panel to
  see the two side by side.
- With Chat, the answer cites the passages it relied on. Each citation is checked against
  the parsed document, and one that does not match is marked unverified. With sentence ids,
  each claim is shown as cited, weak, matched by similarity, or not grounded. Clicking a
  citation opens the PDF page with the sentence highlighted.
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

### Reading the results

- **Three recipes or fewer** open as columns side by side (one at a time below 820 px),
  with a sentence that says what differs, such as "Halving the size doubles the pieces,
  from 6 to 12."
- **Four or more** open as an overview table you can sort by each number (a list with
  **Sort by** on a narrow screen), with a sentence that names the extremes. From the table,
  open one recipe beside your pipeline, or tick up to three to read side by side, then step
  through the rest with **Previous** and **Next**. The browser's Back button returns to the
  table.
- The page says "the answer" only when the question is one of the sample's own. With any
  other question, the Answer column is hidden.

### Experiments

**Save experiment** keeps the step, the recipes and the document by name in this browser,
without the results. **Your experiments** opens one again. You can keep up to 20; saving
another removes the oldest.

**Use on Build** puts a finished recipe on your pipeline.

## Evaluate

Evaluate scores a pipeline: the one on Build, or any saved pipeline you pick, on the
document in the Document control. It asks the pipeline every question in the question set
and says how many found their answer, at what rank and in which piece. It needs no key.

### Question sets

Each question carries the sentence in the document that answers it, its gold answer. A
question counts as found when a retrieved piece contains that sentence. A question may
carry several gold answers when the document answers it in more than one place; any of
them counts.

The bundled sets are about the bundled samples. To score your own PDF, bring your own
questions:

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

### Reading a score and a miss

The score reads as a sentence with the last run beside it, such as "3 of 5 questions found
the answer. The last run found 5 of 5." The line under it names what changed when one step
did, such as "Both misses are new since Parse changed to Fast text."

One mark per question sits under the score; pressing a mark jumps to its row. Each row
gives its verdict in a word and why in a sentence, such as "Not in any of the 6 pieces
that came back, so no number of pieces checked would find it." Open a row to see the
sentence that answers the question and the top three pieces that came back, so you can
see why it missed. The previous score of each pipeline in this tab is kept.

## Library

The Library lists every saved pipeline and saved experiment, with All, Pipelines and
Experiments filters. Each row says what it runs, when it was saved and where its document
stands: a sample (always there), an upload and how many hours it has left on the demo,
gone, or on this machine when you run locally.

- **Open** sends a pipeline to Build as the working pipeline, or an experiment to Compare.
- When an upload that a saved item uses has under 6 hours left on the demo, an amber
  notice offers to export those items with the document.

### Export

Export one item, the ones you tick, or everything, as one
`rag-playground-<name>.ragplayground.json` file.

- **With the document:** **Include the document** puts the PDF in the file, so the items
  still work after the upload expires. On the demo it is on for uploads.
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

## Read

The Read page lists the author's posts on each step, in pipeline order, with the date
each was published. Steps with no post yet say so.

## Your data and privacy

The **Your data and privacy** page (`/privacy`) lists what is kept in this browser and on
the demo server (or on this machine), where, and for how long. It can delete your saved
pipelines and experiments, and on the demo your uploads, at once. It asks on the page
before deleting anything. It is linked from Home's footer, from Read and Library, and from
the header as Privacy on wide screens. [privacy.md](privacy.md) has the same facts.
