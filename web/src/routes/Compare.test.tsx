import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import markdownJson from "@/api/fixtures/chunk_set.markdown_header.json"
import recursiveJson from "@/api/fixtures/chunk_set.recursive_character.json"
import tokenJson from "@/api/fixtures/chunk_set.token_based.json"
import indexJson from "@/api/fixtures/index.lancedb.json"
import liveRegistry from "@/api/fixtures/registry.json"
import bm25Json from "@/api/fixtures/retrieval_result.bm25.json"
import denseJson from "@/api/fixtures/retrieval_result.dense.json"
import hybridJson from "@/api/fixtures/retrieval_result.hybrid_rrf.json"
import type { Registry } from "@/api/types"
import { chooseDocument, resetDocumentForTests } from "@/state/document"
import { requestOpenExperiment, resetExperimentsForTests, saveExperiment } from "@/state/experiments"
import { resetStoredGraphForTests, sampleGraph, setConfig, storeGraph, terminalNode, transformsFor } from "@/state/graph"

import { Compare, seedVariants, VariantResult } from "./Compare"
import { FakeResizeObserver } from "./fakeResizeObserver"

const registry = liveRegistry as unknown as Registry
const GRAPH_KEY = "rag-playground:graph:v1"
const SOURCE = { sha: "cd".repeat(32), filename: "chunking-primer.pdf" }

class SilentEventSource {
  onmessage = null
  onerror = null
  onopen = null
  close() {}
}

/** Artifact payloads by id, served at `/api/artifacts/{id}/payload`; `extra` answers other URLs (a Response as it is). */
function serve(artifacts: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
  const missing = () => new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/registry") return ok(liveRegistry)
      if (url in extra) return extra[url] instanceof Response ? extra[url] : ok(extra[url])
      if (url === "/api/sweeps") return ok({ run_id: "r1" })
      const artifact = /^\/api\/artifacts\/([^/]+)\/payload$/.exec(url)
      if (artifact) return artifact[1] in artifacts ? ok(artifacts[artifact[1]]) : missing()
      return missing()
    }),
  )
}

/** The page reads the node to compare from the query string, as Build's Sweep buttons set it. */
function openAt(query: string) {
  window.history.replaceState(null, "", `/compare${query}`)
}

const picker = () => screen.getByRole("group", { name: "Step to compare" })
const steps = () => within(picker()).getAllByRole("button").map((b) => b.textContent)
const pressed = () => within(picker()).getAllByRole("button").find((b) => b.getAttribute("aria-pressed") === "true")?.textContent
const choose = (step: string) => fireEvent.click(within(picker()).getByRole("button", { name: step }))
/** The recipes on the cards before a run, by code name; none once the results show. */
const columns = () => screen.queryAllByRole("article").map((a) => within(a).getByTestId("recipe-code").textContent)
/** The result columns after a run, by name. */
const regions = () => screen.queryAllByRole("region").map((r) => r.getAttribute("aria-label"))
const text = () => document.body.textContent ?? ""

/** An event stream the test drives. */
class DrivenEventSource {
  static instances: DrivenEventSource[] = []
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror = null
  onopen = null
  constructor() {
    DrivenEventSource.instances.push(this)
  }
  close() {}
  emit(seq: number, event: Record<string, unknown>) {
    act(() => {
      this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ ts: seq, ...event }), lastEventId: String(seq) }))
    })
  }
}

/** The stream of the run the page started. */
async function driven() {
  await waitFor(() => expect(DrivenEventSource.instances.length).toBe(1))
  return DrivenEventSource.instances[0]
}

/** The i-th result column. */
const column = (i: number) => screen.getByTestId("recipe-grid").querySelectorAll<HTMLElement>(":scope > section")[i]
/** The i-th recipe's status sentence. */
const statusOf = (i: number) => within(column(i)).getByTestId("recipe-status").textContent

/**
 * Five recipes on the cards, the two added from the Add card's first
 * suggestion, then a run in which the first `finish` recipes finish (the next
 * one is left running), served from the three fixtures.
 */
async function runFive(stage: "chunk" | "retrieve", finish = 5, before?: () => void) {
  const graph = sampleGraph(registry, SOURCE)
  const through = terminalNode(graph)!.id
  if (stage === "retrieve") {
    serve({ c: recursiveJson, i: indexJson, h0: hybridJson, h1: denseJson, h2: bm25Json, h3: hybridJson, h4: denseJson })
    openAt("?node=retrieve")
  } else serve({ a0: recursiveJson, a1: markdownJson, a2: tokenJson, a3: recursiveJson, a4: markdownJson })
  render(<Compare />)
  const add = await screen.findByRole("region", { name: "Add a recipe" })
  for (let k = 0; k < 2; k++) {
    fireEvent.click(within(add).getAllByRole("button")[0])
    fireEvent.keyDown(document.activeElement!, { key: "Escape" })
  }
  before?.()
  fireEvent.click(screen.getByRole("button", { name: "Run 5 recipes" }))
  const es = await driven()
  let seq = 1
  for (let i = 0; i < Math.min(finish + 1, 5); i++) {
    es.emit(seq++, { event: "variant_started", index: i, variant: {} })
    if (i >= finish) {
      es.emit(seq++, { event: "node_started", node_id: stage === "chunk" ? "chunk" : through, transform: "x", artifact_id: "x" })
      break
    }
    if (stage === "chunk") es.emit(seq++, { event: "node_finished", node_id: "chunk", artifact_id: `a${i}`, cache_hit: false, duration_ms: 1 })
    else {
      es.emit(seq++, { event: "node_finished", node_id: "chunk", artifact_id: "c", cache_hit: false, duration_ms: 1 })
      es.emit(seq++, { event: "node_finished", node_id: "index", artifact_id: "i", cache_hit: false, duration_ms: 1 })
      es.emit(seq++, { event: "node_finished", node_id: through, artifact_id: `h${i}`, cache_hit: false, duration_ms: 1 })
    }
  }
  if (finish >= 5) es.emit(seq, { event: "stream_end", status: "finished", ok: true })
  return es
}

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  resetStoredGraphForTests()
  resetDocumentForTests()
  resetExperimentsForTests()
  vi.stubGlobal("EventSource", SilentEventSource)
  serve()
  storeGraph(sampleGraph(registry, SOURCE))
  openAt("")
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  FakeResizeObserver.reset()
  window.history.replaceState(null, "", "/")
})

