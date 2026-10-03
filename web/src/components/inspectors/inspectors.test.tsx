import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { compile } from "tailwindcss"
import { afterEach, describe, expect, it } from "vitest"

import recursiveJson from "@/api/fixtures/chunk_set.recursive_character.json"
import markdownJson from "@/api/fixtures/chunk_set.markdown_header.json"
import parsedJson from "@/api/fixtures/parsed_doc.json"
import cleanedJson from "@/api/fixtures/parsed_doc_cleaned.json"
import indexJson from "@/api/fixtures/index.lancedb.json"
import denseJson from "@/api/fixtures/retrieval_result.dense.json"
import hybridJson from "@/api/fixtures/retrieval_result.hybrid_rrf.json"
import mmrJson from "@/api/fixtures/retrieval_result.mmr.json"
import searchJson from "@/api/fixtures/output.search.json"
import type { Chunk, ChunkSet, CleanReportEntry, ParsedDoc, RetrievalResult } from "@/api/types"

import css from "./inspectors.css?raw"
import { IndexInspector } from "./IndexInspector"
import { rowsFromResult } from "./hits"
import { RetrievalResultInspector, RetrievalView } from "./RetrievalResultInspector"

import { ChunkSetInspector } from "./ChunkSetInspector"
import { CleanReportInspector } from "./CleanReportInspector"
import { ParsedDocInspector } from "./ParsedDocInspector"
import { ArtifactInspector, inspectorFor, JsonTreeInspector } from "./registry"

const recursive = recursiveJson as unknown as ChunkSet
const markdown = markdownJson as unknown as ChunkSet
const parsed = parsedJson as unknown as ParsedDoc
const cleaned = cleanedJson as unknown as ParsedDoc
const report = cleaned.parser_meta.clean_report as CleanReportEntry[]
const dense = denseJson as unknown as RetrievalResult
const hybrid = hybridJson as unknown as RetrievalResult
const mmr = mmrJson as unknown as RetrievalResult

afterEach(cleanup)

function makeChunk(i: number, start: number, end: number, extra: Partial<Chunk> = {}): Chunk {
  return {
    id: `chunk${i}`,
    text: "",
    embed_text: null,
    start_char: start,
    end_char: end,
    token_count: end - start,
    kind: "chunk",
    parent_id: null,
    level: 0,
    ordinal: i,
    doc_id: "d",
    heading_path: [],
    source_element_ids: [],
    page_span: null,
    metadata: {},
    ...extra,
  }
}

/** Ten back-to-back chunks of 4 characters each over a 40-character source. */
function tenChunks(): ChunkSet {
  const source_text = "abcdefghijklmnopqrstuvwxyz0123456789ABCD"
  const chunks = Array.from({ length: 10 }, (_, i) => {
    const ch = makeChunk(i, i * 4, i * 4 + 4)
    return { ...ch, text: source_text.slice(ch.start_char, ch.end_char) }
  })
  return { chunks, source_text, doc_id: "d", chunker_meta: {} }
}

const segs = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>("[data-seg]")]

