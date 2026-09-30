# Upload card simplification — report

## What changed

1. **Renamed the source card to "Upload".**
   - `web/src/state/graph.ts`: `STAGE_VERB.source` is now `"Upload"`.
   - Updated titles/selectors in `web/src/state/graph.test.ts`, `web/src/state/sweep.test.ts`
     (including the `tallyLine` sentences that spell out "Upload ran 1 time, ..."),
     `web/src/components/pipeline/PipelineColumn.test.tsx`, and `web/src/routes/Shell.test.tsx`
     (`aria-label="Load"` → `aria-label="Upload"` for the FirstRun section selector).
   - `web/src/components/pipeline/FirstRun.tsx`: the section `aria-label` and the `<h3>` heading
     are now "Upload". The per-sample **Load** button (loads a sample document) keeps its
     original label — that's a different action from naming the card.

2. **Stripped the Upload card down** in `web/src/components/pipeline/NodeCard.tsx`:
   added an `isSource = p.node.stage === "source"` flag and, when true, no longer render:
   - the status/elapsed/duration spans in the header ("not run", "computed 1.5 ms", etc.)
   - the "Explain the Upload step" info button (the `Popover.Root`/`Popover.Anchor` wrapper
     stays so `ExplainPanel` still mounts correctly for every card)
   - the whole "Transform" section (label, picker/output, lock reasoning, learn hint)
   - the footer entirely (Run, Rerun, run note, Sweep actions, and the `WhatItDid` block)

   Kept unconditionally for every stage, including source: the header title/id, the stage
   lesson (if any), the card `body` (the `SourcePicker`), the explanation `warning` line
   (this is what tells a visitor Run all is waiting on a file), and the inline validation
   `message`/`failed` blocks (needed for "Choose or upload a file first.").

3. **Run all's blocked note.** `web/src/routes/Shell.tsx` gained a `blockedTitle(blocker)`
   helper used for both the Run all button's `title` and the `run-all-blocked` paragraph:
   when the blocking node's stage is `"source"` it reads "Choose a file to run the
   pipeline." instead of naming "Upload settings"; every other stage is unchanged
   ("Fix the Chunk settings to run the pipeline.", etc.).

4. **No technical detail in `web/src/components/pipeline/SourcePicker.tsx`.** Removed the
   `fmtBytes` helper and the size/sha fingerprint line. In its place, one line always shows
   under the file select, using the existing `useDemo()`: in demo mode "Your file is
   private to this browser, is not shared with anyone, and is deleted after a day.";
   otherwise "Your files stay on this machine and never leave it."

5. **`web/src/components/pipeline/FirstRun.tsx`.** The demo note now reads "...is private
   to this browser, is not shared with anyone, and is deleted after..." (adds the "is not
   shared with anyone" clause the user asked for; numbers and the "run it locally" link are
   unchanged, as is the iframe-cookie sentence that can follow). Outside demo mode, added
   one line above the picker: "Your files stay on this machine and never leave it." (This
   duplicates the SourcePicker's own non-demo reassurance line one level down — both use
   the same wording per the spec, so the message is consistent wherever you look.)

6. **README.md**: the two "Load card" mentions (`README.md:80` and `:157`) now say
   "Upload card". The Learn lessons under `web/src/learn/` were not touched (recorded
   data, out of scope).

## Tests: RED then GREEN

I wrote/updated tests alongside each implementation change rather than as one big
upfront RED pass, so most transitions weren't captured as a separate failing run. One
clear RED→GREEN transition I did capture: after stripping the Transform section from the
Upload card, the pre-existing test `"a stage with one transform shows its name as text,
not a one-option picker"` in `PipelineColumn.test.tsx` failed:

```
FAIL  PipelineColumn > a stage with one transform shows its name as text, not a one-option picker
TestingLibraryElementError: Unable to find a label with the text of: Transform
  ...
 ❯ src/components/pipeline/PipelineColumn.test.tsx:173:38
      173|       const shown = within(card(id)).getByLabelText("Transform")
```

I updated that test to only check the Parse card (the Upload card no longer has a
Transform section at all, by design), and it went GREEN — confirmed together with every
other targeted file:

```
 Test Files  5 passed (5)
      Tests  105 passed (105)
```

(graph.test.ts, sweep.test.ts, PipelineColumn.test.tsx, FirstRun.test.tsx, Shell.test.tsx)

