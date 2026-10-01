import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiKeyProvider, useApiKey } from "@/api/apiKey"
import liveRegistry from "@/api/fixtures/registry.json"
import { chatSampleGraph, initialGraph, sampleGraph, setConfig, setTransform, storeGraph } from "@/state/graph"
import { decodePipeline, encodePipeline, readPipelines, resetPipelinesForTests, savePipeline, setCurrentId } from "@/state/pipelines"
import { TEST_REGISTRY } from "@/state/testRegistry"

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
  window.localStorage.clear()
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

async function ready() {
  render(<Shell />)
  // With no file the pipeline shows the first-visit card; its picker lists the uploads.
  const pick = await waitFor(() => within(document.querySelector('[aria-label="Upload"]') as HTMLElement).getByLabelText("File") as HTMLSelectElement)
  await waitFor(() => expect(within(pick).getByRole("option", { name: /report\.pdf/ })).toBeTruthy())
  fireEvent.change(pick, { target: { value: SOURCE.sha } })
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

  it("Run all without a file asks calmly for a sample, with no red note", async () => {
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
    const runAll = await screen.findByRole("button", { name: "Run all" })
    await waitFor(() => expect(runAll.getAttribute("title")).toBe("Load a sample to start."), { timeout: 2000 })
    expect((runAll as HTMLButtonElement).disabled).toBe(true)
    expect(document.querySelector("[data-testid=run-all-blocked]")).toBeNull()
    expect(posts).toHaveLength(0)
  })
})

describe("Run all with a chat card and no API key", () => {
  const NO_SERVER_KEYS = { anthropic: "none", openai: "none", custom: "none" }
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

  /** Ends the run over its event stream, as the server does when it finishes. */
  async function endRun() {
    await waitFor(() => expect(streams.length).toBeGreaterThan(0))
    const data = JSON.stringify({ event: "stream_end", status: "finished", ok: true })
    act(() => streams[streams.length - 1].onmessage!(new MessageEvent("message", { data, lastEventId: "1" })))
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
          return new Response(JSON.stringify({ run_id: "r1" }), { status: 202 })
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

  async function runAll(withKey = false) {
    render(
      <ApiKeyProvider>
        {withKey ? <WithKey /> : null}
        <Shell />
      </ApiKeyProvider>,
    )
    const button = await screen.findByRole("button", { name: "Run all" })
    // Let the settings answer land before pressing.
    await act(async () => {})
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button)
    await waitFor(() => expect(posts).toHaveLength(1))
    return posts[0].body as { targets?: string[] }
  }

  it("keyless Run all stops before Chat", async () => {
    const body = await runAll()
    expect(body.targets).toEqual([chatUpstream()])
    await endRun()
    const notice = await screen.findByTestId("key-notice")
    expect(notice.textContent!.startsWith("Search results are ready. Add a key to get a written answer.")).toBe(true)
    expect(within(notice).getByTestId("key-hint")).toBeTruthy()
  })

  it("the key notice waits until the keyless run has finished", async () => {
    await runAll()
    await waitFor(() => expect(streams.length).toBeGreaterThan(0))
    await act(async () => {})
    expect(screen.getByRole("button", { name: "Running" })).toBeTruthy()
    expect(screen.queryByTestId("key-notice")).toBeNull()
    await endRun()
    expect(await screen.findByTestId("key-notice")).toBeTruthy()
  })

  it("a UI key runs all the way", async () => {
    const body = await runAll(true)
    expect(body.targets).toBeUndefined()
    expect(screen.queryByTestId("key-notice")).toBeNull()
  })

  it("a server .env key runs all the way", async () => {
    settings = { ...NO_SERVER_KEYS, anthropic: "dotenv" }
    const body = await runAll()
    expect(body.targets).toBeUndefined()
    expect(screen.queryByTestId("key-notice")).toBeNull()
  })
})

