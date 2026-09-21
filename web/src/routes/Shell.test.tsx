import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