describe("the Compare stage picker", () => {
  it("offers Parse, Chunk and Retrieve as a segmented control, starts on Chunk, and seeds three columns, the current chunker first", async () => {
    render(<Compare />)
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Compare" })).toBeTruthy())
    expect(steps()).toEqual(["Parse", "Chunk", "Retrieve"])
    expect(pressed()).toBe("Chunk")
    expect(text()).toMatch(/The Chunk step over chunking-primer\.pdf/)
    expect(columns()).toEqual(["recursive_character", "recursive_character", "sentence_window"])
  })

  it("moves the comparison to Parse: the parsers, the sentence and the URL follow", async () => {
    render(<Compare />)
    await waitFor(() => expect(pressed()).toBe("Chunk"))
    choose("Parse")
    await waitFor(() => expect(pressed()).toBe("Parse"))
    expect(columns()).toEqual(["docling", "pdfium"])
    expect(text()).toMatch(/The Parse step over chunking-primer\.pdf/)
    expect(new URLSearchParams(window.location.search).get("node")).toBe("parse")
  })

  it("has no Show through dropdown for Parse or Chunk", async () => {
    render(<Compare />)
    await waitFor(() => expect(pressed()).toBe("Chunk"))
    expect(screen.queryByLabelText("Show through")).toBeNull()
    expect(screen.queryByLabelText("Show")).toBeNull()
    choose("Parse")
    await waitFor(() => expect(pressed()).toBe("Parse"))
    expect(screen.queryByLabelText("Show through")).toBeNull()
    expect(screen.queryByLabelText("Show")).toBeNull()
  })

  it("lists and selects the Index node it was opened on, and shows the Show through dropdown there", async () => {
    openAt("?node=index")
    render(<Compare />)
    await waitFor(() => expect(pressed()).toBe("Index"))
    expect(steps()).toEqual(["Parse", "Chunk", "Index", "Retrieve"])
    expect(text()).toMatch(/The Index step over chunking-primer\.pdf/)
    expect(screen.getByLabelText("Show through")).toBeTruthy()
  })

  it("sets the tally sentence in sans, with only its numbers in mono", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync(`${__dirname}/Compare.tsx`, "utf8")
    const tag = src.match(/<p data-testid="tally"[^>]*>/)?.[0] ?? ""
    expect(tag).not.toContain("font-mono")
    expect(src).toContain("<MonoNumbers text={tallyLine(")
  })

  it("sets the agreement line in sans with only its numbers in mono", async () => {
    const node = sampleGraph(registry, SOURCE).nodes.find((n) => n.stage === "retrieve")!
    render(
      <VariantResult
        pending={false}
        node={node}
        type="retrieval_result"
        status={{ kind: "ready" }}
        agreement="Same 5 pieces. The 2nd and 3rd swap places."
        embeddings={null}
      />,
    )
    const line = screen.getByTestId("agreement")
    expect(line.textContent).toBe("Same 5 pieces. The 2nd and 3rd swap places.")
    expect(line.className).not.toContain("font-mono")
    const mono = [...line.querySelectorAll(".font-mono")].map((m) => m.textContent)
    expect(mono).toEqual(["5", "2", "3"])
  })

  it("shows a chunk column as evidence, not Build's chunk inspector", () => {
    const node = sampleGraph(registry, SOURCE).nodes.find((n) => n.stage === "chunk")!
    render(
      <VariantResult
        pending
        state={{ index: 0, order: ["chunk"], nodes: { chunk: { id: "chunk", status: "done", artifact_id: "a1" } } }}
        node={node}
        type="chunk_set"
        data={recursiveJson}
        status={{ kind: "ready" }}
        agreement={null}
        embeddings={null}
      />,
    )
    expect(screen.getByTestId("chunk-numbers")).toBeTruthy()
    expect(document.querySelector("[data-reading]")).toBeNull()
  })

  it("shows the question a Retrieve sweep answers", async () => {
    openAt("?node=retrieve")
    render(<Compare />)
    await waitFor(() => expect(pressed()).toBe("Retrieve"))
    const asked = String(sampleGraph(registry, SOURCE).nodes.find((n) => n.stage === "query")!.config.text)
    expect(screen.getByTestId("sweep-question").textContent).toBe(asked)
    expect(screen.getByRole("link", { name: "Change the question on Build" }).getAttribute("href")).toBe("/build")
  })

  it("gives the Change the question link a 44 px box under a coarse pointer, though it sits in a sentence", async () => {
    openAt("?node=retrieve")
    render(<Compare />)
    const link = await screen.findByRole("link", { name: "Change the question on Build" })
    for (const c of ["pointer-coarse:inline-flex", "pointer-coarse:min-h-[44px]", "pointer-coarse:items-center"]) expect(link.className.split(" ")).toContain(c)
  })

  it("moves the comparison to Retrieve: the searches, the question and the URL follow", async () => {
    render(<Compare />)
    await waitFor(() => expect(pressed()).toBe("Chunk"))
    choose("Retrieve")
    await waitFor(() => expect(pressed()).toBe("Retrieve"))
    expect(new URLSearchParams(window.location.search).get("node")).toBe("retrieve")
    expect(columns()).toEqual(["hybrid_rrf", "dense", "bm25"])
    expect(screen.getByTestId("sweep-question")).toBeTruthy()
  })

  it("shows no comparing sentence before a run finishes, only how many have finished", async () => {
    render(<Compare />)
    await waitFor(() => expect(pressed()).toBe("Chunk"))
    expect(screen.queryByTestId("compare-finding")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Run 3 recipes" }))
    await waitFor(() => expect(columns()).toHaveLength(0))
    expect(screen.getByTestId("compare-finding").textContent).toBe("Running three recipes. None has finished yet.")
  })

  it("shows no question on a Chunk sweep", async () => {
    render(<Compare />)
    await waitFor(() => expect(pressed()).toBe("Chunk"))
    expect(screen.queryByTestId("sweep-question")).toBeNull()
  })

  it("has no em-dashes or en-dashes", async () => {
    render(<Compare />)
    await waitFor(() => expect(pressed()).toBe("Chunk"))
    expect(text()).not.toMatch(/[–—]/)
  })
})

describe("Compare's widths", () => {
  it("puts three recipes side by side at 1024 after a run, each at least 300 px, with nothing to scroll sideways", async () => {
    FakeResizeObserver.width = 993
    vi.stubGlobal("ResizeObserver", FakeResizeObserver)
    render(<Compare />)
    fireEvent.click(await screen.findByRole("button", { name: "Run 3 recipes" }))
    const grid = await screen.findByTestId("recipe-grid")
    expect(grid.style.gridTemplateColumns).toBe("repeat(3, minmax(0, 1fr))")
    expect(grid.className).not.toContain("min-w-min")
    expect(screen.queryByRole("group", { name: "Recipe shown" })).toBeNull()
  })

  it("shows one recipe at a time below 820 px, chosen with a segmented control", async () => {
    FakeResizeObserver.width = 753
    vi.stubGlobal("ResizeObserver", FakeResizeObserver)
    render(<Compare />)
    fireEvent.click(await screen.findByRole("button", { name: "Run 3 recipes" }))
    const group = await screen.findByRole("group", { name: "Recipe shown" })
    const options = within(group).getAllByRole("button")
    expect(options).toHaveLength(3)
    expect(options[0].getAttribute("aria-pressed")).toBe("true")
    expect(regions()).toEqual(["Recursive (natural breaks), 400 characters"])
    fireEvent.click(options[2])
    expect(regions()).toEqual(["By sentence"])
  })

  it("names each recipe in the control by its short name", async () => {
    FakeResizeObserver.width = 753
    vi.stubGlobal("ResizeObserver", FakeResizeObserver)
    render(<Compare />)
    fireEvent.click(await screen.findByRole("button", { name: "Run 3 recipes" }))
    const group = await screen.findByRole("group", { name: "Recipe shown" })
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["400 characters, waiting", "200 characters, waiting", "By sentence, waiting"])
  })

})

