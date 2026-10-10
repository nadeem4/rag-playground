import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiKeyProvider, useApiKey } from "@/api/apiKey"
import liveRegistry from "@/api/fixtures/registry.json"
import hybridResult from "@/api/fixtures/retrieval_result.hybrid_rrf.json"
import searchOutput from "@/api/fixtures/output.search.json"
import { resetSampleQuestionsCache } from "@/api/samples"
import { chooseDocument, loadSampleDocument, resetDocumentForTests } from "@/state/document"
import { addReranker, chatSampleGraph, initialGraph, readStoredGraph, resetStoredGraphForTests, sampleGraph, setConfig, setReranker, setTransform, storeGraph } from "@/state/graph"
import { decodePipeline, encodePipeline, readPipelines, resetPipelinesForTests, savePipeline, setCurrentId } from "@/state/pipelines"
import { TEST_REGISTRY } from "@/state/testRegistry"
import { choose, optionNames, optionOf } from "@/components/ui/pickerTesting"

import { Shell } from "./Shell"

class SilentEventSource {
  onmessage = null
  onerror = null
  onopen = null
  close() {}
}

const SOURCE = { sha: "ab".repeat(32), filename: "report.pdf", size: 2048, content_type: "application/pdf" }

let posts: { path: string; body: unknown }[] = []

beforeEach(() => {
  posts = []
  resetSampleQuestionsCache()
  window.localStorage.clear()
  window.sessionStorage.clear()
  resetStoredGraphForTests()
  resetDocumentForTests()
  resetPipelinesForTests()
  window.history.replaceState(null, "", "/build")
  vi.stubGlobal("EventSource", SilentEventSource)
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
      if (url === "/api/registry") return ok(TEST_REGISTRY)
      if (url === "/api/sources") return ok([SOURCE])
      if (url === "/api/runs" && init?.method === "POST") {
        const body = JSON.parse(String(init.body))
        posts.push({ path: url, body })
        if (body.graph.nodes.find((n: { id: string }) => n.id === "chunk").config.chunk_size === 0) {
          return ok({ detail: { node_id: "chunk", errors: [{ loc: ["chunk_size"], msg: "Input should be greater than or equal to 1" }] } }, 422)
        }
        return ok({ run_id: "r1" }, 202)
      }
      return ok({ detail: "not found" }, 404)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const card = (id: string) => document.querySelector(`[data-node-id="${id}"]`) as HTMLElement

/** Renders Shell on the default pipeline with report.pdf as its document, as the bar would set it. */
async function ready() {
  storeGraph(setConfig(initialGraph(TEST_REGISTRY), "source", { sha: SOURCE.sha, filename: SOURCE.filename }))
  render(<Shell />)
  await waitFor(() => expect(card("parse")).toBeTruthy())
}

/** Renders Shell with the default fetch/EventSource stubs, with nothing selected yet. */
function setup() {
  render(<Shell />)
}

describe("Build page", () => {
  it("Run on a card sends targets for that node and the whole graph", async () => {
    await ready()
    fireEvent.click(within(card("parse")).getByRole("button", { name: "Run" }))
    await waitFor(() => expect(posts).toHaveLength(1))
    const body = posts[0].body as { targets: string[]; force: boolean; graph: { nodes: { id: string; config: unknown }[] } }
    expect(body.targets).toEqual(["parse"])
    expect(body.force).toBe(false)
    expect(body.graph.nodes.find((n) => n.id === "source")!.config).toEqual({ sha: SOURCE.sha, filename: SOURCE.filename })
  })

  it("a 422 from the server lands under the field of the card it names", async () => {
    await ready()
    fireEvent.change(within(card("chunk")).getByLabelText("Chunk Size"), { target: { value: "0" } })
    fireEvent.click(within(card("chunk")).getByRole("button", { name: "Run" }))
    await waitFor(() => expect(within(card("chunk")).getAllByText("Input should be greater than or equal to 1").length).toBeGreaterThan(0))
    expect(within(card("parse")).queryByText(/greater than or equal/)).toBeNull()
  })

  it("Build the index without a document says it needs one, with no red note", async () => {
    const base = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/explain") {
          const body = JSON.parse(String(init?.body))
          const noFile = body.stage === "source" && !body.config.sha
          return new Response(JSON.stringify({ settings: "s", tradeoff: null, warning: noFile ? "Choose a file." : null, blocking: noFile }), {
            status: 200,
          })
        }
        return base(url, init)
      }),
    )
    render(<Shell />)
    const build = await screen.findByRole("button", { name: "Build the index" })
    await waitFor(() => expect(build.getAttribute("title")).toBe("Needs a document."), { timeout: 2000 })
    expect((build as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getAllByText("Needs a document.").length).toBeGreaterThan(0)
    expect(document.querySelector("[data-testid=run-all-blocked]")).toBeNull()
    expect(posts).toHaveLength(0)
  })
})

/** The hybrid result reranked: prior ranks 6, 1, 2, 4, 3. */
function reranked() {
  const order = [5, 0, 1, 3, 2]
  return { ...hybridResult, hits: order.map((i, k) => ({ ...hybridResult.hits[i], rank: k + 1, prior_rank: hybridResult.hits[i].rank })) }
}

/** The Ask panel, docked at the right edge of Build. */
const panel = () => within(screen.getByRole("region", { name: "Ask panel" }))
const CLOSE_ASK = "Close Ask. Your question and results are kept."
const altA = () => fireEvent.keyDown(document, { key: "a", code: "KeyA", altKey: true })