describe("ChunkSetInspector", () => {
  it("renders the source exactly once, one span per segment", () => {
    const { container } = render(<ChunkSetInspector chunkSet={recursive} />)
    const reading = container.querySelector<HTMLElement>("[data-reading]")!
    expect(segs(reading).map((s) => (s.textContent ?? "").replace(/↵/g, "")).join("")).toBe(recursive.source_text)
  })

  it("marks the 3 overlaps of the recursive fixture, and a spine band per chunk", () => {
    const { container } = render(<ChunkSetInspector chunkSet={recursive} />)
    expect(container.querySelectorAll("[data-seg][data-overlap]")).toHaveLength(3)
    expect(container.querySelectorAll("[data-band]")).toHaveLength(6)
    expect(container.querySelectorAll("[data-bar]")).toHaveLength(6)
    expect(screen.getByTestId("summary-overlaps").textContent).toBe("3")
  })

  it("fills a blank line inside a chunk, and only inside a chunk, without adding text", () => {
    const set: ChunkSet = {
      source_text: "Heading\n\nBody text.\n\nNext",
      chunks: [{ ...makeChunk(0, 0, 19), text: "Heading\n\nBody text." }],
      doc_id: "d",
      chunker_meta: {},
    }
    const { container } = render(<ChunkSetInspector chunkSet={set} />)
    const [covered, gap] = segs(container)
    // One blank line inside the chunk: one fill for it.
    expect(covered.querySelectorAll("[data-blank-fill]")).toHaveLength(1)
    // The uncovered separator keeps its return glyphs and gets no fill.
    expect(gap.querySelectorAll("[data-blank-fill]")).toHaveLength(0)
    // The fill carries no characters: the text is still exactly the source.
    expect(covered.textContent).toBe("Heading\n\nBody text.")
  })

  it("marks one range of the source, across the chunk boundary that cuts it", () => {
    const source = "Heading\n\nA boundary falls here. Next paragraph."
    const at = source.indexOf("A boundary")
    const set: ChunkSet = {
      source_text: source,
      chunks: [
        { ...makeChunk(0, 0, at + 12), text: source.slice(0, at + 12) },
        { ...makeChunk(1, at + 12, source.length), text: source.slice(at + 12) },
      ],
      doc_id: "d",
      chunker_meta: {},
    }
    const { container } = render(<ChunkSetInspector chunkSet={set} mark={[at, at + "A boundary falls here.".length]} />)
    const marked = [...container.querySelectorAll("[data-answer]")]
    expect(marked.map((m) => m.textContent).join("")).toBe("A boundary falls here.")
    // The cut runs through it, so it is marked in both chunks.
    expect(marked).toHaveLength(2)
  })

  it("cycles chunk colours past the eighth chunk", () => {
    const { container } = render(<ChunkSetInspector chunkSet={tenChunks()} />)
    const slots = segs(container).map((s) => s.dataset.slot)
    expect(slots).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "1", "2"])
    expect(segs(container)[8].style.getPropertyValue("--a")).toBe("var(--chunk-1)")
  })

  it("renders uncovered text as a gap", () => {
    const { container } = render(<ChunkSetInspector chunkSet={markdown} />)
    const gaps = container.querySelectorAll("[data-seg][data-gap]")
    expect(gaps).toHaveLength(4)
    expect(screen.getByTestId("summary-uncovered").textContent).toBe("8")
  })

  it("selects a chunk from the spine and shows its metadata", () => {
    render(<ChunkSetInspector chunkSet={recursive} />)
    expect(screen.getByText(/Select a chunk/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /Chunk 2,/ }))
    const detail = screen.getByTestId("chunk-detail")
    expect(within(detail).getByText(recursive.chunks[1].id)).toBeTruthy()
    expect(within(detail).queryByText("embed_text")).toBeNull() // embed_text is null
  })

  it("shows embed_text only when it differs from text", () => {
    const set = tenChunks()
    set.chunks[0] = { ...set.chunks[0], embed_text: "Title: abcd" }
    set.chunks[1] = { ...set.chunks[1], embed_text: set.chunks[1].text }
    const { rerender } = render(<ChunkSetInspector chunkSet={set} initialSelected={0} />)
    expect(screen.getByText("Title: abcd")).toBeTruthy()
    rerender(<ChunkSetInspector key="b" chunkSet={set} initialSelected={1} />)
    expect(screen.queryByText("embed_text")).toBeNull()
  })

  it("hovers through a data attribute on the container, not React state", () => {
    const { container } = render(<ChunkSetInspector chunkSet={recursive} />)
    const root = container.querySelector<HTMLElement>("[data-chunk-inspector]")!
    const overlap = container.querySelector<HTMLElement>("[data-seg][data-overlap]")!
    fireEvent.pointerOver(overlap)
    expect(root.dataset.hover).toBe("c2 c3")
    fireEvent.pointerLeave(root)
    expect(root.dataset.hover).toBeUndefined()
  })

  it("has an empty state for a zero-chunk set with no text", () => {
    render(<ChunkSetInspector chunkSet={{ chunks: [], source_text: "", doc_id: "d", chunker_meta: {} }} />)
    expect(screen.getByText("No chunks")).toBeTruthy()
    expect(screen.getByTestId("summary-chunks").textContent).toBe("0")
  })

  it("shows the whole text as uncovered when the chunker produced nothing", () => {
    const { container } = render(
      <ChunkSetInspector chunkSet={{ ...recursive, chunks: [] }} />,
    )
    expect(screen.getByText("No chunks")).toBeTruthy()
    expect(container.querySelectorAll("[data-seg][data-gap]")).toHaveLength(1)
  })

  it("has loading, error and not-run states", () => {
    const { rerender } = render(<ChunkSetInspector status={{ kind: "loading" }} />)
    expect(screen.getByRole("status").textContent).toMatch(/Loading chunk set/)
    rerender(<ChunkSetInspector status={{ kind: "error", message: "chunk_size must be > overlap" }} />)
    expect(screen.getByRole("alert").textContent).toMatch(/chunk_size must be > overlap/)
    rerender(<ChunkSetInspector />)
    expect(screen.getByText("No chunk set yet")).toBeTruthy()
  })
})