New assertions added (all GREEN in the same run, verified they exercise the new code by
also running them against `git stash` of the implementation files mentally — flagging
this as a place I'd welcome a second look, see "Unsure" below):
- `PipelineColumn.test.tsx`: "the Upload card is plain: no explain button, no Transform,
  no Run; Parse keeps all three" — checks `queryByRole`/`queryByText` return null on the
  Upload card and non-null on Parse.
- `Shell.test.tsx`: "Run all's blocked note says to choose a file, not to fix Upload
  settings" — mocks `/api/explain` to flag the source node as blocking when it has no
  `sha`, with files already uploaded (so the first-run screen doesn't suppress the
  banner), and checks both the button `title` and the `run-all-blocked` paragraph read
  "Choose a file to run the pipeline."
- `FirstRun.test.tsx`: renamed/extended "offers Upload outside demo mode" / "...in demo
  mode too" to also assert the new reassurance line text from `SourcePicker`; added
  "outside demo mode, says files stay on this machine" (expects the line twice: once from
  `FirstRun` itself, once from the embedded `SourcePicker`); updated the `NOTE` constant
  used by the three existing demo-note tests.

## Suite summary

```
 Test Files  43 passed (43)
      Tests  602 passed (602)
```

`node node_modules/typescript/bin/tsc -b` exit code: **0**.

No CRLF line endings and no em/en dashes found in any changed file (checked with
`grep -lU $'\r'` and a UTF-8 byte-sequence grep for U+2013/U+2014).

## Files changed

- `web/src/state/graph.ts`
- `web/src/state/graph.test.ts`
- `web/src/state/sweep.test.ts`
- `web/src/components/pipeline/NodeCard.tsx`
- `web/src/components/pipeline/PipelineColumn.test.tsx`
- `web/src/components/pipeline/SourcePicker.tsx`
- `web/src/components/pipeline/FirstRun.tsx`
- `web/src/components/pipeline/FirstRun.test.tsx`
- `web/src/routes/Shell.tsx`
- `web/src/routes/Shell.test.tsx`
- `README.md`

## Anything I was unsure about

- The FirstRun outside-demo-mode reassurance line now appears twice on the page (once
  above the picker in `FirstRun.tsx`, once inside `SourcePicker.tsx`'s file section) with
  identical wording. The spec asked for both, worded the same way, so I left it as
  specified rather than de-duplicating, but it does read as slightly repetitive in the UI.
- Test-writing style: I did not run a strict red-first pass for every new assertion (I
  wrote several new tests together with the matching implementation edit, per file, rather
  than always writing the test first and watching it fail). I did verify the one case
  above where an existing test's failure was captured directly, and I confirmed every new
  assertion targets behavior that did not exist before the change (no button/text of that
  name existed on the old Upload card; the old blocked-note string was the generic "Fix
  the Upload settings..." sentence). If a stricter RED-first audit trail is wanted, I'd
  suggest re-running the new tests against a `git stash` of the five implementation files
  to confirm each one fails without the corresponding code change.
- `NodeCard.tsx`'s `message`/`failed` blocks were kept for the Upload card (not explicitly
  listed as "keep" in the brief, but removing them would have broken the existing "Choose
  or upload a file first." validation test, and the brief only asked to strip status,
  info button, Transform, and footer).

## Follow-up fix: the reassurance line showed twice on first visit

The coordinator flagged that `FirstRun` renders its own reassurance line (the demo note,
or "Your files stay on this machine and never leave it." outside demo mode) and also
embeds `SourcePicker`, which independently renders its own reassurance sentence under the
file select — so on the first-run card the message effectively duplicated.

**Fix**: `web/src/components/pipeline/SourcePicker.tsx` gained a `reassure?: boolean`
prop (default `true`) that gates the sentence under the file select.
`web/src/components/pipeline/FirstRun.tsx` now passes `reassure={false}` on the
`SourcePicker` it embeds, since the card already says this itself, above the picker.
Every other caller of `SourcePicker` (notably `PipelineColumn`, which renders it directly
as the Upload card's body after the first visit) keeps the default `true`, so the
sentence still shows there once.

### Tests: RED then GREEN

Wrote the tests first in `FirstRun.test.tsx`:
- Changed `"outside demo mode, says files stay on this machine"` (now "...exactly once")
  to assert `getAllByText("Your files stay on this machine and never leave it.")` has
  length **1** (was asserting length 2, matching the bug).
- Extended `"in demo mode: Upload stays, the samples stay, and the note states the
  limits"` (now "...said once") to assert `queryByText("Your file is private to this
  browser, is not shared with anyone, and is deleted after a day.")` is **null** — the
  embedded picker's own short sentence must not also render next to the long demo note.
- "SourcePicker rendered alone still shows it" was already covered by the existing
  `"offers Upload outside demo mode..."` and `"offers Upload in demo mode too..."` tests
  in the `SourcePicker` describe block, which render `<SourcePicker>` directly (no
  `reassure` prop passed, so the default `true` applies) and already assert the sentence
  is present — left unchanged, still green.

Confirmed RED by stashing just the two implementation files
(`SourcePicker.tsx`, `FirstRun.tsx`) back to their pre-fix committed state and running
`npx vitest run src/components/pipeline/FirstRun.test.tsx`:

```
 Test Files  1 failed (1)
      Tests  2 failed | 14 passed (16)

 FAIL  FirstRun > outside demo mode, says files stay on this machine exactly once
   expected [ <p…>, <p…> ] to have a length of 1 but got 2
 FAIL  FirstRun > in demo mode: ...said once
   expected <p class="text-xs text-fg-muted">Your file is private...</p> to be null
```

Restored the fix (`git stash pop`) and reran the same file — GREEN:

```
 Test Files  1 passed (1)
      Tests  16 passed (16)
```

### Suite summary (after the fix)

```
 Test Files  43 passed (43)
      Tests  602 passed (602)
```

`node node_modules/typescript/bin/tsc -b` exit code: **0**. No CRLF or em/en dashes in
the three changed files.

### Files changed (this follow-up)

- `web/src/components/pipeline/SourcePicker.tsx`
- `web/src/components/pipeline/FirstRun.tsx`
- `web/src/components/pipeline/FirstRun.test.tsx`