describe("Ask with a chat card and no API key", () => {
  const NO_SERVER_KEYS = { anthropic: "none", openai: "none", custom: "none", openrouter: "none" }
  let settings: Record<string, string>
  let streams: { onmessage: ((m: MessageEvent<string>) => void) | null }[]

  class OpenEventSource {
    onmessage = null
    onerror = null
    onopen = null
    constructor() {
      streams.push(this)
    }
    close() {}
  }

  /** Sends one event over the newest run's stream. */
  function emit(event: Record<string, unknown>, id: string) {
    act(() => streams[streams.length - 1].onmessage!(new MessageEvent("message", { data: JSON.stringify(event), lastEventId: id })))
  }

  /** Ends the run over its event stream, as the server does when it finishes. */
  async function endRun() {
    await waitFor(() => expect(streams.length).toBeGreaterThan(0))
    emit({ event: "stream_end", status: "finished", ok: true }, "9")
  }

  beforeEach(() => {
    settings = NO_SERVER_KEYS
    streams = []
    vi.stubGlobal("EventSource", OpenEventSource)
    const base = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/registry") return new Response(JSON.stringify(liveRegistry), { status: 200 })
        if (url === "/api/samples") return new Response(JSON.stringify([]), { status: 200 })
        if (url === "/api/settings/llm") return new Response(JSON.stringify(settings), { status: 200 })
        if (url === "/api/runs" && init?.method === "POST") {
          posts.push({ path: url, body: JSON.parse(String(init.body)) })
          return new Response(JSON.stringify({ run_id: `r${posts.length}` }), { status: 202 })
        }
        return base(url, init)
      }),
    )
    storeGraph(chatSampleGraph(liveRegistry as never, SOURCE))
  })

  const chatUpstream = () => {
    const g = chatSampleGraph(liveRegistry as never, SOURCE)
    const chat = g.nodes.find((n) => n.stage === "use_case")!
    return g.edges.find((e) => e.dst === chat.id)!.src
  }

  function WithKey() {
    const { setKey } = useApiKey()
    useEffect(() => setKey("anthropic", "sk-ant-FAKE-test-key-0000"), [setKey])
    return null
  }

  /** Builds the index, then presses the panel's Ask. Returns the Ask run's request. */
  async function ask(withKey = false) {
    render(
      <ApiKeyProvider>
        {withKey ? <WithKey /> : null}
        <Shell />
      </ApiKeyProvider>,
    )
    const build = await screen.findByRole("button", { name: "Build the index" })
    // Let the settings answer land before pressing.
    await act(async () => {})
    await waitFor(() => expect((build as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(build)
    await waitFor(() => expect(posts).toHaveLength(1))
    await waitFor(() => expect(streams.length).toBeGreaterThan(0))
    emit({ event: "node_finished", node_id: "index", artifact_id: "idx1", cache_hit: false, duration_ms: 1 }, "1")
    await endRun()
    const button = panel().getByRole("button", { name: "Ask" }) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
    await waitFor(() => expect(posts).toHaveLength(2))
    return posts[1].body as { targets?: string[] }
  }

  it("a keyless Ask stops before Chat, and the notice shows in the panel (Review Focus 3)", async () => {
    const body = await ask()
    expect(body.targets).toEqual([chatUpstream()])
    await waitFor(() => expect(streams).toHaveLength(2))
    await endRun()
    const notice = await waitFor(() => panel().getByTestId("key-notice"))
    expect(notice.textContent!.startsWith("Search results are ready. Add an Anthropic key to get a written answer.")).toBe(true)
    expect(within(notice).getByTestId("key-hint")).toBeTruthy()
  })

  it("the key notice waits until the keyless run has finished", async () => {
    await ask()
    await waitFor(() => expect(streams).toHaveLength(2))
    await act(async () => {})
    expect((panel().getByRole("button", { name: "Asking" }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByTestId("key-notice")).toBeNull()
    await endRun()
    expect(await waitFor(() => panel().getByTestId("key-notice"))).toBeTruthy()
  })

  it("a UI key runs all the way", async () => {
    const body = await ask(true)
    expect(body.targets).toBeUndefined()
    expect(screen.queryByTestId("key-notice")).toBeNull()
  })

  function chatModel(config: Record<string, unknown>) {
    const g = chatSampleGraph(liveRegistry as never, SOURCE)
    const chat = g.nodes.find((n) => n.stage === "use_case")!
    chat.config = config
    storeGraph(g)
  }

  it("a chat set to OpenRouter needs the OpenRouter key: an Anthropic key alone stops before Chat, and the note names it", async () => {
    chatModel({ model: "openrouter", openrouter_model: "openai/gpt-4o-mini" })
    const body = await ask(true)
    expect(body.targets).toEqual([chatUpstream()])
    await waitFor(() => expect(streams).toHaveLength(2))
    await endRun()
    const notice = await waitFor(() => panel().getByTestId("key-notice"))
    expect(notice.textContent!.startsWith("Search results are ready. Add an OpenRouter key to get a written answer.")).toBe(true)
    expect(within(notice).getByTestId("key-hint").textContent).toContain("OpenRouter API key")
  })

  it("a chat config without a model uses the default model's key", async () => {
    settings = { ...NO_SERVER_KEYS, openrouter: "env" }
    chatModel({})
    const body = await ask()
    expect(body.targets).toEqual([chatUpstream()])
    await waitFor(() => expect(streams).toHaveLength(2))
    await endRun()
    expect((await waitFor(() => panel().getByTestId("key-notice"))).textContent).toContain("Add an Anthropic key")
  })

  it("an unknown model id needs some key: with none set anywhere it stops before Chat", async () => {
    chatModel({ model: "mystery-model" })
    const body = await ask()
    expect(body.targets).toEqual([chatUpstream()])
  })

  it("a chat set to OpenRouter runs all the way with a server OpenRouter key", async () => {
    settings = { ...NO_SERVER_KEYS, openrouter: "env" }
    chatModel({ model: "openrouter", openrouter_model: "openai/gpt-4o-mini" })
    const body = await ask()
    expect(body.targets).toBeUndefined()
  })

  it("a server .env key runs all the way", async () => {
    settings = { ...NO_SERVER_KEYS, anthropic: "dotenv" }
    const body = await ask()
    expect(body.targets).toBeUndefined()
    expect(screen.queryByTestId("key-notice")).toBeNull()
  })
})

describe("the Ask panel on Build", () => {
  const withFile = () => setConfig(initialGraph(TEST_REGISTRY), "source", { sha: SOURCE.sha, filename: SOURCE.filename })
  const reranker = () => panel().getByRole("button", { name: /^Reranker/ })
  const picked = () => reranker().getAttribute("data-picked")

  it("a pipeline whose Index has not run asks for the index first, with Ask disabled (Review Focus 5)", async () => {
    storeGraph(withFile())
    setup()
    await waitFor(() => expect(panel().getByTestId("index-status").textContent).toBe("Build the index first."))
    expect((panel().getByRole("button", { name: "Ask" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("a share link with a reranker opens with that reranker in the Rerank block (Review Focus 1)", async () => {
    window.history.replaceState(null, "", `/build?pipeline=${encodePipeline("Reranked", addReranker(withFile(), TEST_REGISTRY))}`)
    setup()
    await waitFor(() => expect(picked()).toBe("mmr"))
  })

  it("a saved pipeline without a reranker opens with None (Review Focus 1)", async () => {
    const saved = savePipeline("Plain", withFile())!.saved
    setCurrentId(saved.id)
    setup()
    await waitFor(() => expect(picked()).toBe(""))
  })

  it("None and a reranker change the graph", async () => {
    storeGraph(withFile())
    setup()
    await waitFor(() => expect(picked()).toBe(""))
    choose(reranker(), "MMR")
    await waitFor(() => expect(storedStages()).toContain("rerank"))
    choose(reranker(), "No reranker")
    await waitFor(() => expect(storedStages()).not.toContain("rerank"))
  })
})

/** The stages of the stored graph. */
function storedStages() {
  const read = JSON.parse(window.localStorage.getItem("rag-playground:graph:v1") ?? "{}") as { nodes?: { stage: string }[] }
  return (read.nodes ?? []).map((n) => n.stage)
}

describe("the main pane", () => {
  it("says to pick a step until a card is clicked, then shows that step's output; there is no Back to Ask", async () => {
    await ready()
    const main = () => within(screen.getByRole("region", { name: "Inspector" }))
    expect(main().getByText("Pick a step")).toBeTruthy()
    expect(main().getByText("Click a step card to see its output here.")).toBeTruthy()
    fireEvent.click(card("chunk"))
    expect(main().getByRole("heading", { name: "Chunk" })).toBeTruthy()
    expect(main().queryByText("Pick a step")).toBeNull()
    expect(screen.queryByRole("button", { name: "Back to Ask" })).toBeNull()
    // The Ask panel is not in the main pane; it is docked beside it, still open.
    expect(main().queryByRole("region", { name: "Ask panel" })).toBeNull()
    expect(screen.getByRole("complementary", { name: "Ask" })).toBeTruthy()
    expect(panel().getByLabelText("Question")).toBeTruthy()
    fireEvent.click(card("parse"))
    expect(main().getByRole("heading", { name: "Parse" })).toBeTruthy()
  })

  it("from lg the dock takes a third column at its remembered width, and the main pane shrinks; closed, the column goes", async () => {
    await ready()
    const main = document.querySelector("main")!
    const tokens = () => main.className.split(/\s+/)
    expect(main.style.getPropertyValue("--ask-w")).toBe("440px")
    // From md the column and the main pane; the third column only from lg, where the dock exists.
    expect(tokens()).toContain("md:grid-cols-[380px_minmax(0,1fr)]")
    expect(tokens()).toContain("lg:grid-cols-[380px_minmax(0,1fr)_minmax(320px,min(var(--ask-w),calc(100%_-_742px)))]")
    expect(tokens().filter((t) => t.startsWith("md:grid-cols-"))).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: CLOSE_ASK }))
    expect(tokens()).toContain("md:grid-cols-[380px_minmax(0,1fr)]")
    expect(tokens().filter((t) => t.startsWith("lg:grid-cols-"))).toEqual([])
  })

  it("while Ask is closed, the main pane's scroll box leaves room at its foot, so the round button never covers its last line", async () => {
    await ready()
    const padded = () => screen.getByTestId("main-scroll").className.split(/\s+/).includes("pb-[72px]")
    // The empty state first, then a step's output.
    expect(padded()).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: CLOSE_ASK }))
    expect(padded()).toBe(true)
    fireEvent.click(card("parse"))
    expect(padded()).toBe(true)
    altA()
    expect(padded()).toBe(false)
  })
})

describe("the page on a phone", () => {
  it("below the md breakpoint the page scrolls as one: no inner box scrolls on its own, outside the Ask sheet", async () => {
    storeGraph(setConfig(initialGraph(TEST_REGISTRY), "source", { sha: SOURCE.sha, filename: SOURCE.filename }))
    setup()
    await waitFor(() => expect(card("parse")).toBeTruthy())
    const main = document.querySelector("main")!
    const tokens = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/)
    expect(tokens(main)).toContain("overflow-y-auto")
    // Inner boxes scroll from md up only (md:overflow-y-auto); below it the page is one scroll.
    // The Ask sheet sits over the page and scrolls its own content.
    const inner = [...main.querySelectorAll("[class]")].filter((el) => tokens(el).includes("overflow-y-auto") && !el.closest("#ask-dock"))
    expect(inner.map((el) => el.getAttribute("class"))).toEqual([])
  })
})

describe("Build the index", () => {
  it("says what it runs in its tooltip when it can run", async () => {
    await ready()
    const build = (await screen.findByRole("button", { name: "Build the index" })) as HTMLButtonElement
    await waitFor(() => expect(build.disabled).toBe(false))
    expect(build.getAttribute("title")).toBe("Runs Document, Parse, Clean, Chunk and Index with their current settings. A step whose settings have not changed is reused.")
  })

  it("sends the Index node as the only target", async () => {
    await ready()
    const button = await screen.findByRole("button", { name: "Build the index" })
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button)
    await waitFor(() => expect(posts).toHaveLength(1))
    expect((posts[0].body as { targets: string[] }).targets).toEqual(["index"])
    expect(screen.getByRole("heading", { name: "Index pipeline" })).toBeTruthy()
    expect(screen.getByText("These five steps build the index. Retrieval, reranking and answering live in the Ask panel.")).toBeTruthy()
  })

  it("says Building, disabled and busy, while its run is in flight", async () => {
    await ready()
    const button = (await screen.findByRole("button", { name: "Build the index" })) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
    const building = (await screen.findByRole("button", { name: "Building" })) as HTMLButtonElement
    expect(building.disabled).toBe(true)
    expect(building.getAttribute("aria-busy")).toBe("true")
    expect(screen.queryByRole("button", { name: "Running" })).toBeNull()
  })

  it("leaves Ask reading Ask, disabled, while the index builds", async () => {
    await ready()
    const button = (await screen.findByRole("button", { name: "Build the index" })) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
    await screen.findByRole("button", { name: "Building" })
    const ask = panel().getByRole("button", { name: "Ask" }) as HTMLButtonElement
    expect(ask.disabled).toBe(true)
    expect(panel().queryByRole("button", { name: "Asking" })).toBeNull()
  })

  it("does not say Building while a single card runs", async () => {
    await ready()
    fireEvent.click(within(card("parse")).getByRole("button", { name: "Run" }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(screen.queryByRole("button", { name: "Building" })).toBeNull()
    expect((screen.getByRole("button", { name: "Build the index" }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe("the run strip", () => {
  let streams: { onmessage: ((m: MessageEvent<string>) => void) | null }[]

  class OpenEventSource {
    onmessage = null
    onerror = null
    onopen = null
    constructor() {
      streams.push(this)
    }
    close() {}
  }

  function emit(event: Record<string, unknown>, id: string) {
    act(() => streams[streams.length - 1].onmessage!(new MessageEvent("message", { data: JSON.stringify(event), lastEventId: id })))
  }

  beforeEach(() => {
    streams = []
    vi.stubGlobal("EventSource", OpenEventSource)
  })

  const line = () => screen.queryByTestId("run-line")?.textContent ?? null

  it("sits above the column, says which step a build is on, then how long it took", async () => {
    await ready()
    const strip = screen.getByTestId("run-strip")
    expect(within(strip).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Document", "Parse", "Chunk", "Index"])
    expect(line()).toBeNull()
    const build = (await screen.findByRole("button", { name: "Build the index" })) as HTMLButtonElement
    await waitFor(() => expect(build.disabled).toBe(false))
    fireEvent.click(build)
    await waitFor(() => expect(streams.length).toBeGreaterThan(0))
    const ts = Date.now() / 1000
    emit({ event: "node_started", node_id: "source", ts }, "1")
    emit({ event: "node_finished", node_id: "source", artifact_id: "s1", cache_hit: true, duration_ms: 400 }, "2")
    emit({ event: "node_started", node_id: "parse", ts }, "3")
    await waitFor(() => expect(line()).toMatch(/^Building: Parse/))
    expect(panel().getByTestId("index-status").textContent).toMatch(/^Building the index: Parse/)
    emit({ event: "node_finished", node_id: "parse", artifact_id: "p1", cache_hit: false, duration_ms: 1000 }, "4")
    emit({ event: "node_started", node_id: "chunk", ts }, "5")
    emit({ event: "node_finished", node_id: "chunk", artifact_id: "c1", cache_hit: false, duration_ms: 1000 }, "6")
    emit({ event: "node_started", node_id: "index", ts }, "7")
    emit({ event: "node_finished", node_id: "index", artifact_id: "i1", cache_hit: false, duration_ms: 1000 }, "8")
    emit({ event: "stream_end", status: "finished", ok: true }, "9")
    await waitFor(() => expect(line()).toBe("Built in 3.4 s"))
  })

  it("a rebuild after editing Chunk: steps show this run's progress, not the last run's look", async () => {
    let n = 0
    const base = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/runs" && init?.method === "POST") {
          await base(url, init)
          n += 1
          return new Response(JSON.stringify({ run_id: `run${n}` }), { status: 202 })
        }
        return base(url, init)
      }),
    )
    await ready()
    const state = (id: string) => (document.querySelector(`[data-testid=run-strip] [data-segment="${id}"]`) as HTMLElement).dataset.state
    const build = (await screen.findByRole("button", { name: "Build the index" })) as HTMLButtonElement
    await waitFor(() => expect(build.disabled).toBe(false))
    fireEvent.click(build)
    await waitFor(() => expect(streams.length).toBe(1))
    const ts = Date.now() / 1000
    ;["source", "parse", "chunk", "index"].forEach((id, i) =>
      emit({ event: "node_finished", node_id: id, artifact_id: `${id}1`, cache_hit: false, duration_ms: 10 }, String(i + 1)),
    )
    emit({ event: "stream_end", status: "finished", ok: true }, "9")
    await waitFor(() => expect(line()).toMatch(/^Built in/))
    expect(state("chunk")).toBe("done")

    fireEvent.change(within(card("chunk")).getByLabelText("Chunk Size"), { target: { value: "300" } })
    await waitFor(() => expect(state("chunk")).toBe("stale"))
    fireEvent.click(screen.getByRole("button", { name: "Build the index" }))
    await waitFor(() => expect(streams.length).toBe(2))
    // Nothing reported yet: every step of this run is still to go.
    for (const id of ["source", "parse", "chunk", "index"]) expect(state(id)).toBe("todo")
    emit({ event: "node_started", node_id: "parse", ts }, "1")
    emit({ event: "node_finished", node_id: "parse", artifact_id: "parse1", cache_hit: true, duration_ms: 1 }, "2")
    expect(state("parse")).toBe("reused")
    expect(state("chunk")).toBe("todo")
    expect(state("index")).toBe("todo")
    emit({ event: "node_started", node_id: "chunk", ts }, "3")
    expect(state("chunk")).toBe("running")
    expect(state("index")).toBe("todo")
  })

  it("a card's own Run says Running and that step", async () => {
    await ready()
    fireEvent.click(within(card("parse")).getByRole("button", { name: "Run" }))
    await waitFor(() => expect(streams.length).toBeGreaterThan(0))
    emit({ event: "node_started", node_id: "parse", ts: Date.now() / 1000 }, "1")
    await waitFor(() => expect(line()).toMatch(/^Running Parse/))
  })

  it("names a failed step after the build stops", async () => {
    await ready()
    const build = (await screen.findByRole("button", { name: "Build the index" })) as HTMLButtonElement
    await waitFor(() => expect(build.disabled).toBe(false))
    fireEvent.click(build)
    await waitFor(() => expect(streams.length).toBeGreaterThan(0))
    emit({ event: "node_started", node_id: "parse", ts: Date.now() / 1000 }, "1")
    emit({ event: "node_failed", node_id: "parse", error: "boom" }, "2")
    emit({ event: "stream_end", status: "finished", ok: false }, "3")
    await waitFor(() => expect(line()).toBe("Parse failed"))
  })
})

describe("Build the index is blocked only by its own steps", () => {
  function stubBlocking(stage: string) {
    const base = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/explain") {
          const body = JSON.parse(String(init?.body))
          const bad = body.stage === stage
          return new Response(JSON.stringify({ settings: "s", tradeoff: null, warning: bad ? "No." : null, blocking: bad }), { status: 200 })
        }
        return base(url, init)
      }),
    )
  }

  it("a blocking explanation on a hidden ask-stage node leaves the button enabled", async () => {
    stubBlocking("retrieve")
    await ready()
    const button = await screen.findByRole("button", { name: "Build the index" })
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    await act(async () => {})
    expect((button as HTMLButtonElement).disabled).toBe(false)
    expect(document.querySelector("[data-testid=run-all-blocked]")).toBeNull()
  })

  it("a blocking explanation on Parse disables it with the reason", async () => {
    stubBlocking("parse")
    await ready()
    await waitFor(() => expect(document.querySelector("[data-testid=run-all-blocked]")?.textContent).toBe("Fix the Parse settings to run the pipeline."), { timeout: 2000 })
    expect((screen.getByRole("button", { name: "Build the index" }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe("Build page explanations", () => {
  it("a blocking explanation disables Build the index with a visible reason, as the user types", async () => {
    const base = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/explain") {
          const body = JSON.parse(String(init?.body))
          const bad = body.stage === "chunk" && body.config.chunk_overlap >= body.config.chunk_size
          return new Response(
            JSON.stringify({
              settings: "s",
              tradeoff: null,
              warning: bad ? "Overlap must be smaller than the chunk size." : null,
              blocking: bad,
            }),
            { status: 200 },
          )
        }
        return base(url, init)
      }),
    )
    await ready()
    const build = () => document.querySelector("section[aria-label=Pipeline]")!.querySelector("button:not([aria-label])") as HTMLButtonElement
    expect(build().textContent).toBe("Build the index")
    await waitFor(() => expect(build().disabled).toBe(false))
    fireEvent.change(within(card("chunk")).getByLabelText("Chunk Overlap"), { target: { value: "5000" } })
    await waitFor(() => expect(within(card("chunk")).getByTestId("explain-warning").textContent).toBe("Overlap must be smaller than the chunk size."), {
      timeout: 2000,
    })
    expect(build().disabled).toBe(true)
    expect(document.querySelector("[data-testid=run-all-blocked]")!.textContent).toBe("Fix the Chunk settings to run the pipeline.")
    fireEvent.click(within(card("chunk")).getByRole("button", { name: "Run" }))
    expect(posts).toHaveLength(0)
  })
})

describe("First run (plan I-15)", () => {
  const SAMPLE = { sha: "cd".repeat(32), filename: "chunking-primer.pdf", size: 4096, content_type: "application/pdf" }
  const SAMPLE_CARD = {
    name: "chunking-primer",
    title: "A primer on chunking",
    blurb: "Three pages of notes on chunking.",
    shows: "Headings, a footer and a repeated paragraph.",
    stresses: "chunk",
    pages: 3,
    default: true,
    filename: SAMPLE.filename,
    sha: SAMPLE.sha,
    question: "Why do chunk boundaries matter?",
  }
  let sampleCalls = 0
  let sourceExplains = 0
  let sampleReply: () => Promise<Response>

  beforeEach(() => {
    sampleCalls = 0
    sourceExplains = 0
    sampleReply = async () => new Response(JSON.stringify(SAMPLE), { status: 201 })
    const base = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/registry") return new Response(JSON.stringify(liveRegistry), { status: 200 })
        if (url === "/api/sources") return new Response(JSON.stringify(sampleCalls ? [SAMPLE] : []), { status: 200 })
        if (url === "/api/samples") return new Response(JSON.stringify([SAMPLE_CARD]), { status: 200 })
        if (url === "/api/explain") {
          const body = JSON.parse(String(init?.body))
          const noFile = body.stage === "source" && !body.config.sha
          if (noFile) sourceExplains += 1
          return new Response(JSON.stringify({ settings: "s", tradeoff: null, warning: noFile ? "Choose a file." : null, blocking: noFile }), { status: 200 })
        }
        if (url === "/api/sources/sample" && init?.method === "POST") {
          sampleCalls += 1
          return sampleReply()
        }
        return base(url, init)
      }),
    )
  })

  const found = <T extends Element>(sel: string) =>
    waitFor(() => {
      const el = document.querySelector(sel)
      if (!el) throw new Error(`no ${sel}`)
      return el as unknown as T
    })
  const sampleButton = () => found<HTMLButtonElement>('[aria-label="Document"] li button')

  it("shows when no source is selected and nothing is uploaded", async () => {
    render(<Shell />)
    expect((await sampleButton()).textContent).toBe("Load")
    // The Ask panel's status line carries the first-run guidance; no empty state sits above it.
    expect(panel().getByTestId("index-status").textContent).toBe("Pick a document in the bar above, then build the index.")
    expect(document.body.textContent).not.toContain("Nothing to show yet")
    expect(document.body.textContent).not.toContain("Run all")
    expect(card("parse")).toBeNull()
    // The empty Load card blocks the run, but a first visit is not an error.
    await waitFor(() => expect(sourceExplains).toBeGreaterThan(0), { timeout: 2000 })
    await new Promise((r) => setTimeout(r, 50))
    expect(document.querySelector("[data-testid=run-all-blocked]")).toBeNull()
  })

  it("still shows when files are already uploaded, and points to the bar for them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        new Response(JSON.stringify(url === "/api/registry" ? liveRegistry : url === "/api/sources" ? [SOURCE] : url === "/api/samples" ? [] : {}), {
          status: 200,
        }),
      ),
    )
    render(<Shell />)
    const upload = await found<HTMLElement>('[aria-label="Document"]')
    expect(panel().getByTestId("index-status").textContent).toBe("Pick a document in the bar above, then build the index.")
    expect(card("parse")).toBeNull()
    expect(upload.textContent).toContain("Or pick one in the bar above.")
    expect(within(upload).getByRole("button", { name: "Upload a PDF" })).toBeTruthy()
  })

  it("does not show when the stored graph already has a source", async () => {
    window.localStorage.setItem(
      "rag-playground:graph:v1",
      JSON.stringify({ nodes: [{ id: "source", stage: "source", transform: "upload", config: { sha: SOURCE.sha, filename: "x.pdf" } }], edges: [] }),
    )
    render(<Shell />)
    await waitFor(() => expect(card("parse")).toBeTruthy())
    expect(document.querySelector('[aria-label="Document"]')).toBeNull()
  })

  it("the sample loads the source and sets the default graph, without running anything", async () => {
    render(<Shell />)
    fireEvent.click(await sampleButton())
    await waitFor(() => expect(card("parse")).toBeTruthy())
    expect(sampleCalls).toBe(1)
    const stored = JSON.parse(window.localStorage.getItem("rag-playground:graph:v1")!) as { nodes: { id: string; stage: string; transform: string; config: Record<string, unknown> }[] }
    const ids = [...document.querySelectorAll("[data-node-id]")].map((el) => el.getAttribute("data-node-id"))
    const byId = new Map(stored.nodes.map((n) => [n.id, n]))
    expect(ids.map((id) => [byId.get(id!)!.stage, byId.get(id!)!.transform])).toEqual([
      ["source", "upload"],
      ["parse", "docling"],
      ["clean", "dedupe_blocks"],
      ["chunk", "recursive_character"],
      ["index", "lancedb"],
    ])
    expect(byId.get("source")!.config).toEqual({ sha: SAMPLE.sha, filename: SAMPLE.filename })
    expect(byId.get("index")!.config.embedder).toBe("qwen3-embedding-0.6b")
    expect(byId.get("query")!.config.text).toBe("Why do chunk boundaries matter?")
    expect(posts).toHaveLength(0)
    expect(panel().getByTestId("index-status").textContent).toBe("Build the index first.")
    expect(document.body.textContent).not.toContain("Ready to run")
    expect(document.body.textContent).not.toContain("Ask card")
  })

  it("after a sample loads, the column starts at the top: a fresh scroll box, not the first-visit card's", async () => {
    render(<Shell />)
    const btn = await sampleButton()
    const box = document.querySelector('[data-testid="pipeline-scroll"]')
    expect(box).toBeTruthy()
    fireEvent.click(btn)
    await waitFor(() => expect(card("parse")).toBeTruthy())
    expect(document.querySelector('[data-testid="pipeline-scroll"]')).not.toBe(box)
  })

  it("shows a pending state while the sample loads", async () => {
    let release!: () => void
    sampleReply = () => new Promise((resolve) => (release = () => resolve(new Response(JSON.stringify(SAMPLE), { status: 201 }))))
    render(<Shell />)
    const btn = await sampleButton()
    fireEvent.click(btn)
    await waitFor(() => expect(btn.disabled).toBe(true))
    expect(btn.textContent).toBe("Loading")
    release()
    await waitFor(() => expect(card("parse")).toBeTruthy())
  })

  it("a failure is shown inline and the screen stays", async () => {
    sampleReply = async () => new Response(JSON.stringify({ detail: "sample missing" }), { status: 500 })
    render(<Shell />)
    fireEvent.click(await sampleButton())
    const alert = await found<HTMLElement>("[data-testid=sample-error]")
    expect(alert.getAttribute("role")).toBe("alert")
    expect(alert.textContent).toContain("sample missing")
    expect((await sampleButton()).disabled).toBe(false)
    expect(card("parse")).toBeNull()
  })
})