describe("ParsedDocInspector", () => {
  it("renders every element as a block, then as a table ordered by order", () => {
    const { container } = render(<ParsedDocInspector doc={parsed} />)
    expect(container.querySelectorAll("[data-element]")).toHaveLength(20)
    fireEvent.click(screen.getByRole("radio", { name: "Table" }))
    const rows = container.querySelectorAll("[data-row]")
    expect(rows).toHaveLength(20)
    expect(rows[14].querySelector("[data-col=order]")!.textContent).toBe("14")
  })

  it("has an empty state for a document with no elements", () => {
    render(<ParsedDocInspector doc={{ ...parsed, elements: [] }} />)
    expect(screen.getByText("No elements")).toBeTruthy()
  })
})

describe("CleanReportInspector", () => {
  it("matches removals to the pre-clean document by element id", () => {
    const { container } = render(<CleanReportInspector before={parsed} report={report} />)
    const removed = [...container.querySelectorAll<HTMLElement>("[data-element][data-removed]")].map((e) => e.dataset.element)
    expect(removed.sort()).toEqual(["e00000", "e00006", "e00007", "e00012", "e00013", "e00016", "e00019"])
    expect(container.querySelectorAll("[data-element]")).toHaveLength(20)
    // One spine tick per removed element.
    expect(container.querySelectorAll("[data-tick]")).toHaveLength(7)
  })

  it("lists removals in application order, with duplicate_of for dedupe", () => {
    const { container } = render(<CleanReportInspector before={parsed} report={report} />)
    const groups = [...container.querySelectorAll<HTMLElement>("[data-cleaner]")].map((g) => g.dataset.cleaner)
    expect(groups).toEqual(["header_footer_strip", "dedupe_blocks"])
    const rows = [...container.querySelectorAll<HTMLElement>("[data-removal]")].map((r) => r.dataset.removal)
    expect(rows).toEqual(["e00000", "e00006", "e00007", "e00012", "e00013", "e00019", "e00016"])
    const dup = container.querySelector<HTMLElement>('[data-removal="e00016"] [data-col=duplicate_of]')!
    expect(dup.textContent).toBe("e00003")
  })

  it("flags a removal whose id is not in the document", () => {
    const stray: CleanReportEntry[] = [
      { ...report[0], removed: [{ ...report[0].removed[0], id: "nope" }], removed_count: 1 },
    ]
    render(<CleanReportInspector before={parsed} report={stray} />)
    expect(screen.getByText("not in document")).toBeTruthy()
  })

  it("has an empty state when nothing was removed", () => {
    render(<CleanReportInspector before={parsed} report={[]} />)
    expect(screen.getByText("Nothing removed")).toBeTruthy()
  })
})