describe("Build page explanations", () => {
  it("a blocking explanation disables Run all with a visible reason, as the user types", async () => {
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
    const runAll = () => document.querySelector("section[aria-label=Pipeline]")!.querySelector("button:not([aria-label])") as HTMLButtonElement
    expect(runAll().textContent).toBe("Run all")
    await waitFor(() => expect(runAll().disabled).toBe(false))
    fireEvent.change(within(card("chunk")).getByLabelText("Chunk Overlap"), { target: { value: "5000" } })
    await waitFor(() => expect(within(card("chunk")).getByTestId("explain-warning").textContent).toBe("Overlap must be smaller than the chunk size."), {
      timeout: 2000,
    })
    expect(runAll().disabled).toBe(true)
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
  const sampleButton = () => found<HTMLButtonElement>('[aria-label="Upload"] li button')

  it("shows when no source is selected and nothing is uploaded", async () => {
    render(<Shell />)
    expect((await sampleButton()).textContent).toBe("Load")
    expect(document.body.textContent).toContain("Nothing to show yet")
    expect(card("parse")).toBeNull()
    // The empty Load card blocks the run, but a first visit is not an error.
    await waitFor(() => expect(sourceExplains).toBeGreaterThan(0), { timeout: 2000 })
    await new Promise((r) => setTimeout(r, 50))
    expect(document.querySelector("[data-testid=run-all-blocked]")).toBeNull()
  })

  it("still shows when files are already uploaded, and its picker lists them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        new Response(JSON.stringify(url === "/api/registry" ? liveRegistry : url === "/api/sources" ? [SOURCE] : url === "/api/samples" ? [] : {}), {
          status: 200,
        }),
      ),
    )
    render(<Shell />)
    const upload = await found<HTMLElement>('[aria-label="Upload"]')
    expect(document.body.textContent).toContain("Nothing to show yet")
    expect(card("parse")).toBeNull()
    await waitFor(() => expect(within(upload).getByRole("option", { name: /report\.pdf/ })).toBeTruthy())
  })

  it("does not show when the stored graph already has a source", async () => {
    window.localStorage.setItem(
      "rag-playground:graph:v1",
      JSON.stringify({ nodes: [{ id: "source", stage: "source", transform: "upload", config: { sha: SOURCE.sha, filename: "x.pdf" } }], edges: [] }),
    )
    render(<Shell />)
    await waitFor(() => expect(card("parse")).toBeTruthy())
    expect(document.querySelector('[aria-label="Upload"]')).toBeNull()
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
      ["query", "text"],
      ["retrieve", "hybrid_rrf"],
      ["use_case", "search"],
    ])
    expect(byId.get("source")!.config).toEqual({ sha: SAMPLE.sha, filename: SAMPLE.filename })
    expect(byId.get("index")!.config.embedder).toBe("qwen3-embedding-0.6b")
    expect((within(card("query")).getByLabelText("Question") as HTMLTextAreaElement).value).toBe("Why do chunk boundaries matter?")
    expect(posts).toHaveLength(0)
    expect(document.body.textContent).toContain("Ready to run")
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

describe("picking a sample on the Upload card", () => {
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
    const pick = await waitFor(() => within(card("source")).getByLabelText("File") as HTMLSelectElement)
    await waitFor(() => expect(pick.querySelectorAll("optgroup")).toHaveLength(2))
    fireEvent.change(pick, { target: { value: "sample:two-column-report" } })
    await waitFor(() => expect((within(card("query")).getByLabelText("Question") as HTMLTextAreaElement).value).toBe("How long did the survey run?"))
    expect(sampled).toEqual(["two-column-report"])
    const stored = JSON.parse(window.localStorage.getItem("rag-playground:graph:v1")!) as { nodes: { id: string; config: Record<string, unknown> }[] }
    const byId = new Map(stored.nodes.map((n) => [n.id, n.config]))
    expect(byId.get("source")).toEqual({ sha: TWO_COL.sha, filename: TWO_COL.filename })
    expect(byId.get("chunk")).toEqual({ ...chunk.config, chunk_size: 321 })
    expect(stored.nodes.map((n) => n.id)).toEqual(g.nodes.map((n) => n.id))
    expect(pick.value).toBe("sample:two-column-report")
  })

  it("clears a field error on the Ask card", async () => {
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
    await waitFor(() => expect(within(card("query")).getAllByText("Text is required").length).toBeGreaterThan(0))
    const pick = within(card("source")).getByLabelText("File") as HTMLSelectElement
    await waitFor(() => expect(pick.querySelectorAll("optgroup")).toHaveLength(2))
    fireEvent.change(pick, { target: { value: "sample:two-column-report" } })
    await waitFor(() => expect((within(card("query")).getByLabelText("Question") as HTMLTextAreaElement).value).toBe("How long did the survey run?"))
    expect(within(card("query")).queryByText("Text is required")).toBeNull()
  })
})