/** The question text in the stored graph. The Ask panel shows it from Task 3. */
function storedQuestion() {
  const read = JSON.parse(window.localStorage.getItem("rag-playground:graph:v1") ?? "{}") as { nodes?: { stage: string; config: { text?: string } }[] }
  return read.nodes?.find((n) => n.stage === "query")?.config.text
}

describe("picking a sample in the bar", () => {
  const TWO_COL = { sha: "11".repeat(32), filename: "two-column-report.pdf", size: 8192, content_type: "application/pdf" }
  const CARD = {
    name: "two-column-report",
    title: "A two-column report",
    blurb: "b",
    shows: "s",
    stresses: "parse",
    pages: 2,
    default: false,
    filename: TWO_COL.filename,
    sha: TWO_COL.sha,
    question: "How long did the survey run?",
  }
  let sampled: string[] = []

  beforeEach(() => {
    sampled = []
    const base = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/samples") return new Response(JSON.stringify([CARD]), { status: 200 })
        if (url === "/api/sources/sample" && init?.method === "POST") {
          sampled.push(JSON.parse(String(init.body)).name)
          return new Response(JSON.stringify(TWO_COL), { status: 201 })
        }
        return base(url, init)
      }),
    )
  })

  it("changes only the file and the question, keeping every other setting", async () => {
    let g = setConfig(initialGraph(TEST_REGISTRY), "source", { sha: SOURCE.sha, filename: SOURCE.filename })
    const chunk = g.nodes.find((n) => n.id === "chunk")!
    g = setConfig(g, "chunk", { ...chunk.config, chunk_size: 321 })
    g = setConfig(g, "query", { text: "old question" })
    storeGraph(g)
    render(<Shell />)
    await waitFor(() => expect(card("source")).toBeTruthy())
    await act(() => loadSampleDocument(CARD))
    await waitFor(() => expect(storedQuestion()).toBe("How long did the survey run?"))
    expect(sampled).toEqual(["two-column-report"])
    type Stored = { nodes: { id: string; config: Record<string, unknown> }[] }
    // The graph reaches storage through a passive effect, so wait for it.
    const stored = await waitFor(() => {
      const read = JSON.parse(window.localStorage.getItem("rag-playground:graph:v1")!) as Stored
      expect(read.nodes.find((n) => n.id === "source")?.config).toEqual({ sha: TWO_COL.sha, filename: TWO_COL.filename })
      return read
    })
    const byId = new Map(stored.nodes.map((n) => [n.id, n.config]))
    expect(byId.get("chunk")).toEqual({ ...chunk.config, chunk_size: 321 })
    expect(stored.nodes.map((n) => n.id)).toEqual(g.nodes.map((n) => n.id))
    expect(card("source").textContent).toContain("two-column-report.pdf. Change it in the bar above.")
    expect((panel().getByLabelText("Question") as HTMLTextAreaElement).value).toBe("How long did the survey run?")
  })

  it("a field error on the question shows in the panel and clears as the question is typed", async () => {
    const base = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/runs" && init?.method === "POST") {
          return new Response(JSON.stringify({ detail: { node_id: "query", errors: [{ loc: ["text"], msg: "Text is required" }] } }), { status: 422 })
        }
        return base(url, init)
      }),
    )
    storeGraph(setConfig(initialGraph(TEST_REGISTRY), "source", { sha: SOURCE.sha, filename: SOURCE.filename }))
    render(<Shell />)
    await waitFor(() => expect(card("parse")).toBeTruthy())
    fireEvent.click(within(card("parse")).getByRole("button", { name: "Run" }))
    await waitFor(() => expect(panel().getAllByText("Text is required").length).toBeGreaterThan(0))
    fireEvent.change(panel().getByLabelText("Question"), { target: { value: "What is a chunk?" } })
    await waitFor(() => expect((panel().getByLabelText("Question") as HTMLTextAreaElement).value).toBe("What is a chunk?"))
    expect(panel().queryByText("Text is required")).toBeNull()
  })
})

