import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { sampleGraph } from "@/state/graph"
import { TEST_REGISTRY as R } from "@/state/testRegistry"

import { CopyYaml } from "./CopyYaml"

const DOC = { sha: "d".repeat(64), filename: "a.pdf" }
const YAML = "path: ./pandion-index\nindex:\n  parse:\n    use: pdfium\n"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stub(body: unknown, writeText = vi.fn(async (_s: string) => undefined)) {
  vi.stubGlobal("navigator", { clipboard: { writeText } })
  const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify(body), { status: 200 }))
  vi.stubGlobal("fetch", fetch)
  return { writeText, fetch }
}

describe("CopyYaml", () => {
  it("copies the server's pipeline file and says how to run it", async () => {
    const { writeText, fetch } = stub({ ok: true, problems: [], config: {}, yaml: YAML })
    render(<CopyYaml graph={sampleGraph(R, DOC)} />)
    fireEvent.click(screen.getByRole("button", { name: "Copy as YAML" }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(YAML))
    expect(fetch.mock.calls[0][0]).toBe("/api/v2/pipelines/validate")
    const sent = JSON.parse(String((fetch.mock.calls[0][1] as RequestInit).body))
    expect(sent.config.index.parse.use).toBe("pdfium")
    expect(sent.config).not.toHaveProperty("path")
    expect(await screen.findByText(/pandion index pipeline.yaml/)).toBeTruthy()
  })

  it("says the problems and copies nothing", async () => {
    const { writeText } = stub({ ok: false, problems: ["index.chunk: chunk_overlap must be smaller than chunk_size."] })
    render(<CopyYaml graph={sampleGraph(R, DOC)} />)
    fireEvent.click(screen.getByRole("button", { name: "Copy as YAML" }))
    expect(await screen.findByText(/chunk_overlap must be smaller/)).toBeTruthy()
    expect(writeText).not.toHaveBeenCalled()
  })

  it("says plainly when the browser refuses the clipboard", async () => {
    stub({ ok: true, problems: [], config: {}, yaml: YAML }, vi.fn(async () => Promise.reject(new Error("denied"))))
    render(<CopyYaml graph={sampleGraph(R, DOC)} />)
    fireEvent.click(screen.getByRole("button", { name: "Copy as YAML" }))
    expect(await screen.findByText(/could not copy/i)).toBeTruthy()
    expect(screen.queryByText(/pandion index pipeline.yaml/)).toBeNull()
  })

  it("says a site rule's sentence when the server refuses", async () => {
    const writeText = vi.fn(async (_s: string) => undefined)
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "The demo does not allow this." }), { status: 403 })))
    render(<CopyYaml graph={sampleGraph(R, DOC)} />)
    fireEvent.click(screen.getByRole("button", { name: "Copy as YAML" }))
    expect(await screen.findByText("The demo does not allow this.")).toBeTruthy()
    expect(writeText).not.toHaveBeenCalled()
  })

  it("says it could not check on a server error, with no raw text", async () => {
    const writeText = vi.fn(async (_s: string) => undefined)
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })))
    render(<CopyYaml graph={sampleGraph(R, DOC)} />)
    fireEvent.click(screen.getByRole("button", { name: "Copy as YAML" }))
    expect(await screen.findByText("Could not check the pipeline just now. Nothing was copied.")).toBeTruthy()
    expect(screen.queryByText(/boom|500/)).toBeNull()
    expect(writeText).not.toHaveBeenCalled()
  })

  it("says it could not check when the network fails", async () => {
    const writeText = vi.fn(async (_s: string) => undefined)
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))))
    render(<CopyYaml graph={sampleGraph(R, DOC)} />)
    fireEvent.click(screen.getByRole("button", { name: "Copy as YAML" }))
    expect(await screen.findByText("Could not check the pipeline just now. Nothing was copied.")).toBeTruthy()
    expect(screen.queryByText(/Failed to fetch/)).toBeNull()
    expect(writeText).not.toHaveBeenCalled()
  })
})