describe("Compare's recipes", () => {
  it("makes each column after a run one region named by its recipe, the node's own tagged Your pipeline", async () => {
    render(<Compare />)
    fireEvent.click(await screen.findByRole("button", { name: "Run 3 recipes" }))
    await waitFor(() => expect(regions()).toHaveLength(3))
    const names = regions()
    expect(names).toEqual(["Recursive (natural breaks), 400 characters", "Recursive (natural breaks), 200 characters", "By sentence"])
    expect(within(screen.getByRole("region", { name: names[0]! })).getByText("Your pipeline")).toBeTruthy()
    expect(within(screen.getByRole("region", { name: names[1]! })).queryByText("Your pipeline")).toBeNull()
  })

  it("says recipe, not variant, on its buttons", async () => {
    render(<Compare />)
    await waitFor(() => expect(columns()).toHaveLength(3))
    expect(screen.getByRole("region", { name: "Add a recipe" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Run 3 recipes" })).toBeTruthy()
    expect(screen.getAllByRole("button", { name: /^Remove recipe \d$/ }).map((b) => b.getAttribute("aria-label"))).toEqual(["Remove recipe 2", "Remove recipe 3"])
    expect(text()).not.toMatch(/variant/i)
  })

  it("names strategies as Build does in the strategy editor, and gives the fields sentence-case titles", async () => {
    render(<Compare />)
    await waitFor(() => expect(columns()).toHaveLength(3))
    const second = screen.getByRole("article", { name: "Recipe 2" })
    fireEvent.click(within(second).getByRole("button", { name: /^Change the strategy/ }))
    const list = screen.getByRole("dialog", { name: "Strategy" })
    const current = within(list).getByRole("button", { name: /^Recursive \(natural breaks\) recursive_character/ })
    expect(current.getAttribute("aria-pressed")).toBe("true")
    // The same anatomy as the pickers on Build: a tick on the current one, the name and code name, one line of help.
    expect(current.querySelector("[data-tick] svg")).toBeTruthy()
    const heading = within(list).getByRole("button", { name: /^By heading markdown_header/ })
    expect(heading.querySelector("[data-tick] svg")).toBeNull()
    expect(heading.textContent).toContain("Cuts at headings, so each piece is one section: a heading and everything under it, up to the next heading.")
    expect(heading.textContent).not.toContain("Pieces do not overlap.")
    fireEvent.click(heading)
    expect(within(second).getByTestId("recipe-code").textContent).toBe("markdown_header")
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Change the strategy, now By heading")
    fireEvent.click(within(screen.getByRole("article", { name: "Recipe 3" })).getByRole("button", { name: /^Change sentences per chunk/ }))
    expect(screen.getByLabelText("Sentences per piece")).toBeTruthy()
    choose("Parse")
    await waitFor(() => expect(pressed()).toBe("Parse"))
    expect(text()).toContain("Read text in images (OCR) is off.")
    fireEvent.click(screen.getAllByRole("button", { name: /^Change do ocr/ })[0])
    expect(screen.getByLabelText("Read text in images (OCR)")).toBeTruthy()
  })
})

describe("before the run", () => {
  it("shows each recipe as a card of the same size, three to a row from lg, then Add a recipe", async () => {
    render(<Compare />)
    const grid = await screen.findByTestId("recipe-cards")
    expect(grid.className).toContain("auto-rows-fr")
    expect(grid.className).toContain("lg:grid-cols-3")
    expect(within(grid).getAllByRole("article").map((a) => a.getAttribute("aria-label"))).toEqual(["Your pipeline", "Recipe 2", "Recipe 3"])
    expect(within(grid).getByRole("region", { name: "Add a recipe" }).textContent).toContain("3 of 10 recipes.")
    expect(screen.getByTestId("plan").textContent).toMatch(/^You are about to compare your pipeline/)
  })

  it("opens one editor at a time under its value, and Escape closes it and gives focus back", async () => {
    render(<Compare />)
    fireEvent.click(await screen.findByRole("button", { name: "Change chunk size, now 400 characters" }))
    expect(screen.getByRole("dialog", { name: "Chunk size" })).toBeTruthy()
    const overlap = screen.getAllByRole("button", { name: /^Change chunk overlap/ })[1]
    fireEvent.click(overlap)
    expect(screen.getAllByRole("dialog")).toHaveLength(1)
    fireEvent.keyDown(document.activeElement!, { key: "Escape" })
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(document.activeElement).toBe(overlap)
  })

  it("updates the sentence, the plan and the Edited tag as a number changes, without redrawing the card", async () => {
    render(<Compare />)
    const card = await screen.findByRole("article", { name: "Recipe 2" })
    fireEvent.click(within(card).getByRole("button", { name: /^Change chunk size/ }))
    fireEvent.change(screen.getByLabelText("Chunk size"), { target: { value: "300" } })
    expect(screen.getByRole("article", { name: "Recipe 2" })).toBe(card)
    expect(within(card).getByRole("button", { name: "Change chunk size, now 300 characters" })).toBeTruthy()
    expect(within(card).getByText("Edited")).toBeTruthy()
    expect(screen.getByTestId("plan").textContent).toContain("Recursive at 300 characters")
  })

  it("stops at ten recipes and says why", async () => {
    render(<Compare />)
    const add = await screen.findByRole("region", { name: "Add a recipe" })
    for (let i = 0; i < 7; i++) {
      fireEvent.click(within(add).getByRole("button", { name: /Start from defaults/ }))
      fireEvent.keyDown(document.activeElement!, { key: "Escape" })
    }
    expect(screen.getAllByRole("article")).toHaveLength(10)
    expect(add.textContent).toContain("Ten recipes is the most one run takes. Remove one to add another.")
    expect(within(add).queryByRole("button")).toBeNull()
    expect(screen.getByRole("button", { name: "Run 10 recipes" })).toBeTruthy()
  })

  it("adds a suggestion as a New card with its strategy editor open, and removes a card", async () => {
    render(<Compare />)
    const add = await screen.findByRole("region", { name: "Add a recipe" })
    const first = within(add).getAllByRole("button")[0]
    expect(first.textContent).toMatch(/^By layout block/)
    fireEvent.click(first)
    const card = screen.getByRole("article", { name: "Recipe 4" })
    expect(within(card).getByText("New")).toBeTruthy()
    expect(within(card).getByRole("dialog", { name: "Strategy" })).toBeTruthy()
    fireEvent.click(within(card).getByRole("button", { name: "Remove recipe 4" }))
    expect(screen.getAllByRole("article")).toHaveLength(3)
  })

  it("swaps the cards for the results on Run, and Change recipes brings them back", async () => {
    DrivenEventSource.instances = []
    vi.stubGlobal("EventSource", DrivenEventSource)
    render(<Compare />)
    fireEvent.click(await screen.findByRole("button", { name: "Run 3 recipes" }))
    await waitFor(() => expect(screen.queryByTestId("recipe-cards")).toBeNull())
    ;(await driven()).emit(1, { event: "stream_end", status: "finished", ok: true })
    fireEvent.click(screen.getByRole("button", { name: "Change recipes" }))
    expect(screen.getByTestId("recipe-cards")).toBeTruthy()
  })
})

describe("after a run", () => {
  beforeEach(() => {
    DrivenEventSource.instances = []
    vi.stubGlobal("EventSource", DrivenEventSource)
  })

  /** Run 3 recipes, each finishing `nodes` with the artifact ids given per recipe. */
  async function runWith(nodes: Record<string, string[]>) {
    fireEvent.click(screen.getByRole("button", { name: "Run 3 recipes" }))
    await waitFor(() => expect(DrivenEventSource.instances.length).toBe(1))
    const es = DrivenEventSource.instances[0]
    let seq = 1
    for (let i = 0; i < 3; i++) {
      es.emit(seq++, { event: "variant_started", index: i, variant: {} })
      for (const [node, ids] of Object.entries(nodes)) es.emit(seq++, { event: "node_finished", node_id: node, artifact_id: ids[i], cache_hit: false, duration_ms: 1 })
    }
    es.emit(seq, { event: "stream_end", status: "finished", ok: true })
  }

  it("follows a document chosen on this page, and says the results are from the old one", async () => {
    serve({ a0: recursiveJson, a1: markdownJson, a2: tokenJson })
    render(<Compare />)
    await waitFor(() => expect(columns()).toHaveLength(3))
    await runWith({ chunk: ["a0", "a1", "a2"] })
    await screen.findByTestId("compare-finding")
    expect(screen.queryByTestId("document-note")).toBeNull()
    await act(() => chooseDocument({ sha: "12".repeat(32), filename: "my-notes.pdf" }))
    expect(text()).toContain("over my-notes.pdf")
    expect(screen.getByTestId("document-note").textContent).toBe(
      "The document changed to my-notes.pdf. The results below are from the old one. Run again to update them.",
    )
  })

  it("opens a Chunk run with the finding sentence, its sub line and the quiet tally, and shows each column as evidence", async () => {
    serve({ a0: recursiveJson, a1: markdownJson, a2: tokenJson })
    render(<Compare />)
    await waitFor(() => expect(columns()).toHaveLength(3))
    await runWith({ chunk: ["a0", "a1", "a2"] })
    const finding = await screen.findByTestId("compare-finding")
    expect(finding.textContent).toMatch(/^Halving the size /)
    expect(finding.className).toContain("text-lg")
    expect(finding.className).toContain("max-w-[52ch]")
    expect(screen.getByTestId("compare-sub").textContent).toMatch(/^Smaller pieces are tighter matches/)
    expect(screen.getByTestId("tally").className).toContain("text-xs")
    await waitFor(() => expect(screen.getAllByTestId("chunk-numbers")).toHaveLength(3))
    expect(text()).not.toMatch(/The colours are piece numbers/)
  })

  it("opens a Retrieve run with what each search did, and never says the answer for a question the sample does not have", async () => {
    const graph = sampleGraph(registry, SOURCE)
    const through = terminalNode(graph)!.id
    serve({ c: recursiveJson, i: indexJson, h: hybridJson, d: denseJson, b: bm25Json })
    openAt("?node=retrieve")
    render(<Compare />)
    await waitFor(() => expect(columns()).toHaveLength(3))
    await runWith({ chunk: ["c", "c", "c"], index: ["i", "i", "i"], [through]: ["h", "d", "b"] })
    const finding = await screen.findByTestId("compare-finding")
    expect(finding.textContent).not.toMatch(/answer/)
    expect(finding.textContent).toMatch(/Dense|BM25/)
    await waitFor(() => expect(text()).toMatch(/The colours are piece numbers, the same in every column, because all three recipes search the same 6 pieces\./))
    const agreements = screen.getAllByTestId("agreement")
    expect(agreements[0].textContent).toBe("The baseline. The other recipes are read against this list.")
    expect(agreements[0].className).toContain("font-semibold")
    expect(screen.queryByTestId("fact-hits")).toBeNull()
    // The index is shared on Retrieve, so its embedding counts would say the same thing in every column.
    expect(screen.queryByTestId("embeddings")).toBeNull()
  })

  it("keeps a failed recipe's headline and traceback in its column while its editor is folded", async () => {
    serve({ a0: recursiveJson, a2: tokenJson })
    render(<Compare />)
    await waitFor(() => expect(columns()).toHaveLength(3))
    fireEvent.click(screen.getByRole("button", { name: "Run 3 recipes" }))
    await waitFor(() => expect(DrivenEventSource.instances.length).toBe(1))
    const es = DrivenEventSource.instances[0]
    es.emit(1, { event: "variant_started", index: 0, variant: {} })
    es.emit(2, { event: "node_finished", node_id: "chunk", artifact_id: "a0", cache_hit: false, duration_ms: 1 })
    es.emit(3, { event: "variant_started", index: 1, variant: {} })
    es.emit(4, { event: "node_started", node_id: "chunk", transform: "recursive_character", artifact_id: "x" })
    es.emit(5, { event: "node_failed", node_id: "chunk", error: "Traceback (most recent call last):\nValueError: chunk_size too small" })
    es.emit(6, { event: "variant_started", index: 2, variant: {} })
    es.emit(7, { event: "node_finished", node_id: "chunk", artifact_id: "a2", cache_hit: false, duration_ms: 1 })
    es.emit(8, { event: "stream_end", status: "finished", ok: false })
    await waitFor(() => expect(statusOf(1)).toMatch(/^Failed at Chunk\. ValueError: chunk_size too small/))
    expect(within(column(1)).getByText("Traceback")).toBeTruthy()
    expect(screen.getByTestId("tally").textContent).toMatch(/1 recipe failed\./)
  })

})

describe("during a run", () => {
  beforeEach(() => {
    DrivenEventSource.instances = []
    vi.stubGlobal("EventSource", DrivenEventSource)
  })

  it("shows Waiting, then Running with the seconds the browser counted, then the result", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    serve({ a0: recursiveJson })
    render(<Compare />)
    fireEvent.click(await screen.findByRole("button", { name: "Run 3 recipes" }))
    const es = await driven()
    es.emit(1, { event: "variant_started", index: 0, variant: {} })
    es.emit(2, { event: "node_started", node_id: "parse", transform: "docling", artifact_id: "p" })
    await waitFor(() => expect(statusOf(0)).toBe("Running the shared steps, then this recipe, 0 s"))
    expect(statusOf(1)).toBe("Waiting. It starts when the recipe before it finishes.")
    act(() => vi.advanceTimersByTime(3000))
    expect(statusOf(0)).toBe("Running the shared steps, then this recipe, 3 s")
    es.emit(3, { event: "node_finished", node_id: "chunk", artifact_id: "a0", cache_hit: false, duration_ms: 1 })
    await waitFor(() => expect(screen.getAllByTestId("chunk-numbers")).toHaveLength(1))
    expect(screen.getByTestId("compare-finding").textContent).toBe("Running three recipes. One has finished.")
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1")
    vi.useRealTimers()
  })

  it("lets the others finish when one fails, and offers Change this recipe on the failed one", async () => {
    serve({ a0: recursiveJson, a2: tokenJson })
    render(<Compare />)
    fireEvent.click(await screen.findByRole("button", { name: "Run 3 recipes" }))
    const es = await driven()
    es.emit(1, { event: "variant_started", index: 0, variant: {} })
    es.emit(2, { event: "node_finished", node_id: "chunk", artifact_id: "a0", cache_hit: false, duration_ms: 1 })
    es.emit(3, { event: "variant_started", index: 1, variant: {} })
    es.emit(4, { event: "node_started", node_id: "chunk", transform: "recursive_character", artifact_id: "x" })
    es.emit(5, { event: "node_failed", node_id: "chunk", error: "Traceback (most recent call last):\nValueError: chunk_size too small" })
    es.emit(6, { event: "variant_started", index: 2, variant: {} })
    es.emit(7, { event: "node_finished", node_id: "chunk", artifact_id: "a2", cache_hit: false, duration_ms: 1 })
    es.emit(8, { event: "stream_end", status: "finished", ok: false })
    const failed = within(column(1)).getByTestId("recipe-status")
    expect(failed.textContent).toMatch(/^Failed at Chunk\. ValueError: chunk_size too small/)
    await waitFor(() => expect(screen.getAllByTestId("chunk-numbers")).toHaveLength(2))
    await waitFor(() => expect(screen.getByTestId("compare-finding").textContent).toMatch(/Recursive at 200 characters failed, and its column says why\.$/))
    fireEvent.click(within(failed).getByRole("button", { name: "Change this recipe" }))
    expect(document.activeElement?.closest("article")?.getAttribute("aria-label")).toBe("Recipe 2")
  })

  it("offers Stop the run in place of Change recipes while it runs, and says what was never run", async () => {
    render(<Compare />)
    fireEvent.click(await screen.findByRole("button", { name: "Run 3 recipes" }))
    const es = await driven()
    es.emit(1, { event: "variant_started", index: 0, variant: {} })
    expect(screen.queryByRole("button", { name: "Change recipes" })).toBeNull()
    const busy = screen.getByRole("button", { name: "Running" })
    expect(busy.getAttribute("aria-busy")).toBe("true")
    fireEvent.click(screen.getByRole("button", { name: "Stop the run" }))
    expect(fetch).toHaveBeenCalledWith("/api/runs/r1/cancel", expect.anything())
    es.emit(9, { event: "stream_end", status: "cancelled", ok: false })
    await waitFor(() => expect(statusOf(2)).toBe("Not run. The run was stopped first."))
  })

  it("keeps focus where it is when a recipe finishes, and labels the tabs with each state", async () => {
    FakeResizeObserver.width = 753
    vi.stubGlobal("ResizeObserver", FakeResizeObserver)
    serve({ a1: markdownJson })
    render(<Compare />)
    fireEvent.click(await screen.findByRole("button", { name: "Run 3 recipes" }))
    const es = await driven()
    es.emit(1, { event: "variant_started", index: 0, variant: {} })
    es.emit(2, { event: "node_finished", node_id: "chunk", artifact_id: "a1", cache_hit: false, duration_ms: 1 })
    es.emit(3, { event: "variant_started", index: 1, variant: {} })
    const tabs = within(screen.getByRole("group", { name: "Recipe shown" })).getAllByRole("button").map((b) => b.textContent)
    expect(tabs).toEqual(["400 characters", "200 characters, running", "By sentence, waiting"])
    const stop = screen.getByRole("button", { name: "Stop the run" })
    stop.focus()
    es.emit(5, { event: "node_finished", node_id: "chunk", artifact_id: "a1", cache_hit: false, duration_ms: 1 })
    await waitFor(() => expect(within(screen.getByRole("group", { name: "Recipe shown" })).getAllByRole("button")[1].textContent).toBe("200 characters"))
    expect(document.activeElement).toBe(stop)
  })
})

describe("four recipes or more", () => {
  beforeEach(() => {
    DrivenEventSource.instances = []
    vi.stubGlobal("EventSource", DrivenEventSource)
    vi.stubGlobal("ResizeObserver", FakeResizeObserver)
  })

  const rowOf = (i: number) => document.querySelector<HTMLElement>(`[data-recipe="${i}"]`)!

  it("opens a five-recipe Chunk run on a table that sorts by its headers", async () => {
    FakeResizeObserver.width = 1409
    await runFive("chunk")
    const table = await screen.findByRole("table", { name: "Results for five recipes" })
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Select", "Recipe", "Pieces", "Tokens", "Median", "Largest 5%", "Left out", "The document, to scale"])
    fireEvent.click(within(table).getByRole("button", { name: "Pieces" }))
    expect(within(table).getByRole("button", { name: "Pieces" }).closest("th")!.getAttribute("aria-sort")).toBe("descending")
    expect(within(table).getAllByText(/^(most|fewest)$/)).toHaveLength(2)
    expect(screen.getByText(/^Sorted by pieces\. Tap a name to open it beside Your pipeline, or tick up to three to read side by side\.$/)).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId("compare-finding").textContent).toMatch(/^From \d+ to \d+ pieces\./))
  })

  it("lets up to three be ticked at 1440, and two at 768", async () => {
    FakeResizeObserver.width = 1409
    await runFive("chunk")
    await screen.findByRole("table")
    const boxes = screen.getAllByRole("checkbox")
    boxes.slice(0, 3).forEach((b) => fireEvent.click(b))
    expect((boxes[3] as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByRole("region", { name: "Selection" }).textContent).toContain("Three picked, the most that fit side by side at this width.")
    act(() => FakeResizeObserver.all.forEach((o) => o.report(737)))
    expect(screen.getAllByRole("checkbox").filter((b) => (b as HTMLInputElement).checked)).toHaveLength(2)
  })

  it("becomes a list with Sort by on a phone, with no ticks", async () => {
    FakeResizeObserver.width = 358
    await runFive("chunk")
    await waitFor(() => expect(screen.getByLabelText("Sort by")).toBeTruthy())
    expect(screen.queryByRole("table")).toBeNull()
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0)
    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "pieces" } })
    expect(screen.getByRole("button", { name: "Highest first" })).toBeTruthy()
    expect(screen.getByRole("list", { name: "Results for five recipes" }).textContent).toMatch(/\d+ pieces \(most\)/)
  })

  it("hides the Answer column on Retrieve when the question is not one of the sample's", async () => {
    FakeResizeObserver.width = 1409
    await runFive("retrieve")
    const heads = within(await screen.findByRole("table")).getAllByRole("columnheader").map((h) => h.textContent)
    expect(heads).toEqual(["Select", "Recipe", "Shared", "Returned", "Top 5, by piece"])
    expect(screen.getAllByRole("img", { name: /^Top \d+: piece \d+/ }).length).toBeGreaterThan(0)
    expect(text()).not.toMatch(/The colours are piece numbers/)
  })

  it("lets a finished row be opened while the run goes on", async () => {
    FakeResizeObserver.width = 1409
    await runFive("chunk", 2)
    await waitFor(() => expect(screen.getByRole("button", { name: /^Open .* beside Your pipeline$/ })).toBeTruthy())
    expect(within(rowOf(2)).getByTestId("recipe-status").textContent).toMatch(/^Running/)
    expect(within(rowOf(2)).queryByRole("checkbox")).toBeNull()
    expect(screen.getByTestId("compare-sub").textContent).toBe("The sentence that compares them appears when every recipe has finished. You can open a finished one now.")
  })

  it("lists Index recipes plainly, with nothing to sort", async () => {
    FakeResizeObserver.width = 1409
    openAt("?node=index&preset=matryoshka&native=1024")
    render(<Compare />)
    fireEvent.click(await screen.findByRole("button", { name: "Run 5 recipes" }))
    expect(await screen.findByRole("list", { name: "Results for five recipes" })).toBeTruthy()
    expect(screen.queryByRole("table")).toBeNull()
    expect(screen.queryByLabelText("Sort by")).toBeNull()
  })
})