describe("saved pipelines on Build", () => {
  // A pipeline with no file shows the first-visit card, so these start with one.
  const withFile = () => setConfig(initialGraph(TEST_REGISTRY), "source", { sha: SOURCE.sha, filename: SOURCE.filename })
  const bar = () => screen.getByRole("group", { name: "Saved pipelines" })
  const picker = () => within(bar()).getByRole("button", { name: /^Pipeline/ })
  const picked = () => picker().getAttribute("data-picked")
  const pickedName = () => picker().firstElementChild?.textContent
  const chunkPicker = () => within(card("chunk")).getByRole("button", { name: /^Transform/ })
  const chunkTransform = () => chunkPicker().getAttribute("data-picked")

  it("starts on the working copy with nothing saved", async () => {
    setup()
    await screen.findByRole("group", { name: "Saved pipelines" })
    expect(optionNames(picker())).toEqual(["Working copy"])
    expect(within(bar()).queryByRole("button", { name: "Save changes" })).toBeNull()
  })

  it("Save as names the working copy, selects it, and refuses an empty name", async () => {
    setup()
    await screen.findByRole("group", { name: "Saved pipelines" })
    fireEvent.click(within(bar()).getByRole("button", { name: "Save as" }))
    fireEvent.click(within(bar()).getByRole("button", { name: "Save" }))
    expect(within(bar()).getByText("Give the pipeline a name.")).toBeTruthy()
    fireEvent.change(within(bar()).getByRole("textbox", { name: "Pipeline name" }), { target: { value: "Recursive chunks" } })
    fireEvent.click(within(bar()).getByRole("button", { name: "Save" }))
    expect(optionNames(picker())).toEqual(["Working copy", "Recursive chunks"])
    expect(pickedName()).toBe("Recursive chunks")
    expect(readPipelines()[0].name).toBe("Recursive chunks")
  })

  it("switching pipelines loads the saved graph, editing shows edited, and Save changes writes it back", async () => {
    const saved = savePipeline("Token chunks", setTransform(withFile(), "chunk", "token_based", TEST_REGISTRY))!.saved
    setCurrentId(null)
    storeGraph(withFile())
    setup()
    await screen.findByRole("group", { name: "Saved pipelines" })
    expect(chunkTransform()).toBe("recursive_character")
    choose(picker(), "Token chunks")
    expect(picked()).toBe(saved.id)
    expect(chunkTransform()).toBe("token_based")
    expect(within(bar()).queryByText("edited")).toBeNull()
    choose(chunkPicker(), "By heading")
    expect(within(bar()).getByText("edited")).toBeTruthy()
    expect(optionOf(picker(), "Token chunks").textContent).toContain("Edited since saved")
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" })
    expect(readPipelines()[0].graph.nodes.find((n) => n.stage === "chunk")?.transform).toBe("token_based")
    fireEvent.click(within(bar()).getByRole("button", { name: "Save changes" }))
    expect(within(bar()).queryByText("edited")).toBeNull()
    expect(readPipelines()[0].graph.nodes.find((n) => n.stage === "chunk")?.transform).toBe("markdown_header")
  })

  it("Delete returns to the working copy and keeps the graph on screen", async () => {
    const saved = savePipeline("Token chunks", setTransform(withFile(), "chunk", "token_based", TEST_REGISTRY))!.saved
    setup()
    await screen.findByRole("group", { name: "Saved pipelines" })
    expect(picked()).toBe(saved.id)
    fireEvent.click(within(bar()).getByRole("button", { name: "Delete" }))
    expect(picked()).toBe("")
    expect(optionNames(picker())).toEqual(["Working copy"])
    expect(chunkTransform()).toBe("token_based")
  })

  it("Rename changes the name in place", async () => {
    const saved = savePipeline("Old", withFile())!.saved
    setup()
    await screen.findByRole("group", { name: "Saved pipelines" })
    fireEvent.click(within(bar()).getByRole("button", { name: "Rename" }))
    fireEvent.change(within(bar()).getByRole("textbox", { name: "Pipeline name" }), { target: { value: "New" } })
    fireEvent.click(within(bar()).getByRole("button", { name: "Save" }))
    expect(readPipelines().find((p) => p.id === saved.id)?.name).toBe("New")
    expect(pickedName()).toBe("New")
  })

  it("Copy link puts the share URL on the clipboard and says so", async () => {
    const saved = savePipeline("Token chunks", setTransform(withFile(), "chunk", "token_based", TEST_REGISTRY))!.saved
    const writeText = vi.fn(async (_url: string) => {})
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } })
    setup()
    await screen.findByRole("group", { name: "Saved pipelines" })
    fireEvent.click(within(bar()).getByRole("button", { name: "Copy link" }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const url = new URL(writeText.mock.calls[0][0] as string)
    expect(url.pathname).toBe("/build")
    expect(decodePipeline(url.searchParams.get("pipeline")!, TEST_REGISTRY)).toEqual({ name: "Token chunks", graph: saved.graph })
    expect(await within(bar()).findByText("Link copied")).toBeTruthy()
  })

  it("opening a share link saves, selects and loads the pipeline, and strips the parameter", async () => {
    const graph = setTransform(withFile(), "chunk", "token_based", TEST_REGISTRY)
    window.history.replaceState(null, "", `/build?pipeline=${encodePipeline("From a friend", graph)}`)
    setup()
    await screen.findByRole("group", { name: "Saved pipelines" })
    await waitFor(() => expect(readPipelines()).toHaveLength(1))
    expect(readPipelines()[0].name).toBe("From a friend")
    expect(pickedName()).toBe("From a friend")
    expect(chunkTransform()).toBe("token_based")
    expect(window.location.search).toBe("")
  })

  it("a step link from Evaluate opens that card, and strips the parameter", async () => {
    window.history.replaceState(null, "", "/build?step=parse")
    await ready()
    await waitFor(() => expect(card("parse").getAttribute("aria-current")).toBe("true"))
    expect(window.location.search).toBe("")
  })

  it("a step link to a card that is not there opens nothing", async () => {
    window.history.replaceState(null, "", "/build?step=nowhere")
    await ready()
    expect(document.querySelector('[aria-current="true"][data-node-id]')).toBeNull()
    expect(window.location.search).toBe("")
  })

  it("a bad share link is refused with one line and the page stays as it was", async () => {
    window.history.replaceState(null, "", "/build?pipeline=not-a-pipeline")
    storeGraph(withFile())
    setup()
    await screen.findByRole("group", { name: "Saved pipelines" })
    expect(within(bar()).getByText("This pipeline link could not be read.")).toBeTruthy()
    expect(readPipelines()).toEqual([])
    expect(chunkTransform()).toBe("recursive_character")
  })

  it("says which document a pipeline needs when this browser does not have it", async () => {
    const graph = withFile()
    const src = graph.nodes.find((n) => n.stage === "source")!
    const foreign = setConfig(graph, src.id, { sha: "ef".repeat(32), filename: "report.pdf" })
    storeGraph(foreign)
    setup()
    await waitFor(() =>
      expect(screen.getByTestId("document-note").textContent).toContain(
        "report.pdf is missing. Pick a document in the bar above to build the index.",
      ),
    )
  })
  const blockWrites = () =>
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
  const fill = (n: number) => {
    for (let i = 1; i <= n; i++) savePipeline(`P${i}`, withFile())
  }
  const DROPPED = "Saved. P1, the oldest pipeline, was removed to keep 20."

  it("Save as says which pipeline was dropped to keep twenty (I3)", async () => {
    fill(20)
    setup()
    await screen.findByRole("group", { name: "Saved pipelines" })
    fireEvent.click(within(bar()).getByRole("button", { name: "Save as" }))
    fireEvent.change(within(bar()).getByRole("textbox", { name: "Pipeline name" }), { target: { value: "One more" } })
    fireEvent.click(within(bar()).getByRole("button", { name: "Save" }))
    expect(within(bar()).getByText(DROPPED)).toBeTruthy()
  })

  it("a share link says which pipeline was dropped to keep twenty (I3)", async () => {
    fill(20)
    window.history.replaceState(null, "", `/build?pipeline=${encodePipeline("From a friend", withFile())}`)
    setup()
    expect(await within(await screen.findByRole("group", { name: "Saved pipelines" })).findByText(DROPPED)).toBeTruthy()
  })

  it("a share link with an overlong name is saved under the first 60 characters (M2)", async () => {
    window.history.replaceState(null, "", `/build?pipeline=${encodePipeline(`  ${"x".repeat(70)}  `, withFile())}`)
    setup()
    await screen.findByRole("group", { name: "Saved pipelines" })
    await waitFor(() => expect(readPipelines()).toHaveLength(1))
    expect(readPipelines()[0].name).toBe("x".repeat(60))
    expect(pickedName()).toBe("x".repeat(60))
  })

  it("a share link that cannot be saved loads as the working copy, never over the current pipeline (M2)", async () => {
    savePipeline("Mine", withFile())
    const graph = setTransform(withFile(), "chunk", "token_based", TEST_REGISTRY)
    window.history.replaceState(null, "", `/build?pipeline=${encodePipeline("From a friend", graph)}`)
    blockWrites()
    setup()
    await screen.findByRole("group", { name: "Saved pipelines" })
    expect(within(bar()).getByText("The shared pipeline could not be saved in this browser. It is loaded as the working copy.")).toBeTruthy()
    expect(picked()).toBe("")
    expect(chunkTransform()).toBe("token_based")
  })

  it("says so when storage refuses Save as or Save changes (M3)", async () => {
    savePipeline("Mine", withFile())
    setup()
    await screen.findByRole("group", { name: "Saved pipelines" })
    blockWrites()
    fireEvent.click(within(bar()).getByRole("button", { name: "Save as" }))
    fireEvent.change(within(bar()).getByRole("textbox", { name: "Pipeline name" }), { target: { value: "Another" } })
    fireEvent.click(within(bar()).getByRole("button", { name: "Save" }))
    expect(within(bar()).getByText("The pipeline could not be saved in this browser.")).toBeTruthy()
    fireEvent.click(within(bar()).getByRole("button", { name: "Cancel" }))
    choose(chunkPicker(), "Fixed token count")
    fireEvent.click(within(bar()).getByRole("button", { name: "Save changes" }))
    expect(within(bar()).getByText("The pipeline could not be saved in this browser.")).toBeTruthy()
  })

  it("Copy link waits for Save changes while the pipeline is edited (M6)", async () => {
    savePipeline("Mine", withFile())
    setup()
    await screen.findByRole("group", { name: "Saved pipelines" })
    expect((within(bar()).getByRole("button", { name: "Copy link" }) as HTMLButtonElement).disabled).toBe(false)
    choose(chunkPicker(), "Fixed token count")
    const copy = within(bar()).getByRole("button", { name: "Copy link" }) as HTMLButtonElement
    expect(copy.disabled).toBe(true)
    expect(copy.title).toBe("Save changes first")
  })

  it("switching pipelines closes an open name box (M5)", async () => {
    savePipeline("A", withFile())
    savePipeline("B", withFile())
    setup()
    await screen.findByRole("group", { name: "Saved pipelines" })
    fireEvent.click(within(bar()).getByRole("button", { name: "Rename" }))
    expect(within(bar()).getByRole("textbox", { name: "Pipeline name" })).toBeTruthy()
    choose(picker(), "A")
    expect(within(bar()).queryByRole("textbox", { name: "Pipeline name" })).toBeNull()
  })

  it("lists a saved pipeline this server cannot run as not usable, and it cannot be chosen (M7)", async () => {
    const graph = withFile()
    const foreign = { ...graph, nodes: graph.nodes.map((n) => (n.stage === "chunk" ? { ...n, transform: "semantic" } : n)) }
    savePipeline("Semantic", foreign)
    setCurrentId(null)
    setup()
    await screen.findByRole("group", { name: "Saved pipelines" })
    const option = optionOf(picker(), "Semantic")
    expect(option.textContent).toContain("Cannot run")
    expect(option.getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(option)
    expect(picked()).toBe("")
  })

  describe("the missing document notice while samples load (M1)", () => {
    // Every reader of the samples list (the bar's store, the Ask panel) waits on its own request; settle answers them all.
    // A request made after the answer gets the same answer.
    let pending: { resolve: (r: Response) => void; reject: (e: Error) => void }[] = []
    let answered: ((p: (typeof pending)[number]) => void) | null = null
    const settle = {
      resolve: (r: Response) => {
        answered = (p) => p.resolve(r.clone())
        pending.splice(0).forEach(answered)
      },
      reject: (e: Error) => {
        answered = (p) => p.reject(e)
        pending.splice(0).forEach(answered)
      },
    }
    const SAMPLE_SHA = "cd".repeat(32)

    beforeEach(() => {
      pending = []
      answered = null
      const base = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init?: RequestInit) =>
          url === "/api/samples" ? new Promise<Response>((resolve, reject) => (answered ? answered({ resolve, reject }) : pending.push({ resolve, reject }))) : base(url, init),
        ),
      )
    })

    const stored = (sha: string) => {
      const graph = withFile()
      const src = graph.nodes.find((n) => n.stage === "source")!
      storeGraph(setConfig(graph, src.id, { sha, filename: "chunking-primer.pdf" }))
    }
    const notice = () => screen.queryByTestId("document-note")
    const sample = { name: "chunking-primer", sha: SAMPLE_SHA, filename: "chunking-primer.pdf" }

    it("shows nothing until samples answer, and nothing for a sample once they do", async () => {
      stored(SAMPLE_SHA)
      setup()
      await screen.findByRole("group", { name: "Saved pipelines" })
      await act(async () => {})
      expect(notice()).toBeNull()
      await act(async () => settle.resolve(new Response(JSON.stringify([sample]), { status: 200 })))
      expect(notice()).toBeNull()
    })

    it("shows the notice for an unknown document once samples fail", async () => {
      stored("ef".repeat(32))
      setup()
      await screen.findByRole("group", { name: "Saved pipelines" })
      await act(async () => {})
      expect(notice()).toBeNull()
      await act(async () => settle.reject(new Error("down")))
      await waitFor(() => expect(notice()).toBeTruthy())
    })

    const cardWarning = () => card("source")?.querySelector("[data-testid=missing-file]") ?? null

    it("the collapsed Document card warns that the file is missing, and the column note reads as a warning", async () => {
      stored("ef".repeat(32))
      setup()
      await screen.findByRole("group", { name: "Saved pipelines" })
      await act(async () => settle.reject(new Error("down")))
      const warning = await waitFor(() => {
        const w = cardWarning()
        expect(w).toBeTruthy()
        return w as HTMLElement
      })
      expect(card("source").getAttribute("aria-current")).toBeNull()
      expect(warning.getAttribute("role")).toBe("status")
      expect(warning.textContent).toBe("Missing. Pick a document in the bar above.")
      expect(warning.className).toContain("text-stale")
      expect(warning.className).toContain("bg-stale-wash")
      expect(notice()!.className).toContain("text-stale")
      expect(notice()!.className).toContain("bg-stale-wash")
      expect(notice()!.className).not.toContain("text-fg-muted")
    })

    it("the Document card shows no warning while the lists are still loading", async () => {
      stored("ef".repeat(32))
      setup()
      await screen.findByRole("group", { name: "Saved pipelines" })
      await act(async () => {})
      expect(card("source")).toBeTruthy()
      expect(cardWarning()).toBeNull()
    })

    it("the Document card shows no warning when the file is present", async () => {
      stored(SAMPLE_SHA)
      setup()
      await screen.findByRole("group", { name: "Saved pipelines" })
      await act(async () => settle.resolve(new Response(JSON.stringify([sample]), { status: 200 })))
      await act(async () => {})
      expect(card("source")).toBeTruthy()
      expect(cardWarning()).toBeNull()
    })
  })

  it("a file uploaded just now is never flagged as missing", async () => {
    const fresh = { sha: "12".repeat(32), filename: "my-notes.pdf", size: 7451, content_type: "application/pdf" }
    const base = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) =>
        url === "/api/sources" && init?.method === "POST" ? Promise.resolve(new Response(JSON.stringify(fresh), { status: 201 })) : base(url, init),
      ),
    )
    setup()
    const upload = await screen.findByLabelText("Upload a PDF file")
    await act(async () => {
      fireEvent.change(upload, { target: { files: [new File(["%PDF-1.4"], "my-notes.pdf", { type: "application/pdf" })] } })
    })
    await waitFor(() => expect(card("parse")).toBeTruthy())
    await act(async () => {})
    expect(screen.queryByTestId("document-note")).toBeNull()
    expect(card("source").querySelector("[data-testid=missing-file]")).toBeNull()
  })

  describe("a run refused before it starts", () => {
    let refuse = true

    beforeEach(() => {
      refuse = true
      const base = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init?: RequestInit) => {
          if (url === "/api/runs" && init?.method === "POST" && refuse) {
            return Promise.resolve(new Response(JSON.stringify({ detail: "The document is not on this server." }), { status: 400 }))
          }
          return base(url, init)
        }),
      )
    })

    it("shows in the run strip as well as above the cards, and clears when the next run starts", async () => {
      await ready()
      const build = screen.getByRole("button", { name: "Build the index" }) as HTMLButtonElement
      await waitFor(() => expect(build.disabled).toBe(false))
      fireEvent.click(build)
      await waitFor(() => expect(screen.getByText("The pipeline cannot run")).toBeTruthy())
      const line = within(screen.getByTestId("run-strip")).getByTestId("run-line")
      expect(line.textContent).toBe("Could not start. See the note above the cards.")
      expect(line.className).toContain("text-danger")
      refuse = false
      fireEvent.click(build)
      await waitFor(() => expect(screen.queryByText("The pipeline cannot run")).toBeNull())
      expect(within(screen.getByTestId("run-strip")).queryByText("Could not start. See the note above the cards.")).toBeNull()
    })
  })
})