describe("inspector registry", () => {
  it("maps artifact types to inspectors and falls back to a JSON tree", () => {
    expect(inspectorFor("unknown_type")).toBe(JsonTreeInspector)
    expect(inspectorFor("qa_set")).toBe(JsonTreeInspector)
    for (const t of ["chunk_set", "index", "retrieval_result", "output"]) expect(inspectorFor(t)).not.toBe(JsonTreeInspector)
  })

  it("renders an unknown type as a JSON tree", () => {
    render(<ArtifactInspector type="mystery" data={{ answer: 42, nested: { list: ["a", "b"] } }} />)
    expect(screen.getByText("answer")).toBeTruthy()
    expect(screen.getByText("42")).toBeTruthy()
    expect(screen.getByText('"a"')).toBeTruthy()
  })

  it("routes a parsed_doc with a pre-clean document to the clean report", () => {
    const { container } = render(<ArtifactInspector type="parsed_doc" data={cleaned} context={{ before: parsed }} />)
    expect(container.querySelectorAll("[data-tick]")).toHaveLength(7)
  })

  it("renders a chunk_set through the registry", () => {
    const { container } = render(<ArtifactInspector type="chunk_set" data={recursive} />)
    expect(container.querySelectorAll("[data-band]")).toHaveLength(6)
  })

  it("gives the fallback its own empty and error states", () => {
    const { rerender } = render(<ArtifactInspector type="mystery" data={undefined} />)
    expect(screen.getByText("No data")).toBeTruthy()
    rerender(<ArtifactInspector type="mystery" status={{ kind: "error", message: "boom" }} />)
    expect(screen.getByRole("alert").textContent).toMatch(/boom/)
  })
})