describe("the open view", () => {
  beforeEach(() => {
    DrivenEventSource.instances = []
    vi.stubGlobal("EventSource", DrivenEventSource)
    vi.stubGlobal("ResizeObserver", FakeResizeObserver)
  })

  it("opens a recipe beside Your pipeline, and Escape goes back with the sort, the ticks and focus kept", async () => {
    FakeResizeObserver.width = 1409
    await runFive("chunk")
    await screen.findByRole("table")
    fireEvent.click(screen.getByRole("button", { name: "Pieces" }))
    fireEvent.click(screen.getAllByRole("checkbox")[2])
    const name = screen.getAllByRole("button", { name: /^Open .* beside Your pipeline$/ })[1]
    fireEvent.click(name)
    expect(screen.getByRole("button", { name: "Back to all five recipes" })).toBeTruthy()
    expect(screen.getAllByTestId("chunk-numbers")).toHaveLength(2)
    expect(new URLSearchParams(window.location.search).get("read")).toMatch(/^1,\d$/)
    fireEvent.keyDown(document.body, { key: "Escape" })
    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy())
    expect(screen.getByRole("button", { name: "Pieces" }).closest("th")!.getAttribute("aria-sort")).toBe("descending")
    expect((screen.getAllByRole("checkbox")[2] as HTMLInputElement).checked).toBe(true)
    expect(document.activeElement).toBe(name)
  })

  it("steps with Next and the arrow keys in the table's order, and the browser's Back returns to the table", async () => {
    FakeResizeObserver.width = 1409
    await runFive("chunk")
    await screen.findByRole("table")
    fireEvent.click(screen.getAllByRole("button", { name: /^Open .* beside Your pipeline$/ })[0])
    expect(screen.getByText(/^1 of 4, each beside Your pipeline$/)).toBeTruthy()
    expect(screen.getByText(/^Next: .+\. Press Next or the right arrow key\.$/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    fireEvent.keyDown(document.body, { key: "ArrowRight" })
    expect(screen.getByText(/^3 of 4, each beside Your pipeline$/)).toBeTruthy()
    expect(screen.getAllByRole("region").filter((r) => r.closest("[hidden]") === null).map((r) => r.getAttribute("aria-label"))[0]).toMatch(/^Recursive/)
    act(() => window.history.back())
    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy())
  })

  it("reads three ticked recipes side by side at 1440, and the two extremes from the finding's link", async () => {
    FakeResizeObserver.width = 1409
    await runFive("chunk")
    await screen.findByRole("table")
    screen.getAllByRole("checkbox").slice(1, 4).forEach((b) => fireEvent.click(b))
    fireEvent.click(screen.getByRole("button", { name: "Read three side by side" }))
    expect(screen.getAllByTestId("chunk-numbers")).toHaveLength(3)
    expect(screen.getByText("Three of five, side by side")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Back to all five recipes" }))
    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy())
    fireEvent.click(await screen.findByRole("button", { name: "Read the two extremes side by side" }))
    expect(screen.getAllByTestId("chunk-numbers")).toHaveLength(2)
    expect(screen.getByText("Two of five, side by side")).toBeTruthy()
  })

  it("gives focus back to the finding's link, and to Read side by side, when the view closes", async () => {
    FakeResizeObserver.width = 1409
    await runFive("chunk")
    await screen.findByRole("table")
    const link = await screen.findByRole("button", { name: "Read the two extremes side by side" })
    fireEvent.click(link)
    fireEvent.click(screen.getByRole("button", { name: "Back to all five recipes" }))
    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy())
    await waitFor(() => expect(document.activeElement).toBe(link))
    screen.getAllByRole("checkbox").slice(1, 3).forEach((b) => fireEvent.click(b))
    const read = screen.getByRole("button", { name: "Read two side by side" })
    fireEvent.click(read)
    fireEvent.keyDown(document.body, { key: "Escape" })
    await waitFor(() => expect(document.activeElement).toBe(read))
  })

  it("names the baseline by its phrase when no recipe is the pipeline's own", async () => {
    FakeResizeObserver.width = 1409
    await runFive("chunk", 5, () => {
      fireEvent.click(screen.getByRole("button", { name: "Change chunk size, now 400 characters" }))
      fireEvent.change(screen.getByLabelText("Chunk size"), { target: { value: "300" } })
      fireEvent.keyDown(document.activeElement!, { key: "Escape" })
    })
    await screen.findByRole("table")
    expect(text()).not.toMatch(/Your pipeline/)
    expect(screen.getByText(/^Sorted by recipe order\. Tap a name to open it beside Recursive at 300 characters,/)).toBeTruthy()
    fireEvent.click(screen.getAllByRole("button", { name: /^Open .* beside Recursive at 300 characters$/ })[0])
    expect(screen.getByText(/^1 of 4, each beside Recursive at 300 characters$/)).toBeTruthy()
    expect(text()).toMatch(/(more|fewer) pieces? than Recursive at 300 characters|The same number of pieces as Recursive at 300 characters/)
    expect(text()).not.toMatch(/Your pipeline/)
  })

  it("keeps the browser's Back true when the step changes from the open view", async () => {
    FakeResizeObserver.width = 1409
    await runFive("chunk")
    await screen.findByRole("table")
    fireEvent.click(screen.getAllByRole("button", { name: /^Open .* beside Your pipeline$/ })[0])
    choose("Retrieve")
    await waitFor(() => expect(pressed()).toBe("Retrieve"))
    expect(new URLSearchParams(window.location.search).get("node")).toBe("retrieve")
    expect(new URLSearchParams(window.location.search).get("read")).toBeNull()
    act(() => window.history.back())
    await waitFor(() => expect(pressed()).toBe("Chunk"))
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("read")).toBeNull())
    expect(new URLSearchParams(window.location.search).get("node")).not.toBe("retrieve")
  })

  it("shows one recipe at a time on a phone, with Previous and Next", async () => {
    FakeResizeObserver.width = 358
    await runFive("chunk")
    await screen.findByLabelText("Sort by")
    fireEvent.click(screen.getByRole("button", { name: /^Open Your pipeline$/ }))
    expect(screen.getAllByTestId("chunk-numbers")).toHaveLength(1)
    expect(screen.getByText(/^1 of 5$/)).toBeTruthy()
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    expect(screen.getByText(/^2 of 5$/)).toBeTruthy()
  })

  it("marks unfinished recipes in the chip strip and never moves the view when one finishes", async () => {
    FakeResizeObserver.width = 1409
    const es = await runFive("chunk", 2)
    fireEvent.click(await screen.findByRole("button", { name: /^Open .* beside Your pipeline$/ }))
    const strip = screen.getByRole("group", { name: "All five recipes" })
    const running = within(strip).getAllByRole("button").find((b) => b.getAttribute("aria-label")?.endsWith(", running"))!
    expect((running as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/ is running\. Its chip fills in when it finishes; this view stays put\.$/)).toBeTruthy()
    const back = screen.getByRole("button", { name: "Back to all five recipes" })
    back.focus()
    const before = screen.getAllByTestId("chunk-numbers").length
    es.emit(50, { event: "node_finished", node_id: "chunk", artifact_id: "a2", cache_hit: false, duration_ms: 1 })
    await waitFor(() => expect((within(strip).getAllByRole("button").find((b) => b.textContent === running.textContent) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getAllByTestId("chunk-numbers")).toHaveLength(before)
    expect(document.activeElement).toBe(back)
  })
})