describe("lock states behind a Clean step", () => {
  it("Docling's headings reach Chunk through Clean, so Markdown header does not fall back", async () => {
    const base = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/registry") return new Response(JSON.stringify(liveRegistry), { status: 200 })
        if (url === "/api/samples") return new Response(JSON.stringify([]), { status: 200 })
        return base(url, init)
      }),
    )
    // Upload -> Docling -> dedupe_blocks -> recursive_character, as the owner shared it.
    storeGraph(sampleGraph(liveRegistry as never, SOURCE))
    render(<Shell />)
    await waitFor(() => expect(card("chunk")).toBeTruthy())
    const option = optionOf(within(card("chunk")).getByRole("button", { name: /^Transform/ }), "By heading")
    expect(option.textContent).toContain("markdown_header")
    expect(option.textContent).not.toContain("Falls back")
  })

  it("the Docling card shows its content layers as five checkboxes", async () => {
    const base = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/registry") return new Response(JSON.stringify(liveRegistry), { status: 200 })
        if (url === "/api/samples") return new Response(JSON.stringify([]), { status: 200 })
        return base(url, init)
      }),
    )
    const g = sampleGraph(liveRegistry as never, SOURCE)
    const parse = g.nodes.find((n) => n.stage === "parse")!
    storeGraph(setTransform(g, parse.id, "docling", liveRegistry as never))
    render(<Shell />)
    await waitFor(() => expect(card("parse")).toBeTruthy())
    const group = await waitFor(() => within(card("parse")).getByRole("group", { name: "Content layers" }))
    expect(within(group).getAllByRole("checkbox")).toHaveLength(5)
    expect((within(group).getByLabelText("body") as HTMLInputElement).checked).toBe(true)
  })

  it.each([
    ["pdfium", true],
    ["docling", false],
  ])("with Parse set to %s, By layout block falls back: %s; By sentence never does", async (parser, fallsBack) => {
    const base = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/registry") return new Response(JSON.stringify(liveRegistry), { status: 200 })
        if (url === "/api/samples") return new Response(JSON.stringify([]), { status: 200 })
        return base(url, init)
      }),
    )
    const g = sampleGraph(liveRegistry as never, SOURCE)
    const parse = g.nodes.find((n) => n.stage === "parse")!
    storeGraph(setTransform(g, parse.id, parser, liveRegistry as never))
    render(<Shell />)
    await waitFor(() => expect(card("chunk")).toBeTruthy())
    const picker = within(card("chunk")).getByRole("button", { name: /^Transform/ })
    expect(optionOf(picker, "By layout block").textContent?.includes("Falls back")).toBe(fallsBack)
    expect(optionOf(picker, "By sentence").textContent).not.toContain("Falls back")
  })
})