describe("ChunkSetInspector layout follows its own width", () => {
  it("uses a container query, not a viewport breakpoint, for the detail column", () => {
    const { container } = render(<ChunkSetInspector chunkSet={recursive} />)
    const layout = container.querySelector<HTMLElement>("[data-chunk-inspector]")!
    expect(layout.className).not.toMatch(/\b(sm|md|lg|xl):/)
    expect(layout.classList.contains("ci-layout")).toBe(true)
    expect(layout.parentElement!.classList.contains("ci-frame")).toBe(true)
    expect(layout.dataset.detail).toBe("")
    // The container, the hidden-by-default detail, and the width that shows it.
    expect(css).toMatch(/\.ci-frame\s*{\s*container-type:\s*inline-size/)
    expect(css).toMatch(/\.ci-layout > \[data-testid="chunk-detail"\]\s*{\s*display:\s*none/)
    expect(css).toMatch(/@container \(min-width: 900px\)\s*{[^@]*\.ci-layout\[data-detail\][^@]*display:\s*flex/)
  })

  it("showDetail passes through the registry", () => {
    const { container, rerender } = render(<ArtifactInspector type="chunk_set" data={recursive} />)
    expect(screen.getByTestId("chunk-detail")).toBeTruthy()
    rerender(<ArtifactInspector type="chunk_set" data={recursive} showDetail={false} />)
    expect(screen.queryByTestId("chunk-detail")).toBeNull()
    expect(container.querySelector<HTMLElement>("[data-chunk-inspector]")!.dataset.detail).toBeUndefined()
  })
})

describe("RetrievalResultInspector", () => {
  it("lists hits in rank order with the original chunk text and the score in mono", () => {
    const { container } = render(<RetrievalResultInspector result={hybrid} />)
    const rows = [...container.querySelectorAll<HTMLElement>("[data-hit-row]")]
    expect(rows.map((r) => r.dataset.hitRow)).toEqual(["1", "2", "3", "4", "5", "6"])
    expect(rows[0].textContent).toContain(hybrid.hits[0].chunk.text.slice(0, 40))
    expect(rows[0].textContent).toContain("0.03279")
    expect(screen.getByTestId("fact-hits").textContent).toBe("6")
  })

  it("draws a bar per component on its own scale: the largest of each is full length", () => {
    const { container } = render(<RetrievalResultInspector result={hybrid} />)
    const widths = [...container.querySelectorAll<HTMLElement>("[data-hit-row]")].map((r) =>
      [...r.querySelectorAll<HTMLElement>("[data-bar]")].map((b) => Number(b.dataset.bar)),
    )
    // Rank 1 has the top dense and the top bm25 score.
    expect(widths[0]).toEqual([40, 40])
    // The sixth was found by the dense search only, so it has no bm25 bar.
    expect(widths.map((w) => w.length)).toEqual([2, 2, 2, 2, 2, 1])
    expect(Math.max(...widths.slice(1, 5).map((w) => w[1]))).toBeLessThan(8)
  })

  it("a retriever with no components gets one bar on the score itself", () => {
    const { container } = render(<RetrievalResultInspector result={dense} />)
    const first = container.querySelector<HTMLElement>("[data-hit-row]")!
    expect([...first.querySelectorAll<HTMLElement>("[data-bar]")].map((b) => Number(b.dataset.bar))).toEqual([40])
  })

  it("shows rank movement after rerank as plain text", () => {
    const { container } = render(<RetrievalResultInspector result={mmr} />)
    const moves = [...container.querySelectorAll<HTMLElement>("[data-testid=movement]")].map((m) => m.textContent)
    expect(moves).toEqual(["", "was 5", "was 2", "was 3", "was 6"])
    // The count lives in the run note, once: no header chip repeats it.
    expect(screen.queryByTestId("fact-moved")).toBeNull()
    // A hit that rose is set in weight, not in a colour: 500, the heaviest mono weight loaded.
    const rose = container.querySelectorAll<HTMLElement>("[data-testid=movement]")[1]
    expect(rose.className).toContain("font-medium")
  })

  it("keeps the piece hash in the row's tooltip, not inline", () => {
    const { container } = render(<RetrievalResultInspector result={hybrid} />)
    const first = container.querySelector<HTMLElement>("[data-hit-row]")!
    const id = hybrid.hits[0].chunk.id
    expect(first.getAttribute("title")).toBe(`Piece ${id.slice(0, 8)}`)
    expect(first.textContent).not.toContain(id.slice(0, 8))
  })

  it("says which search missed a hit: no keyword match for BM25, no meaning match for dense", () => {
    const { container, rerender } = render(<RetrievalResultInspector result={hybrid} />)
    const sixth = container.querySelector<HTMLElement>('[data-hit-row="6"]')!
    expect(sixth.textContent).toContain("no keyword match")
    expect(container.textContent).not.toContain("not in list")
    const noDense = { ...hybrid, hits: hybrid.hits.map((h) => ({ ...h, component_scores: { bm25: 1, ...(h.rank === 1 ? {} : { dense: 0.5 }) } })) }
    rerender(<RetrievalResultInspector result={noDense} />)
    expect(container.querySelector<HTMLElement>('[data-hit-row="1"]')!.textContent).toContain("no meaning match")
  })

  it("fits a narrow list: each score names its scale, a miss stays on one line, and the stylesheet wraps the row", () => {
    const { container } = render(<RetrievalResultInspector result={hybrid} />)
    const sixth = container.querySelector<HTMLElement>('[data-hit-row="6"]')!
    expect([...sixth.querySelectorAll(".ri-score-name")].map((k) => k.textContent)).toEqual(["RRF", "Dense", "BM25"])
    const miss = [...sixth.querySelectorAll("span")].find((el) => el.textContent === "no keyword match")!
    expect(miss.className).toContain("whitespace-nowrap")
    expect(container.querySelector(".ri-head")).toBeTruthy()
    // Below 600px of list (a phone, or one column of the side-by-side comparison) the scores become
    // a wrapping line under the passage and the header hides, so the passage keeps a reading measure.
    expect(css).not.toContain("max-width: 439px")
    expect(css).toMatch(/@container \(max-width: 599px\)[\s\S]*\.ri-head \{\s*display: none;[\s\S]*\.ri-scores \{[^}]*display: flex;\s*flex-wrap: wrap;/)
  })

  it("names every score's scale beside its number, in mono: RRF, Dense, BM25", () => {
    const { container } = render(<RetrievalResultInspector result={hybrid} />)
    const first = container.querySelector<HTMLElement>('[data-hit-row="1"] .ri-scores')!
    expect(first.className).toContain("font-mono")
    const lines = [...first.querySelectorAll<HTMLElement>(".ri-score")].map((l) => l.textContent)
    expect(lines).toEqual([`RRF${"0.03279"}`, expect.stringMatching(/^Dense0\.\d{3,4}$/), expect.stringMatching(/^BM25\d\.\d{3}$/)])
    // The name and the value share one size, so their baselines meet.
    const line = first.querySelector<HTMLElement>(".ri-score")!
    expect([...line.children].slice(0, 2).map((c) => c.className.match(/\btext-(2xs|xs|sm)\b/)?.[0])).toEqual(["text-xs", "text-xs"])
    // A reranker that rescored names its own scale.
    cleanup()
    const rescored = { ...mmr, hits: mmr.hits.map((h, i) => ({ ...h, prior_score: h.score, score: 8.21 - i })) }
    const { container: c2 } = render(<RetrievalResultInspector result={rescored} />)
    expect(c2.querySelector('[data-hit-row="1"] .ri-score')!.textContent).toBe("Cross-encoder8.210")
  })

  it("sets the rank large and the passage in the reading face", () => {
    const { container } = render(<RetrievalResultInspector result={hybrid} />)
    const first = container.querySelector<HTMLElement>('[data-hit-row="1"]')!
    const rank = first.querySelector<HTMLElement>("[data-testid=rank]")!
    expect(rank.textContent).toBe("1")
    expect(rank.className).toMatch(/\btext-lg\b/)
    expect(rank.className).toContain("font-semibold")
    const passage = first.querySelector<HTMLElement>(".ri-snippet")!
    expect(passage.className).toContain("font-sans")
    expect(passage.className).toMatch(/\btext-base\b/)
    // Sentence case column headers.
    expect([...container.querySelectorAll(".ri-head .meta")].map((h) => h.textContent)).toEqual(["Rank", "Score"])
  })

  it("shows Show in PDF as a quiet text button on the where line", () => {
    const { container } = render(<RetrievalResultInspector result={hybrid} doc={parsed} />)
    const buttons = screen.getAllByRole("button", { name: "Show in PDF" })
    expect(buttons.length).toBe(hybrid.hits.length)
    const first = container.querySelector<HTMLElement>('[data-hit-row="1"]')!
    const button = within(first).getByRole("button", { name: "Show in PDF" })
    const where = first.querySelector<HTMLElement>("[data-testid=where]")!
    expect(where.contains(button)).toBe(true)
    // One size for the whole line; the button in the accent text tint, no underline at rest, no border, no fill.
    expect(where.className).toMatch(/\btext-xs\b/)
    expect(button.className).not.toMatch(/\btext-(2xs|xs|sm)\b/)
    expect(button.className).toContain("text-primary")
    expect(button.className).not.toMatch(/(^|\s)underline(\s|$)/)
    expect(button.className).not.toMatch(/\bborder\b/)
    expect(button.className).not.toContain("bg-surface")
  })

  it("marks only the rows that fell out of the keep list, Not kept, with no rule and no kept tag", () => {
    const rows = rowsFromResult(hybrid)
    const kept = new Set(rows.slice(0, 4).map((r) => r.chunk_id))
    const { container } = render(<RetrievalView rows={rows} kept={kept} facts={null} showDetail={false} />)
    const row = (rank: number) => container.querySelector<HTMLElement>(`[data-hit-row="${rank}"]`)!
    for (const rank of [1, 2, 3, 4]) {
      expect(row(rank).textContent).not.toMatch(/kept/i)
    }
    for (const rank of [5, 6]) {
      expect(within(row(rank)).getByText("Not kept")).toBeTruthy()
    }
    expect(container.querySelector("[data-kept]")).toBeNull()
    expect(css).not.toContain("[data-kept]")
    cleanup()
    // Without a keep list nothing is marked.
    const { container: c2 } = render(<RetrievalView rows={rows} facts={null} showDetail={false} />)
    expect(c2.textContent).not.toContain("Not kept")
  })

  it("new rows fade in and rise, staggered over the first five, and only when asked", () => {
    const rows = rowsFromResult(hybrid)
    const { container } = render(<RetrievalView rows={rows} facts={null} showDetail={false} enter />)
    const all = [...container.querySelectorAll<HTMLElement>("[data-hit-row]")]
    expect(all.every((r) => r.hasAttribute("data-enter"))).toBe(true)
    expect(all.map((r) => r.style.getPropertyValue("--i"))).toEqual(["0", "1", "2", "3", "4", "4"])
    expect(all.map((r) => r.dataset.flipKey)).toEqual(rows.map((r) => r.chunk_id))
    cleanup()
    const { container: c2 } = render(<RetrievalView rows={rows} facts={null} showDetail={false} />)
    expect(c2.querySelector("[data-enter]")).toBeNull()
  })

  it("the enter motion is in the stylesheet: rise 6px over --dur-mid, 30 ms apart, and an opacity change only under reduced motion", () => {
    const rule = /\.ri-row\[data-enter\] \{([^}]*)\}/.exec(css)![1]
    expect(rule).toMatch(/animation:\s*ri-enter var\(--dur-mid\) var\(--ease-in\) backwards/)
    expect(rule).toMatch(/animation-delay:\s*calc\(var\(--i, 0\) \* 30ms\)/)
    expect(css).toMatch(/@keyframes ri-enter \{\s*from \{\s*opacity: 0;\s*transform: translateY\(6px\);\s*\}/)
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{\s*\.ri-row\[data-enter\] \{([^}]*)\}/.exec(css)![1]
    expect(reduced).toMatch(/animation:\s*ri-fade var\(--dur-fast\)/)
    expect(reduced).toMatch(/animation-delay:\s*0ms/)
    expect(/@keyframes ri-fade \{([^}]*\})/.exec(css)![1]).not.toContain("transform")
  })

  it("the enter motion and its reduced-motion override survive compilation", async () => {
    const compiled = (await compile(css)).build([])
    expect(compiled).toMatch(/\.ri-row\[data-enter\] \{\s*animation: ri-enter var\(--dur-mid\) var\(--ease-in\) backwards;/)
    expect(compiled).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.ri-row\[data-enter\] \{\s*animation: ri-fade var\(--dur-fast\) linear backwards;/)
  })

  it("the rank bands sit a full hit box apart on a touch screen", () => {
    expect(css).toMatch(/\.ri \{[^}]*--lane: 6px;/)
    expect(css).toMatch(/@media \(pointer: coarse\) \{\s*\.ri \{\s*--lane: 24px;/)
  })

  it("shows the section in a hit's where line only when its chunk has one", () => {
    const withSection = {
      ...hybrid,
      hits: hybrid.hits.map((h) => (h.rank === 1 ? { ...h, chunk: { ...h.chunk, heading_path: ["Methods", "Survey"] } } : h)),
    }
    const { container } = render(<RetrievalResultInspector result={withSection} />)
    const where = (rank: number) => container.querySelector<HTMLElement>(`[data-hit-row="${rank}"] [data-testid=where]`)!.textContent
    expect(where(1)).toContain("Methods > Survey")
    expect(where(2)).toBe("pp. 2-3")
  })

  it("with the upstream chunk set, puts a rank tick for every hit on the spine", () => {
    const { container } = render(<ArtifactInspector type="retrieval_result" data={mmr} context={{ chunks: recursive }} />)
    const ticks = [...container.querySelectorAll<HTMLElement>("[data-tick]")]
    expect(ticks.map((t) => t.textContent)).toEqual(["1", "2", "3", "4", "5"])
    // Each tick is measured against the segment that starts at its chunk.
    const reading = container.querySelector<HTMLElement>("[data-reading]")!
    for (const [i, t] of ticks.entries()) {
      const seg = reading.querySelector<HTMLElement>(`[data-target="${t.dataset.first}"]`)!
      expect(mmr.hits[i].chunk.text.startsWith(seg.textContent!)).toBe(true)
    }
    // The document is drawn once, whole.
    expect(reading.textContent).toBe(recursive.source_text)
  })

  it("without the chunk set, or with showDetail off, there is no document", () => {
    const { container, rerender } = render(<RetrievalResultInspector result={mmr} />)
    expect(container.querySelector("[data-reading]")).toBeNull()
    rerender(<RetrievalResultInspector result={mmr} chunkSet={recursive} showDetail={false} />)
    expect(container.querySelector("[data-reading]")).toBeNull()
  })

  it("has empty, loading, error and not-run states", () => {
    const { rerender } = render(<RetrievalResultInspector result={{ ...mmr, hits: [] }} />)
    expect(screen.getByText("No hits")).toBeTruthy()
    rerender(<RetrievalResultInspector status={{ kind: "loading" }} />)
    expect(screen.getByRole("status").textContent).toMatch(/Loading retrieval result/)
    rerender(<RetrievalResultInspector status={{ kind: "error", message: "gone" }} />)
    expect(screen.getByRole("alert").textContent).toMatch(/gone/)
    rerender(<RetrievalResultInspector />)
    expect(screen.getByText("No retrieval result yet")).toBeTruthy()
  })

  it("renders a Search output with the same rows", () => {
    const { container } = render(<ArtifactInspector type="output" data={searchJson} context={{ chunks: recursive }} />)
    expect([...container.querySelectorAll<HTMLElement>("[data-testid=movement]")].map((m) => m.textContent)[1]).toBe("was 5")
    expect(container.querySelectorAll("[data-tick]")).toHaveLength(5)
    cleanup()
    // Any other use case output falls back to the JSON tree.
    render(<ArtifactInspector type="output" data={{ kind: "chat", payload: { answer: "hi" } }} />)
    expect(screen.getByText("answer")).toBeTruthy()
  })
})

describe("IndexInspector", () => {
  it("shows the descriptor as a table, tolerating the embedding counts being absent", () => {
    // A descriptor from before plan I-3 added the embedding counts.
    const { embeddings_computed: _c, embeddings_cached: _k, ...older } = indexJson
    render(<IndexInspector descriptor={older} />)
    const table = screen.getByTestId("index-descriptor")
    expect(table.textContent).toContain("fake-deterministic")
    expect(table.textContent).toContain("dense, fts")
    expect(table.textContent).toMatch(/embedded\s*not reported/)
  })

  it("shows embeddings computed and cached, and a truncated dim, when present", () => {
    expect(indexJson.embeddings_computed).toBe(indexJson.doc_count)
    render(<IndexInspector descriptor={{ ...indexJson, dim: 128, embeddings_computed: 0, embeddings_cached: 6 }} />)
    expect(screen.getByText("0 embedded, 6 from cache")).toBeTruthy()
    expect(screen.getByText("128, truncated from 384")).toBeTruthy()
  })

  it("has empty and loading states", () => {
    const { rerender } = render(<IndexInspector />)
    expect(screen.getByText("No index yet")).toBeTruthy()
    rerender(<IndexInspector status={{ kind: "loading" }} />)
    expect(screen.getByRole("status")).toBeTruthy()
  })
})

describe("long text in the reading face", () => {
  const reads = (el: HTMLElement) => {
    expect(el.className).toContain("font-sans")
    expect(el.className).toMatch(/\btext-base\b/)
    expect(el.className).not.toContain("font-mono")
    expect(el.className).not.toContain("leading-[1.65]")
  }

  it("the chunk text, the hit document and the parsed blocks are Atkinson at the reading size", () => {
    const { container, unmount } = render(<ChunkSetInspector chunkSet={recursive} />)
    reads(container.querySelector<HTMLElement>("[data-reading]")!)
    unmount()
    const hits = render(<RetrievalResultInspector result={mmr} chunkSet={recursive} />)
    reads(hits.container.querySelector<HTMLElement>("[data-reading]")!)
    hits.unmount()
    const doc = render(<ParsedDocInspector doc={parsed} />)
    reads(doc.container.querySelector<HTMLElement>("[data-element] p")!)
  })

  it("the painted chunk band is measured for the reading face: line height 1.6, content area 1.3em", () => {
    expect(css).toMatch(/--ci-leading: calc\(\(1\.6em - 1\.3em\) \/ 2 \+ 0\.5px\)/)
    expect(css).not.toMatch(/Martian/)
    expect(css).not.toMatch(/font-size:\s*\d+px/)
  })
})
