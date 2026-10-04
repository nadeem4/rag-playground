import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import markdownJson from "@/api/fixtures/chunk_set.markdown_header.json"
import recursiveJson from "@/api/fixtures/chunk_set.recursive_character.json"
import tokenJson from "@/api/fixtures/chunk_set.token_based.json"
import liveRegistry from "@/api/fixtures/registry.json"
import bm25Json from "@/api/fixtures/retrieval_result.bm25.json"
import denseJson from "@/api/fixtures/retrieval_result.dense.json"
import hybridJson from "@/api/fixtures/retrieval_result.hybrid_rrf.json"
import type { Registry } from "@/api/types"
import { sampleGraph, storeGraph, terminalNode, transformsFor } from "@/state/graph"

import { Compare, seedVariants, VariantResult } from "./Compare"
import { FakeResizeObserver } from "./fakeResizeObserver"

const registry = liveRegistry as unknown as Registry
const SOURCE = { sha: "cd".repeat(32), filename: "chunking-primer.pdf" }

class SilentEventSource {
  onmessage = null
  onerror = null
  onopen = null
  close() {}
}

/** Artifact payloads by id, served at `/api/artifacts/{id}/payload`; `extra` answers other URLs. */
function serve(artifacts: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
  const missing = () => new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/registry") return ok(liveRegistry)
      if (url === "/api/sweeps") return ok({ run_id: "r1" })
      if (url in extra) return ok(extra[url])
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
const columns = () => (screen.queryAllByLabelText("Strategy") as HTMLSelectElement[]).map((s) => s.value)
const text = () => document.body.textContent ?? ""

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
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

  it("shows no finding sentence before a run finishes", async () => {
    render(<Compare />)
    await waitFor(() => expect(pressed()).toBe("Chunk"))
    expect(screen.queryByTestId("compare-finding")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Run 3 recipes" }))
    await waitFor(() => expect(columns()).toHaveLength(0))
    expect(screen.queryByTestId("compare-finding")).toBeNull()
  })

  it("shows no question on a Chunk sweep", async () => {
    render(<Compare />)
    await waitFor(() => expect(pressed()).toBe("Chunk"))
    expect(screen.queryByTestId("sweep-question")).toBeNull()
  })

  it("uses no sm: class in the files this patch touched, since the theme has no sm breakpoint", async () => {
    const { readFileSync } = await import("node:fs")
    const files = ["routes/Compare.tsx", "routes/useColumnsFit.ts", "routes/Shell.tsx", "components/ask/AskSettings.tsx", "components/ask/AskPanel.tsx", "components/SweepControl.tsx", "components/compare/RecipeHead.tsx", "components/compare/ChunkEvidence.tsx", "components/compare/RetrieveEvidence.tsx"]
    for (const f of files) expect(readFileSync(`${__dirname}/../${f}`, "utf8"), f).not.toMatch(/(^|[\s"'`])sm:/m)
  })

  it("has no em-dashes or en-dashes", async () => {
    render(<Compare />)
    await waitFor(() => expect(pressed()).toBe("Chunk"))
    expect(text()).not.toMatch(/[–—]/)
  })
})

describe("Compare's widths", () => {
  it("puts three recipes side by side at 1024, each at least 300 px, with nothing to scroll sideways", async () => {
    FakeResizeObserver.width = 993
    vi.stubGlobal("ResizeObserver", FakeResizeObserver)
    render(<Compare />)
    await waitFor(() => expect(columns()).toHaveLength(3))
    const grid = screen.getByTestId("recipe-grid")
    expect(grid.style.gridTemplateColumns).toBe("repeat(3, minmax(0, 1fr))")
    expect(grid.className).not.toContain("min-w-min")
    expect(screen.queryByRole("group", { name: "Recipe shown" })).toBeNull()
  })

  it("shows one recipe at a time below 820 px, chosen with a segmented control", async () => {
    FakeResizeObserver.width = 753
    vi.stubGlobal("ResizeObserver", FakeResizeObserver)
    render(<Compare />)
    const group = await screen.findByRole("group", { name: "Recipe shown" })
    const options = within(group).getAllByRole("button")
    expect(options).toHaveLength(3)
    expect(options[0].getAttribute("aria-pressed")).toBe("true")
    expect(columns()).toEqual(["recursive_character"])
    fireEvent.click(options[2])
    expect(columns()).toEqual(["sentence_window"])
  })

  it("names each recipe in the control by its short name", async () => {
    FakeResizeObserver.width = 753
    vi.stubGlobal("ResizeObserver", FakeResizeObserver)
    render(<Compare />)
    const group = await screen.findByRole("group", { name: "Recipe shown" })
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["400 characters", "200 characters", "By sentence"])
  })

  it("keeps a recipe shown when the one chosen is removed", async () => {
    FakeResizeObserver.width = 753
    vi.stubGlobal("ResizeObserver", FakeResizeObserver)
    render(<Compare />)
    const group = await screen.findByRole("group", { name: "Recipe shown" })
    fireEvent.click(within(group).getAllByRole("button")[2])
    fireEvent.click(screen.getByRole("button", { name: "Remove this recipe" }))
    expect(columns()).toEqual(["recursive_character"])
    expect(within(screen.getByRole("group", { name: "Recipe shown" })).getAllByRole("button")[1].getAttribute("aria-pressed")).toBe("true")
  })

  it("falls back to one at a time when five recipes do not fit at 1440", async () => {
    FakeResizeObserver.width = 1409
    vi.stubGlobal("ResizeObserver", FakeResizeObserver)
    openAt("?node=index&preset=matryoshka&native=1024")
    render(<Compare />)
    expect(await screen.findByRole("group", { name: "Recipe shown" })).toBeTruthy()
  })
})

describe("Compare's recipes", () => {
  const run = () => fireEvent.click(screen.getByRole("button", { name: "Run 3 recipes" }))

  it("makes each column one region named by its recipe, the node's own tagged Your pipeline", async () => {
    render(<Compare />)
    await waitFor(() => expect(columns()).toHaveLength(3))
    const names = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))
    expect(names).toEqual(["Recursive (natural breaks), 400 characters", "Recursive (natural breaks), 200 characters", "By sentence"])
    expect(within(screen.getByRole("region", { name: names[0]! })).getByText("Your pipeline")).toBeTruthy()
    expect(within(screen.getByRole("region", { name: names[1]! })).queryByText("Your pipeline")).toBeNull()
  })

  it("says recipe, not variant, on its buttons", async () => {
    render(<Compare />)
    await waitFor(() => expect(columns()).toHaveLength(3))
    expect(screen.getByRole("button", { name: "Add a recipe" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Run 3 recipes" })).toBeTruthy()
    expect(screen.getAllByRole("button", { name: "Remove this recipe" })).toHaveLength(3)
    expect(text()).not.toMatch(/variant/i)
  })

  it("names strategies as Build does and gives the fields sentence-case titles", async () => {
    render(<Compare />)
    await waitFor(() => expect(columns()).toHaveLength(3))
    const select = screen.getAllByLabelText("Strategy")[0] as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toContain("Recursive (natural breaks), recursive_character")
    expect(screen.getAllByLabelText("Chunk size")).toHaveLength(2)
    expect(screen.getAllByLabelText("Sentences per piece")).toHaveLength(1)
  })

  it("folds every editor into its recipe sentence once a run starts, and unfolds one on request", async () => {
    render(<Compare />)
    await waitFor(() => expect(columns()).toHaveLength(3))
    run()
    await waitFor(() => expect(columns()).toHaveLength(0))
    const change = screen.getAllByRole("button", { name: "Change this recipe" })
    expect(change).toHaveLength(3)
    fireEvent.click(change[1])
    expect(change[1].getAttribute("aria-expanded")).toBe("true")
    expect(columns()).toEqual(["recursive_character"])
  })

  it("still says a recipe was edited since the last run once its editor is folded again", async () => {
    render(<Compare />)
    await waitFor(() => expect(columns()).toHaveLength(3))
    run()
    await waitFor(() => expect(columns()).toHaveLength(0))
    fireEvent.click(screen.getAllByRole("button", { name: "Change this recipe" })[1])
    fireEvent.change(screen.getByLabelText("Chunk size"), { target: { value: "300" } })
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    expect(columns()).toHaveLength(0)
    const edited = screen.getByRole("region", { name: "Recursive (natural breaks), 300 characters" })
    expect(within(edited).getByText(/Edited since the last run/)).toBeTruthy()
  })
})

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
    serve({ c: recursiveJson, h: hybridJson, d: denseJson, b: bm25Json })
    openAt("?node=retrieve")
    render(<Compare />)
    await waitFor(() => expect(columns()).toHaveLength(3))
    await runWith({ chunk: ["c", "c", "c"], [through]: ["h", "d", "b"] })
    const finding = await screen.findByTestId("compare-finding")
    expect(finding.textContent).not.toMatch(/answer/)
    expect(finding.textContent).toMatch(/Dense|BM25/)
    await waitFor(() => expect(text()).toMatch(/The colours are piece numbers, the same in every column, because all three recipes search the same 6 pieces\./))
    const agreements = screen.getAllByTestId("agreement")
    expect(agreements[0].textContent).toBe("The baseline. The other recipes are read against this list.")
    expect(agreements[0].className).toContain("font-semibold")
    expect(screen.queryByTestId("fact-hits")).toBeNull()
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