describe("saved pipelines on Build", () => {
  // A pipeline with no file shows the first-visit card, so these start with one.
  const withFile = () => setConfig(initialGraph(TEST_REGISTRY), "source", { sha: SOURCE.sha, filename: SOURCE.filename })
  const bar = () => screen.getByRole("group", { name: "Saved pipelines" })
  const picker = () => within(bar()).getByRole("combobox", { name: "Pipeline" }) as HTMLSelectElement
  const chunkTransform = () => (within(card("chunk")).getByRole("combobox", { name: "Transform" }) as HTMLSelectElement).value

  it("starts on the working copy with nothing saved", async () => {
    setup()
    await screen.findByRole("group", { name: "Saved pipelines" })
    expect([...picker().options].map((o) => o.textContent)).toEqual(["Working copy"])
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
    expect([...picker().options].map((o) => o.textContent)).toEqual(["Working copy", "Recursive chunks"])
    expect(picker().selectedOptions[0].textContent).toBe("Recursive chunks")
    expect(readPipelines()[0].name).toBe("Recursive chunks")
  })

  it("switching pipelines loads the saved graph, editing shows edited, and Save changes writes it back", async () => {
    const saved = savePipeline("Token chunks", setTransform(withFile(), "chunk", "token_based", TEST_REGISTRY))!.saved
    setCurrentId(null)
    storeGraph(withFile())
    setup()
    await screen.findByRole("group", { name: "Saved pipelines" })
    expect(chunkTransform()).toBe("recursive_character")
    fireEvent.change(picker(), { target: { value: saved.id } })
    expect(chunkTransform()).toBe("token_based")
    expect(within(bar()).queryByText("edited")).toBeNull()
    fireEvent.change(within(card("chunk")).getByRole("combobox", { name: "Transform" }), { target: { value: "markdown_header" } })
    expect(within(bar()).getByText("edited")).toBeTruthy()
    expect(readPipelines()[0].graph.nodes.find((n) => n.stage === "chunk")?.transform).toBe("token_based")
    fireEvent.click(within(bar()).getByRole("button", { name: "Save changes" }))
    expect(within(bar()).queryByText("edited")).toBeNull()
    expect(readPipelines()[0].graph.nodes.find((n) => n.stage === "chunk")?.transform).toBe("markdown_header")
  })

  it("Delete returns to the working copy and keeps the graph on screen", async () => {
    const saved = savePipeline("Token chunks", setTransform(withFile(), "chunk", "token_based", TEST_REGISTRY))!.saved
    setup()
    await screen.findByRole("group", { name: "Saved pipelines" })
    expect(picker().value).toBe(saved.id)
    fireEvent.click(within(bar()).getByRole("button", { name: "Delete" }))
    expect(picker().value).toBe("")
    expect([...picker().options].map((o) => o.textContent)).toEqual(["Working copy"])
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
    expect(picker().selectedOptions[0].textContent).toBe("New")
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
    expect(picker().selectedOptions[0].textContent).toBe("From a friend")
    expect(chunkTransform()).toBe("token_based")
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
    expect(await screen.findByText("This pipeline was built on report.pdf. Load a sample, or upload that file, to run it.")).toBeTruthy()
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
    expect(picker().selectedOptions[0].textContent).toBe("x".repeat(60))
  })

  it("a share link that cannot be saved loads as the working copy, never over the current pipeline (M2)", async () => {
    savePipeline("Mine", withFile())
    const graph = setTransform(withFile(), "chunk", "token_based", TEST_REGISTRY)
    window.history.replaceState(null, "", `/build?pipeline=${encodePipeline("From a friend", graph)}`)
    blockWrites()
    setup()
    await screen.findByRole("group", { name: "Saved pipelines" })
    expect(within(bar()).getByText("The shared pipeline could not be saved in this browser. It is loaded as the working copy.")).toBeTruthy()
    expect(picker().value).toBe("")
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
    fireEvent.change(within(card("chunk")).getByRole("combobox", { name: "Transform" }), { target: { value: "token_based" } })
    fireEvent.click(within(bar()).getByRole("button", { name: "Save changes" }))
    expect(within(bar()).getByText("The pipeline could not be saved in this browser.")).toBeTruthy()
  })

  it("Copy link waits for Save changes while the pipeline is edited (M6)", async () => {
    savePipeline("Mine", withFile())
    setup()
    await screen.findByRole("group", { name: "Saved pipelines" })
    expect((within(bar()).getByRole("button", { name: "Copy link" }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.change(within(card("chunk")).getByRole("combobox", { name: "Transform" }), { target: { value: "token_based" } })
    const copy = within(bar()).getByRole("button", { name: "Copy link" }) as HTMLButtonElement
    expect(copy.disabled).toBe(true)
    expect(copy.title).toBe("Save changes first")
  })

  it("switching pipelines closes an open name box (M5)", async () => {
    const a = savePipeline("A", withFile())!.saved
    savePipeline("B", withFile())
    setup()
    await screen.findByRole("group", { name: "Saved pipelines" })
    fireEvent.click(within(bar()).getByRole("button", { name: "Rename" }))
    expect(within(bar()).getByRole("textbox", { name: "Pipeline name" })).toBeTruthy()
    fireEvent.change(picker(), { target: { value: a.id } })
    expect(within(bar()).queryByRole("textbox", { name: "Pipeline name" })).toBeNull()
  })

  it("lists a saved pipeline this server cannot run as not usable, and it cannot be chosen (M7)", async () => {
    const graph = withFile()
    const foreign = { ...graph, nodes: graph.nodes.map((n) => (n.stage === "chunk" ? { ...n, transform: "semantic" } : n)) }
    savePipeline("Semantic", foreign)
    setCurrentId(null)
    setup()
    await screen.findByRole("group", { name: "Saved pipelines" })
    const option = [...picker().options].find((o) => o.textContent === "Semantic (not usable here)")
    expect(option).toBeTruthy()
    expect(option!.disabled).toBe(true)
  })

  describe("the missing document notice while samples load (M1)", () => {
    let settle: { resolve: (r: Response) => void; reject: (e: Error) => void }
    const SAMPLE_SHA = "cd".repeat(32)

    beforeEach(() => {
      const base = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init?: RequestInit) =>
          url === "/api/samples" ? new Promise<Response>((resolve, reject) => (settle = { resolve, reject })) : base(url, init),
        ),
      )
    })

    const stored = (sha: string) => {
      const graph = withFile()
      const src = graph.nodes.find((n) => n.stage === "source")!
      storeGraph(setConfig(graph, src.id, { sha, filename: "chunking-primer.pdf" }))
    }
    const notice = () => screen.queryByTestId("missing-document")
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
    const chunk = within(card("chunk"))
    expect(chunk.getByRole("option", { name: "markdown_header" })).toBeTruthy()
    expect(chunk.queryByRole("option", { name: /markdown_header · falls back/ })).toBeNull()
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
    const chunk = within(card("chunk"))
    expect(chunk.getByRole("option", { name: fallsBack ? "layout_blocks · falls back" : "layout_blocks" })).toBeTruthy()
    expect(chunk.getByRole("option", { name: "sentence_window" })).toBeTruthy()
  })
})