describe("the Ask panel results on Build", () => {
  let streams: { onmessage: ((m: MessageEvent<string>) => void) | null }[]

  class OpenEventSource {
    onmessage = null
    onerror = null
    onopen = null
    constructor() {
      streams.push(this)
    }
    close() {}
  }

  function emit(event: Record<string, unknown>, id: string) {
    act(() => streams[streams.length - 1].onmessage!(new MessageEvent("message", { data: JSON.stringify(event), lastEventId: id })))
  }

  let reply422: unknown = null
  // Set to fail every run after the first (the Build the index run) with a column-level error.
  let failAsk = false

  beforeEach(() => {
    streams = []
    reply422 = null
    failAsk = false
    vi.stubGlobal("EventSource", OpenEventSource)
    const base = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
        if (url === "/api/registry") return ok(liveRegistry)
        if (url === "/api/samples") return ok([])
        if (url === "/api/settings/llm") return ok({ anthropic: "dotenv", openai: "none", custom: "none" })
        if (url === "/api/artifacts/ret1/payload") return ok(hybridResult)
        if (url === "/api/artifacts/out1/payload") return ok(searchOutput)
        if (url === "/api/artifacts/rr1/payload") return ok(reranked())
        if (url === "/api/runs" && init?.method === "POST") {
          posts.push({ path: url, body: JSON.parse(String(init.body)) })
          if (reply422) return ok(reply422, 422)
          if (failAsk && posts.length > 1) return ok({ detail: "The server is out of disk space." }, 500)
          return ok({ run_id: `r${posts.length}` }, 202)
        }
        return base(url, init)
      }),
    )
  })

  /** Builds the index, then asks; the Ask run finishes with a Search output. */
  async function buildAndAsk() {
    render(<Shell />)
    const build = await screen.findByRole("button", { name: "Build the index" })
    await act(async () => {})
    await waitFor(() => expect((build as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(build)
    await waitFor(() => expect(streams).toHaveLength(1))
    emit({ event: "node_finished", node_id: "index", artifact_id: "idx1", cache_hit: false, duration_ms: 1 }, "1")
    emit({ event: "stream_end", status: "finished", ok: true }, "2")
    const askButton = panel().getByRole("button", { name: "Ask" }) as HTMLButtonElement
    await waitFor(() => expect(askButton.disabled).toBe(false))
    fireEvent.click(askButton)
    await waitFor(() => expect(streams).toHaveLength(2))
    emit({ event: "node_finished", node_id: "retrieve", artifact_id: "ret1", cache_hit: false, duration_ms: 1 }, "1")
    emit({ event: "node_finished", node_id: "use_case", artifact_id: "out1", cache_hit: false, duration_ms: 1 }, "2")
    emit({ event: "stream_end", status: "finished", ok: true }, "3")
    await waitFor(() => expect(panel().getByText("Hybrid search returned 6 candidates. These are the top 5, in search order.")).toBeTruthy())
  }

  it("closing Ask and opening it again keeps the question and the results; a card's output stays beside it (Review Focus 4)", async () => {
    storeGraph(sampleGraph(liveRegistry as never, SOURCE, "What does overlap cost?"))
    await buildAndAsk()
    await waitFor(() => expect(panel().getByText("Earlier questions in this tab (1)")).toBeTruthy())
    fireEvent.click(card("parse"))
    // The card's output takes the main pane; the Ask panel stays open beside it.
    expect(within(screen.getByRole("region", { name: "Inspector" })).getByRole("heading", { name: "Parse" })).toBeTruthy()
    expect(panel().getByText("Earlier questions in this tab (1)")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: CLOSE_ASK }))
    expect(screen.queryByRole("region", { name: "Ask panel" })).toBeNull()
    // Closed, the round button says how many results the last question found.
    fireEvent.click(screen.getByRole("button", { name: "Ask 5 results" }))
    expect((panel().getByLabelText("Question") as HTMLTextAreaElement).value).toBe("What does overlap cost?")
    expect(await waitFor(() => panel().getByText("Hybrid search returned 6 candidates. These are the top 5, in search order."))).toBeTruthy()
    expect(panel().getByText("Earlier questions in this tab (1)")).toBeTruthy()
    expect(panel().getByText("Working copy, no rerank: 5 pieces")).toBeTruthy()
  })

  it("a hidden comparison stays hidden across closing and opening Ask", async () => {
    storeGraph(setReranker(sampleGraph(liveRegistry as never, SOURCE, "What does overlap cost?"), liveRegistry as never, "cross_encoder"))
    render(<Shell />)
    const build = await screen.findByRole("button", { name: "Build the index" })
    await act(async () => {})
    await waitFor(() => expect((build as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(build)
    await waitFor(() => expect(streams).toHaveLength(1))
    emit({ event: "node_finished", node_id: "index", artifact_id: "idx1", cache_hit: false, duration_ms: 1 }, "1")
    emit({ event: "stream_end", status: "finished", ok: true }, "2")
    const askButton = panel().getByRole("button", { name: "Ask" }) as HTMLButtonElement
    await waitFor(() => expect(askButton.disabled).toBe(false))
    fireEvent.click(askButton)
    await waitFor(() => expect(streams).toHaveLength(2))
    const stored = JSON.parse(window.localStorage.getItem("rag-playground:graph:v1")!) as { nodes: { id: string; stage: string }[] }
    const rerankId = stored.nodes.find((n) => n.stage === "rerank")!.id
    emit({ event: "node_finished", node_id: "retrieve", artifact_id: "ret1", cache_hit: false, duration_ms: 1 }, "1")
    emit({ event: "node_finished", node_id: rerankId, artifact_id: "rr1", cache_hit: false, duration_ms: 1 }, "2")
    emit({ event: "node_finished", node_id: "use_case", artifact_id: "out1", cache_hit: false, duration_ms: 1 }, "3")
    emit({ event: "stream_end", status: "finished", ok: true }, "4")
    fireEvent.click(await waitFor(() => panel().getByRole("button", { name: "Hide comparison" })))
    expect(panel().getByRole("button", { name: "Show comparison" })).toBeTruthy()
    fireEvent.click(card("parse"))
    fireEvent.click(screen.getByRole("button", { name: CLOSE_ASK }))
    expect(screen.queryByRole("region", { name: "Ask panel" })).toBeNull()
    altA()
    expect(await waitFor(() => panel().getByRole("button", { name: "Show comparison" }))).toBeTruthy()
    expect(panel().queryByRole("button", { name: "Hide comparison" })).toBeNull()
    // A new Ask opens it again.
    fireEvent.click(panel().getByRole("button", { name: "Ask" }))
    await waitFor(() => expect(streams).toHaveLength(3))
    expect(await waitFor(() => panel().getByRole("button", { name: "Hide comparison" }))).toBeTruthy()
  })

/** Builds the index on the stored graph and leaves the panel ready to Ask. */
  async function built() {
    render(<Shell />)
    const build = await screen.findByRole("button", { name: "Build the index" })
    await act(async () => {})
    await waitFor(() => expect((build as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(build)
    await waitFor(() => expect(streams).toHaveLength(1))
    emit({ event: "node_finished", node_id: "index", artifact_id: "idx1", cache_hit: false, duration_ms: 1 }, "1")
    emit({ event: "stream_end", status: "finished", ok: true }, "2")
    const askButton = panel().getByRole("button", { name: "Ask" }) as HTMLButtonElement
    await waitFor(() => expect(askButton.disabled).toBe(false))
    return askButton
  }

  it("a reranker changed while an Ask runs leaves no mislabelled transcript entry", async () => {
    storeGraph(setReranker(sampleGraph(liveRegistry as never, SOURCE, "What does overlap cost?"), liveRegistry as never, "cross_encoder"))
    fireEvent.click(await built())
    await waitFor(() => expect(streams).toHaveLength(2))
    expect(panel().getByRole("button", { name: "Asking" })).toBeTruthy()
    const stored = JSON.parse(window.localStorage.getItem("rag-playground:graph:v1")!) as { nodes: { id: string; stage: string }[] }
    const rerankId = stored.nodes.find((n) => n.stage === "rerank")!.id
    emit({ event: "node_finished", node_id: "retrieve", artifact_id: "ret1", cache_hit: false, duration_ms: 1 }, "1")
    // None while the reranker is still working.
    fireEvent.click(panel().getByRole("button", { name: "Change settings" }))
    choose(panel().getByRole("button", { name: /^Reranker/ }), "No reranker")
    emit({ event: "node_finished", node_id: rerankId, artifact_id: "rr1", cache_hit: false, duration_ms: 1 }, "2")
    emit({ event: "node_finished", node_id: "use_case", artifact_id: "out1", cache_hit: false, duration_ms: 1 }, "3")
    emit({ event: "stream_end", status: "finished", ok: true }, "4")
    await waitFor(() => expect(panel().getByRole("button", { name: "Ask" })).toBeTruthy())
    await new Promise((r) => setTimeout(r, 50))
    expect(panel().queryByText(/^Earlier questions in this tab/)).toBeNull()
    expect(panel().queryByText(/no rerank/)).toBeNull()
  })

  it("an Ask that cannot start says so in the panel, pointing at the note above the cards", async () => {
    storeGraph(sampleGraph(liveRegistry as never, SOURCE, "What does overlap cost?"))
    failAsk = true
    fireEvent.click(await built())
    expect((await waitFor(() => panel().getByTestId("ask-run-error"))).textContent).toBe("The run could not start. See the note above the cards.")
    expect(screen.getByText("The pipeline cannot run")).toBeTruthy()
  })

  it("before a build the column says what the steps do; once the index is built it invites a change and points to Compare", async () => {
    storeGraph(sampleGraph(liveRegistry as never, SOURCE, "What does overlap cost?"))
    render(<Shell />)
    const BEFORE = "These five steps build the index. Retrieval, reranking and answering live in the Ask panel."
    const AFTER = "Open a step to change how it works, such as the chunk size, then build again. To see several settings side by side, use Compare."
    expect((await screen.findByTestId("column-intro")).textContent).toBe(BEFORE)
    const build = await screen.findByRole("button", { name: "Build the index" })
    await act(async () => {})
    await waitFor(() => expect((build as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(build)
    await waitFor(() => expect(streams).toHaveLength(1))
    emit({ event: "node_finished", node_id: "index", artifact_id: "idx1", cache_hit: false, duration_ms: 4 }, "1")
    emit({ event: "stream_end", status: "finished", ok: true }, "2")
    await waitFor(() => expect(screen.getByTestId("column-intro").textContent).toBe(AFTER))
    expect(within(screen.getByTestId("column-intro")).getByRole("link", { name: "Compare" }).getAttribute("href")).toBe("/compare")
  })

  it("while the demo makes a run wait its turn, the strip and the Ask panel say so; it starts when its turn comes", async () => {
    storeGraph(sampleGraph(liveRegistry as never, SOURCE, "What does overlap cost?"))
    render(<Shell />)
    const build = await screen.findByRole("button", { name: "Build the index" })
    await act(async () => {})
    await waitFor(() => expect((build as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(build)
    await waitFor(() => expect(streams).toHaveLength(1))
    const BUSY = "The demo is busy with other learners. Your run starts in a moment."
    emit({ event: "queued", ahead: 0 }, "0")
    await waitFor(() => expect(screen.getByTestId("run-line").textContent).toBe(BUSY))
    expect(screen.getByTestId("index-status").textContent).toBe(BUSY)
    emit({ event: "unqueued" }, "1")
    emit({ event: "run_started", nodes: ["source", "parse"], selected: ["source", "parse"] }, "2")
    emit({ event: "node_started", node_id: "parse", transform: "docling", artifact_id: "p1" }, "3")
    await waitFor(() => expect(screen.getByTestId("run-line").textContent).toContain("Building"))
  })

  async function builtIndex() {
    storeGraph(sampleGraph(liveRegistry as never, SOURCE, "What does overlap cost?"))
    render(<Shell />)
    const build = await screen.findByRole("button", { name: "Build the index" })
    await act(async () => {})
    await waitFor(() => expect((build as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(build)
    await waitFor(() => expect(streams).toHaveLength(1))
    emit({ event: "node_finished", node_id: "index", artifact_id: "idx1", cache_hit: false, duration_ms: 4 }, "1")
    emit({ event: "stream_end", status: "finished", ok: true }, "2")
    await waitFor(() => expect(within(card("index")).getByRole("button", { name: "See Index output" })).toBeTruthy())
  }

  it("on desktop the output icon fills the pane and stays lit, without opening the card's settings", async () => {
    await builtIndex()
    const icon = within(card("index")).getByRole("button", { name: "See Index output" })
    fireEvent.click(icon)
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Inspector" })).getByRole("heading", { level: 2 }).textContent).toBe("Index"))
    expect(icon.getAttribute("aria-pressed")).toBe("true")
    expect(within(card("index")).getByRole("button", { name: "Index settings" }).getAttribute("aria-expanded")).toBe("false")
    // The gear opens the settings and leaves the pane as it is.
    fireEvent.click(within(card("chunk")).getByRole("button", { name: "Chunk settings" }))
    expect(within(card("chunk")).getByRole("button", { name: "Chunk settings" }).getAttribute("aria-expanded")).toBe("true")
    expect(within(screen.getByRole("region", { name: "Inspector" })).getByRole("heading", { level: 2 }).textContent).toBe("Index")
    expect(screen.queryByRole("dialog", { name: /output$/ })).toBeNull()
  })

  it("on a phone the output opens in a sheet instead of a pane, and the round Ask button hides while it is open", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((q: string) => ({ matches: q === "(max-width: 47.99rem)" || q === "(max-width: 63.99rem)", addEventListener: () => {}, removeEventListener: () => {} })),
    )
    await builtIndex()
    expect(screen.queryByRole("region", { name: "Inspector" })).toBeNull()
    fireEvent.click(within(card("index")).getByRole("button", { name: "See Index output" }))
    const sheet = await screen.findByRole("dialog", { name: "Index output" })
    expect(within(sheet).getByRole("region", { name: "Inspector" })).toBeTruthy()
    // One title: the sheet's own. The view inside drops its repeat of the step's name.
    expect(within(sheet).getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Index output"])
    expect(document.querySelector<HTMLButtonElement>("button.ask-fab")!.hidden).toBe(true)
    fireEvent.click(within(sheet).getByRole("button", { name: "Close the output" }))
    expect(screen.queryByRole("dialog", { name: "Index output" })).toBeNull()
    expect(document.querySelector<HTMLButtonElement>("button.ask-fab")!.hidden).toBe(false)
    // Tapping a card's title only opens its settings on a phone: no sheet.
    fireEvent.click(within(card("chunk")).getByTestId("card-title"))
    expect(screen.queryByRole("dialog", { name: /output$/ })).toBeNull()
  })

  it("keeps the built steps when you leave Build and come back in the same tab", async () => {
    storeGraph(sampleGraph(liveRegistry as never, SOURCE, "What does overlap cost?"))
    render(<Shell />)
    const build = await screen.findByRole("button", { name: "Build the index" })
    await act(async () => {})
    await waitFor(() => expect((build as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(build)
    await waitFor(() => expect(streams).toHaveLength(1))
    emit({ event: "node_finished", node_id: "index", artifact_id: "idx1", cache_hit: true, duration_ms: 4 }, "1")
    emit({ event: "stream_end", status: "finished", ok: true }, "2")
    await waitFor(() => expect(within(card("index")).getByTestId("status-chip").textContent).toBe("reused from an earlier run"))

    // Read or Compare is a new page load: Build mounts again from nothing. The server still has the result.
    const base = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) =>
        url === "/api/artifacts/idx1" ? Promise.resolve(new Response(JSON.stringify({ id: "idx1" }), { status: 200 })) : base(url, init),
      ),
    )
    cleanup()
    render(<Shell />)
    await act(async () => {})
    await waitFor(() => expect(within(card("index")).getByTestId("status-chip").textContent).toBe("reused from an earlier run"))
    expect((await screen.findByTestId("column-intro")).textContent).toContain("Open a step to change how it works")
  })

  it("after a restart wiped the server's results, a restored step comes back as not run", async () => {
    storeGraph(sampleGraph(liveRegistry as never, SOURCE, "What does overlap cost?"))
    render(<Shell />)
    const build = await screen.findByRole("button", { name: "Build the index" })
    await act(async () => {})
    await waitFor(() => expect((build as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(build)
    await waitFor(() => expect(streams).toHaveLength(1))
    emit({ event: "node_finished", node_id: "index", artifact_id: "idx1", cache_hit: true, duration_ms: 4 }, "1")
    emit({ event: "stream_end", status: "finished", ok: true }, "2")
    await waitFor(() => expect(within(card("index")).getByTestId("status-chip").textContent).toBe("reused from an earlier run"))
    cleanup()
    // The fake server answers 404 for idx1, as a restarted Space does.
    render(<Shell />)
    await waitFor(() => expect(within(card("index")).getByTestId("status-chip").textContent).toBe("not run"))
  })

  it("says reused from an earlier run, never cached, on the card and in the inspector header", async () => {
    storeGraph(sampleGraph(liveRegistry as never, SOURCE, "What does overlap cost?"))
    render(<Shell />)
    const build = await screen.findByRole("button", { name: "Build the index" })
    await act(async () => {})
    await waitFor(() => expect((build as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(build)
    await waitFor(() => expect(streams).toHaveLength(1))
    emit({ event: "node_finished", node_id: "index", artifact_id: "idx1", cache_hit: true, duration_ms: 4 }, "1")
    emit({ event: "stream_end", status: "finished", ok: true }, "2")
    expect(within(card("index")).getByTestId("status-chip").textContent).toBe("reused from an earlier run")
    expect(card("index").textContent).not.toContain("from cache")
    fireEvent.click(card("index"))
    const header = await waitFor(() => screen.getByTestId("inspector-timing"))
    expect(header.textContent).toBe("reused from an earlier run 4.0 ms")
    // Words in sans; the type, the id and the duration in mono.
    expect(header.className).not.toContain("font-mono")
    expect(header.parentElement!.className).not.toContain("font-mono")
    expect(within(header).getByText("4.0 ms").className).toContain("font-mono")
    // A narrow inspector wraps the type, id and timing onto rows instead of running past its edge.
    expect(header.parentElement!.className).toContain("flex-wrap")
    expect(header.parentElement!.className).toContain("min-w-0")
    expect(header.parentElement!.className).not.toContain("shrink-0")
    expect(header.className).toContain("whitespace-nowrap")
  })

  it("switching Answer to Search clears a field error on the chat model", async () => {
    storeGraph(chatSampleGraph(liveRegistry as never, SOURCE))
    reply422 = { detail: { node_id: "use_case", errors: [{ loc: ["model"], msg: "This model is not available" }] } }
    render(<Shell />)
    const build = await screen.findByRole("button", { name: "Build the index" })
    await act(async () => {})
    await waitFor(() => expect((build as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(build)
    await waitFor(() => expect(panel().getAllByText("This model is not available").length).toBeGreaterThan(0))
    fireEvent.click(within(panel().getByRole("group", { name: "Answer with" })).getByRole("button", { name: "Search" }))
    await waitFor(() => expect(panel().queryByText("This model is not available")).toBeNull())
  })
})

describe("the document comes from the bar", () => {
  const SAMPLE_SHA = "cd".repeat(32)
  const UP = { sha: "12".repeat(32), filename: "my-notes.pdf", size: 7451, content_type: "application/pdf" }
  const SAMPLE_CARD = {
    name: "chunking-primer",
    title: "A primer on chunking",
    blurb: "b",
    shows: "s",
    stresses: "chunk",
    pages: 2,
    default: true,
    filename: "chunking-primer.pdf",
    sha: SAMPLE_SHA,
    question: "Why do chunk boundaries matter?",
  }
  // Every reader of the samples list (the bar's store, the Ask panel) waits on its own request; settle answers them all.
  // A request made after the answer gets the same answer.
  let pending: { resolve: (r: Response) => void; reject: (e: Error) => void }[] = []
  let answered: ((p: (typeof pending)[number]) => void) | null = null
  const settle = {
    resolve: (r: Response) => {
      answered = (p) => p.resolve(r.clone())
      pending.splice(0).forEach(answered)
    },
    reject: (e: Error) => {
      answered = (p) => p.reject(e)
      pending.splice(0).forEach(answered)
    },
  }
  let streams: { onmessage: ((m: MessageEvent<string>) => void) | null }[]

  class OpenEventSource {
    onmessage = null
    onerror = null
    onopen = null
    constructor() {
      streams.push(this)
    }
    close() {}
  }

  beforeEach(() => {
    streams = []
    pending = []
    answered = null
    const base = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) =>
        url === "/api/samples" ? new Promise<Response>((resolve, reject) => (answered ? answered({ resolve, reject }) : pending.push({ resolve, reject }))) : base(url, init),
      ),
    )
  })

  const stored = (sha: string, filename = "chunking-primer.pdf") => storeGraph(setConfig(initialGraph(TEST_REGISTRY), "source", { sha, filename }))
  const cardWarning = () => card("source")?.querySelector("[data-testid=missing-file]") ?? null

  it("shows the document in use on a slim Document card, with no file picker in it", async () => {
    stored(SAMPLE_SHA)
    setup()
    const doc = await waitFor(() => {
      expect(card("source")).toBeTruthy()
      return card("source")
    })
    expect(within(doc).getByText("Document")).toBeTruthy()
    expect(doc.textContent).toContain("chunking-primer.pdf. Change it in the bar above.")
    fireEvent.click(within(doc).getByText("Document"))
    expect(within(doc).queryByRole("combobox")).toBeNull()
    expect(within(doc).queryByRole("button", { name: /upload/i })).toBeNull()
  })

  it("a missing file warns on the card and in the note, and disables Build the index and Ask", async () => {
    stored("ef".repeat(32))
    setup()
    await screen.findByRole("group", { name: "Saved pipelines" })
    await act(async () => settle.reject(new Error("down")))
    await waitFor(() => expect(cardWarning()?.textContent).toBe("Missing. Pick a document in the bar above."))
    expect(screen.getByTestId("document-note").textContent).toContain("Pick a document in the bar above to build the index.")
    expect((screen.getByRole("button", { name: "Build the index" }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getAllByText("Needs a document.").length).toBe(2)
    expect((screen.getByRole("button", { name: "Ask" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("a document chosen in the bar marks every built step out of date and says so", async () => {
    vi.stubGlobal("EventSource", OpenEventSource)
    stored(SAMPLE_SHA)
    setup()
    await screen.findByRole("group", { name: "Saved pipelines" })
    await act(async () => settle.resolve(new Response(JSON.stringify([SAMPLE_CARD]), { status: 200 })))
    const build = (await screen.findByRole("button", { name: "Build the index" })) as HTMLButtonElement
    await waitFor(() => expect(build.disabled).toBe(false))
    fireEvent.click(build)
    await waitFor(() => expect(streams).toHaveLength(1))
    const emit = (event: Record<string, unknown>, id: string) =>
      act(() => streams[0].onmessage!(new MessageEvent("message", { data: JSON.stringify(event), lastEventId: id })))
    ;["source", "parse", "chunk", "index"].forEach((id, i) =>
      emit({ event: "node_finished", node_id: id, artifact_id: `${id}1`, cache_hit: false, duration_ms: 10 }, String(i + 1)),
    )
    emit({ event: "stream_end", status: "finished", ok: true }, "9")
    await waitFor(() => expect(card("index").getAttribute("data-look")).toBe("done"))
    expect(screen.queryByTestId("document-note")).toBeNull()
    await act(() => chooseDocument({ sha: UP.sha, filename: "my-notes.pdf" }))
    for (const stage of ["parse", "chunk", "index"]) expect(card(stage).getAttribute("data-look")).toBe("stale")
    expect(screen.getByTestId("document-note").textContent).toBe(
      "The document changed to my-notes.pdf. The results below are from the old one. Run again to update them.",
    )
  })

  it("a share link opened in a new browser keeps its recipe, and picking a sample keeps it too", async () => {
    const g0 = sampleGraph(liveRegistry as never, { sha: "ef".repeat(32), filename: "their-notes.pdf" })
    const chunk = g0.nodes.find((n) => n.stage === "chunk")!
    const shared = setConfig(g0, chunk.id, { ...chunk.config, chunk_size: 200 })
    window.history.replaceState(null, "", `/build?pipeline=${encodePipeline("From a friend", shared)}`)
    const base = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) =>
        url === "/api/registry" ? Promise.resolve(new Response(JSON.stringify(liveRegistry), { status: 200 })) : base(url, init),
      ),
    )
    setup()
    await screen.findByRole("group", { name: "Saved pipelines" })
    await act(async () => settle.resolve(new Response(JSON.stringify([SAMPLE_CARD]), { status: 200 })))
    await waitFor(() => expect(cardWarning()).toBeTruthy())
    await act(() => chooseDocument({ sha: SAMPLE_SHA, filename: "chunking-primer.pdf" }, "Why do chunk boundaries matter?"))
    expect(card("chunk").textContent).toContain("recursive_character")
    expect(readStoredGraph(liveRegistry as never)!.nodes.find((n) => n.stage === "chunk")!.config.chunk_size).toBe(200)
    expect(cardWarning()).toBeNull()
  })

  it("a sample picked in the bar on a first visit loads the sample pipeline", async () => {
    setup()
    await screen.findByRole("button", { name: "Upload a PDF" })
    expect(card("parse")).toBeNull()
    await act(() => chooseDocument({ sha: SAMPLE_SHA, filename: "chunking-primer.pdf" }, "Why do chunk boundaries matter?"))
    await waitFor(() => expect(card("parse")).toBeTruthy())
    expect(card("source").textContent).toContain("chunking-primer.pdf. Change it in the bar above.")
  })
  it("asks for a document once on a first visit: the first-visit card, with no note above it", async () => {
    setup()
    await screen.findByRole("button", { name: "Upload a PDF" })
    await act(async () => settle.resolve(new Response(JSON.stringify([SAMPLE_CARD]), { status: 200 })))
    expect(screen.queryByTestId("document-note")).toBeNull()
  })
})
