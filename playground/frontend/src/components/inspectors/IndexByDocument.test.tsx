import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DocNodeState } from "@/api/runState"
import type { FileInfo } from "@/lib/files"

import { IndexByDocument, IndexDocuments } from "./IndexByDocument"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const A: FileInfo = { sha: "a", filename: "report.pdf", slot: 1 }
const B: FileInfo = { sha: "b", filename: "notes.md", slot: 2 }

describe("IndexByDocument", () => {
  it("shows one row per document and the total", () => {
    render(
      <IndexByDocument
        rows={[
          { file: A, chunks: 3 },
          { file: B, chunks: 5 },
        ]}
      />,
    )
    const rows = screen.getAllByRole("row")
    expect(within(rows[1]).getByText("3")).toBeTruthy()
    expect(within(rows[2]).getByText("5")).toBeTruthy()
    expect(within(rows[3]).getByText("Total")).toBeTruthy()
    expect(within(rows[3]).getByText("8")).toBeTruthy()
  })

  it("shows Counting until a count loads", () => {
    render(
      <IndexByDocument
        rows={[
          { file: A, chunks: 3 },
          { file: B, chunks: null },
        ]}
      />,
    )
    expect(screen.getByText("Counting")).toBeTruthy()
    expect(screen.queryByText("Total")).toBeNull()
  })

  it("shows no table for one document", () => {
    const { container } = render(<IndexByDocument rows={[{ file: A, chunks: 3 }]} />)
    expect(container.innerHTML).toBe("")
  })
})

describe("IndexDocuments", () => {
  beforeEach(() => {
    const counts: Record<string, number> = { "chunks-a": 3, "chunks-b": 5 }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const m = /^\/api\/v2\/results\/([^/]+)\/payload$/.exec(url)
        return new Response(JSON.stringify({ chunks: Array.from({ length: counts[m![1]] ?? 0 }, () => ({})) }), { status: 200 })
      }),
    )
  })

  it("counts each document's chunks from its own chunk result", async () => {
    const documents: Record<string, DocNodeState> = {
      "report.pdf": { status: "done", artifact_id: "chunks-a" },
      "notes.md": { status: "done", artifact_id: "chunks-b" },
    }
    render(<IndexDocuments files={[A, B]} documents={documents} />)
    await waitFor(() => expect(screen.getByText("Total")).toBeTruthy())
    expect(screen.getByText("8")).toBeTruthy()
  })
})