describe("experiments", () => {
  it("keeps the run buttons at their full text width and gives the experiment buttons their own row below md", async () => {
    DrivenEventSource.instances = []
    vi.stubGlobal("EventSource", DrivenEventSource)
    render(<Compare />)
    fireEvent.click(await screen.findByRole("button", { name: "Run 3 recipes" }))
    ;(await driven()).emit(1, { event: "stream_end", status: "finished", ok: true })
    for (const name of ["Change recipes", "Run 3 recipes"]) expect(screen.getByRole("button", { name }).className.split(" ")).toContain("min-w-fit")
    const menu = screen.getByTestId("experiment-tools")
    expect(menu.className.split(" ")).toContain("basis-full")
    expect(menu.className.split(" ")).toContain("md:basis-auto")
  })

  it("saves an experiment, says when it is edited, and offers Save changes or Save as new", async () => {
    render(<Compare />)
    fireEvent.click(await screen.findByRole("button", { name: "Save experiment" }))
    fireEvent.change(screen.getByLabelText("Name this experiment"), { target: { value: "Primer sizes" } })
    fireEvent.click(within(screen.getByRole("dialog", { name: "Save experiment" })).getByRole("button", { name: "Save experiment" }))
    expect(screen.getByTestId("experiment-line").textContent).toMatch(/^Experiment Primer sizes/)
    expect(screen.getByRole("button", { name: "Saved" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Change chunk size, now 200 characters" }))
    fireEvent.change(screen.getByLabelText("Chunk size"), { target: { value: "250" } })
    expect(screen.getByTestId("experiment-line").textContent).toContain("Edited since saved")
    fireEvent.keyDown(document.activeElement!, { key: "Escape" })
    fireEvent.click(screen.getByRole("button", { name: "Save experiment" }))
    const sheet = screen.getByRole("dialog", { name: "Save experiment" })
    expect(within(sheet).getAllByRole("button").map((b) => b.textContent)).toEqual(["Save as new", "Cancel", "Save changes"])
    fireEvent.click(within(sheet).getByRole("button", { name: "Save changes" }))
    expect(screen.getByTestId("experiment-line").textContent).not.toContain("Edited since saved")
    expect(JSON.parse(window.localStorage.getItem("rag-playground:experiments:v1")!)).toHaveLength(1)
  })

  it("reopens an experiment with its step, its recipes and its document", async () => {
    saveExperiment("Searches", { stage: "retrieve", recipes: [{ transform: "dense", config: { top_k: 3 } }, { transform: "bm25", config: { top_k: 20 } }], doc: { sha: "12".repeat(32), filename: "my-notes.pdf" } })
    render(<Compare />)
    fireEvent.click(await screen.findByRole("button", { name: "Your experiments (1)" }))
    fireEvent.click(screen.getByRole("button", { name: "Searches" }))
    await waitFor(() => expect(pressed()).toBe("Retrieve"))
    expect(columns()).toEqual(["dense", "bm25"])
    await waitFor(() => expect(text()).toContain("over my-notes.pdf"))
    expect(new URLSearchParams(window.location.search).get("node")).toBe("retrieve")
    expect(screen.getByTestId("experiment-line").textContent).toMatch(/^Experiment Searches/)
    expect(screen.getByTestId("experiment-line").textContent).not.toContain("Edited since saved")
    choose("Chunk")
    await waitFor(() => expect(pressed()).toBe("Chunk"))
    expect(screen.queryByTestId("experiment-line")).toBeNull()
  })

  it("opens the experiment another page asked for, once", async () => {
    const { saved } = saveExperiment("From the Library", { stage: "retrieve", recipes: [{ transform: "bm25", config: { top_k: 5 } }], doc: SOURCE })!
    requestOpenExperiment(saved.id)
    render(<Compare />)
    await waitFor(() => expect(pressed()).toBe("Retrieve"))
    expect(columns()).toEqual(["bm25"])
    expect(screen.getByTestId("experiment-line").textContent).toMatch(/^Experiment From the Library/)
    expect(window.sessionStorage.getItem("rag-playground:experiments:open")).toBeNull()
  })

  it("puts a finished recipe on Build with Use on Build, and keeps reading against the baseline of the run", async () => {
    DrivenEventSource.instances = []
    vi.stubGlobal("EventSource", DrivenEventSource)
    serve({ a0: recursiveJson, a1: markdownJson, a2: tokenJson })
    render(<Compare />)
    fireEvent.click(await screen.findByRole("button", { name: "Run 3 recipes" }))
    const es = await driven()
    ;["a0", "a1", "a2"].forEach((id, i) => {
      es.emit(i * 2 + 1, { event: "variant_started", index: i, variant: {} })
      es.emit(i * 2 + 2, { event: "node_finished", node_id: "chunk", artifact_id: id, cache_hit: false, duration_ms: 1 })
    })
    es.emit(9, { event: "stream_end", status: "finished", ok: true })
    await waitFor(() => expect(screen.getAllByTestId("chunk-numbers")).toHaveLength(3))
    fireEvent.click(within(column(1)).getByRole("button", { name: "Use on Build" }))
    const chunk = JSON.parse(window.localStorage.getItem(GRAPH_KEY)!).nodes.find((n: { stage: string }) => n.stage === "chunk")
    expect(chunk.config).toMatchObject({ chunk_size: 200 })
    expect(within(column(1)).getByText("Now on Build")).toBeTruthy()
    expect(within(column(0)).queryByRole("button", { name: "Use on Build" })).toBeNull()
    expect(within(column(0)).getByText("Your pipeline")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Change recipes" }))
    expect(screen.getAllByRole("article").map((a) => a.getAttribute("aria-label"))).toEqual(["Recipe 1", "Your pipeline", "Recipe 3"])
  })

  it("hides the experiment buttons while a run goes", async () => {
    DrivenEventSource.instances = []
    vi.stubGlobal("EventSource", DrivenEventSource)
    render(<Compare />)
    fireEvent.click(await screen.findByRole("button", { name: "Run 3 recipes" }))
    await driven()
    expect(screen.queryByRole("button", { name: "Save experiment" })).toBeNull()
    expect(screen.queryByRole("button", { name: /^Your experiments/ })).toBeNull()
  })
})

describe("a run the server rejects", () => {
  const rejected = (loc: string[], msg: string) =>
    new Response(JSON.stringify({ detail: { node_id: "chunk", errors: [{ loc, msg, type: "value_error" }] } }), { status: 422 })

  it("puts the message under the recipe it belongs to, in plain words, with that field's editor open", async () => {
    serve({}, { "/api/sweeps": rejected(["overlap_sentences"], "Overlap must be smaller than the number of sentences per chunk.") })
    render(<Compare />)
    await waitFor(() => expect(columns()).toHaveLength(3))
    fireEvent.click(screen.getByRole("button", { name: "Run 3 recipes" }))
    const card = screen.getByRole("article", { name: "Recipe 3" })
    const alert = await within(card).findByRole("alert")
    expect(alert.textContent).toBe("Overlap sentences: Overlap must be smaller than the number of sentences per chunk.")
    expect(alert.className).toContain("text-danger")
    expect(within(card).getByRole("dialog", { name: "Overlap sentences" })).toBeTruthy()
    expect(screen.getAllByRole("dialog")).toHaveLength(1)
    expect(columns()).toHaveLength(3)
  })

  it("below 820 px, returns to the cards with the failing recipe's editor open", async () => {
    FakeResizeObserver.width = 753
    vi.stubGlobal("ResizeObserver", FakeResizeObserver)
    serve({}, { "/api/sweeps": rejected(["overlap_sentences"], "Overlap must be smaller than the number of sentences per chunk.") })
    render(<Compare />)
    fireEvent.click(await screen.findByRole("button", { name: "Run 3 recipes" }))
    await screen.findByRole("alert")
    expect(screen.getByTestId("recipe-cards")).toBeTruthy()
    expect(within(screen.getByRole("article", { name: "Recipe 3" })).getByRole("dialog")).toBeTruthy()
  })

  it("says an error it cannot tie to one recipe above the cards, and opens no editor", async () => {
    serve({}, { "/api/sweeps": rejected(["chunk_size"], "Input should be greater than 0.") })
    render(<Compare />)
    await waitFor(() => expect(columns()).toHaveLength(3))
    fireEvent.click(screen.getByRole("button", { name: "Run 3 recipes" }))
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toBe("Chunk, Chunk size: Input should be greater than 0.")
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(columns()).toHaveLength(3)
  })
})

describe("after a run on one of the sample's own questions", () => {
  beforeEach(() => {
    DrivenEventSource.instances = []
    vi.stubGlobal("EventSource", DrivenEventSource)
  })

  it("says where the answer is, and the slip that holds it says so", async () => {
    const graph = sampleGraph(registry, SOURCE)
    const through = terminalNode(graph)!.id
    const question = String(graph.nodes.find((n) => n.stage === "query")!.config.text)
    serve(
      { c: recursiveJson, h: hybridJson, d: denseJson, b: bm25Json },
      {
        "/api/samples": [{ name: "chunking-primer", title: "A primer on chunking", blurb: "", shows: "", stresses: "chunk", pages: 2, sha: SOURCE.sha, filename: SOURCE.filename }],
        "/api/samples/chunking-primer/questions": [{ id: "q1", question, gold_answer: "Overlap protects answers that straddle", gold_answers: [], tags: [] }],
      },
    )
    openAt("?node=retrieve")
    render(<Compare />)
    await waitFor(() => expect(columns()).toHaveLength(3))
    fireEvent.click(screen.getByRole("button", { name: "Run 3 recipes" }))
    await waitFor(() => expect(DrivenEventSource.instances.length).toBe(1))
    const es = DrivenEventSource.instances[0]
    let seq = 1
    ;["h", "d", "b"].forEach((id, i) => {
      es.emit(seq++, { event: "variant_started", index: i, variant: {} })
      es.emit(seq++, { event: "node_finished", node_id: "chunk", artifact_id: "c", cache_hit: false, duration_ms: 1 })
      es.emit(seq++, { event: "node_finished", node_id: through, artifact_id: id, cache_hit: false, duration_ms: 1 })
    })
    es.emit(seq, { event: "stream_end", status: "finished", ok: true })
    await waitFor(() => expect(screen.getByTestId("compare-finding").textContent).toMatch(/^All three put the answer first\. /))
    await waitFor(() => expect(screen.getAllByText(", holds the answer").length).toBe(3))
  })
})

describe("seedVariants", () => {
  const chunk = () => sampleGraph(registry, SOURCE).nodes.find((n) => n.stage === "chunk")!

  it("seeds a Chunk sweep with the node's recipe, the same recipe at half the size, and By sentence on defaults", () => {
    const v = seedVariants(chunk(), transformsFor(registry, "chunk"))
    expect(v.map((x) => x.transform)).toEqual(["recursive_character", "recursive_character", "sentence_window"])
    expect(v[0].config).toEqual(chunk().config)
    expect(v[1].config).toMatchObject({ chunk_size: 200, chunk_overlap: 40 })
    expect(v[2].config).toMatchObject({ sentences_per_chunk: 5, overlap_sentences: 1 })
  })

  it("seeds Recursive on defaults as the third recipe when the node already cuts by sentence", () => {
    const node = { ...chunk(), transform: "sentence_window", config: { sentences_per_chunk: 6, overlap_sentences: 2 } }
    const v = seedVariants(node, transformsFor(registry, "chunk"))
    expect(v.map((x) => x.transform)).toEqual(["sentence_window", "sentence_window", "recursive_character"])
    expect(v[1].config).toMatchObject({ sentences_per_chunk: 3, overlap_sentences: 1 })
  })

  it("keeps the old rule for Parse: the node's parser, then the others", () => {
    const parse = sampleGraph(registry, SOURCE).nodes.find((n) => n.stage === "parse")!
    expect(seedVariants(parse, transformsFor(registry, "parse")).map((x) => x.transform)).toEqual(["docling", "pdfium"])
  })
})

describe("the document in the bar", () => {
  it("says the document is missing and disables the run", async () => {
    storeGraph(sampleGraph(registry, { sha: "ef".repeat(32), filename: "NK_Resume.pdf" }))
    serve({}, { "/api/sources": [], "/api/samples": [] })
    render(<Compare />)
    const note = await screen.findByTestId("document-note")
    expect(note.textContent).toContain("Pick a document in the bar above to run these recipes.")
    expect((screen.getByRole("button", { name: "Run 3 recipes" }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText("Needs a document.")).toBeTruthy()
  })

  it("asks for a document when the pipeline has none, instead of No pipeline to compare", async () => {
    const g = sampleGraph(registry, SOURCE)
    storeGraph(setConfig(g, "source", {}))
    serve({}, { "/api/sources": [], "/api/samples": [] })
    render(<Compare />)
    const note = await screen.findByTestId("document-note")
    expect(note.textContent).toContain("Pick a document in the bar above to run these recipes.")
    expect(screen.queryByText("No pipeline to compare")).toBeNull()
    expect((screen.getByRole("button", { name: "Run 3 recipes" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("says No pipeline to compare when there is no pipeline at all", async () => {
    window.localStorage.clear()
    render(<Compare />)
    expect(await screen.findByText("No pipeline to compare")).toBeTruthy()
  })
})
