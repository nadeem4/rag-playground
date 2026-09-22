import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
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
})

const card = (id: string) => document.querySelector(`[data-node-id="${id}"]`) as HTMLElement

async function ready() {
  render(<Shell />)
  await waitFor(() => expect(card("parse")).toBeTruthy())
  const pick = await waitFor(() => within(card("source")).getByLabelText("File") as HTMLSelectElement)
  fireEvent.change(pick, { target: { value: SOURCE.sha } })
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

  it("refuses to run without a file, on the Load card", async () => {
    render(<Shell />)
    await waitFor(() => expect(card("parse")).toBeTruthy())
    fireEvent.click(within(card("parse")).getByRole("button", { name: "Run" }))
    expect(within(card("source")).getByText("Choose or upload a file first.")).toBeTruthy()
    expect(posts).toHaveLength(0)
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
  const sampleButton = () => found<HTMLButtonElement>("button[data-testid=try-sample]")

  it("shows when no source is selected and nothing is uploaded", async () => {
    render(<Shell />)
    expect((await sampleButton()).textContent).toBe("Try the sample document")
    expect(document.body.textContent).toContain("Nothing to show yet")
    expect(card("parse")).toBeNull()
    // The empty Load card blocks the run, but a first visit is not an error.
    await waitFor(() => expect(sourceExplains).toBeGreaterThan(0), { timeout: 2000 })
    await new Promise((r) => setTimeout(r, 50))
    expect(document.querySelector("[data-testid=run-all-blocked]")).toBeNull()
  })

  it("does not show when files are already uploaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => new Response(JSON.stringify(url === "/api/registry" ? liveRegistry : url === "/api/sources" ? [SOURCE] : {}), { status: 200 })),
    )
    render(<Shell />)
    await waitFor(() => expect(card("parse")).toBeTruthy())
    expect(document.querySelector("[data-testid=try-sample]")).toBeNull()
  })

  it("does not show when the stored graph already has a source", async () => {
    window.localStorage.setItem(
      "rag-playground:graph:v1",
      JSON.stringify({ nodes: [{ id: "source", stage: "source", transform: "upload", config: { sha: SOURCE.sha, filename: "x.pdf" } }], edges: [] }),
    )
    render(<Shell />)
    await waitFor(() => expect(card("parse")).toBeTruthy())
    expect(document.querySelector("[data-testid=try-sample]")).toBeNull()
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
    expect(btn.textContent).toBe("Loading the sample")
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
