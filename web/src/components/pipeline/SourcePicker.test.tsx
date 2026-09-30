import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SourcePicker } from "./SourcePicker"

const SAMPLE = { sha: "cd".repeat(32), filename: "report.pdf", size: 100, content_type: "application/pdf" }
const LIMITS = { max_bytes: 10485760, max_pages: 20, max_files: 3, max_total_bytes: 52428800, ttl_hours: 24 }

let settings: unknown = { demo: false }
let posts = 0

beforeEach(() => {
  settings = { demo: false }
  posts = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url === "/api/settings/app") return ok(settings)
      if (url === "/api/sources" && init?.method === "POST") {
        posts += 1
        return ok(SAMPLE)
      }
      if (url === "/api/sources") return ok([])
      if (url === "/api/samples") return ok([])
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const limitsLine = () => screen.getByTestId("upload-limits").textContent

function choose(file: File) {
  fireEvent.change(screen.getByLabelText("Upload a file"), { target: { files: [file] } })
}

function sized(name: string, size: number, type = "application/pdf") {
  const file = new File(["%PDF"], name, { type })
  Object.defineProperty(file, "size", { value: size })
  return file
}

describe("SourcePicker upload limits", () => {
  it("in demo mode, states the size and page limits under Upload", async () => {
    settings = { demo: true, limits: LIMITS }
    render(<SourcePicker value={{}} onChange={() => {}} />)
    await waitFor(() => expect(limitsLine()).toBe("PDF only, up to 10 MB and 20 pages."))
  })

  it("in demo mode without limits, says PDF only", async () => {
    settings = { demo: true }
    render(<SourcePicker value={{}} onChange={() => {}} />)
    await screen.findByText("No files yet. Upload a PDF, or load a sample.")
    expect(limitsLine()).toBe("PDF only.")
  })

  it("locally, says PDF only", async () => {
    render(<SourcePicker value={{}} onChange={() => {}} />)
    await screen.findByText("No files uploaded yet. Upload a PDF to start.")
    expect(limitsLine()).toBe("PDF only.")
  })

  it("refuses a file that is not a PDF without sending it", async () => {
    render(<SourcePicker value={{}} onChange={() => {}} />)
    await screen.findByText("No files uploaded yet. Upload a PDF to start.")
    choose(new File(["hello"], "notes.txt", { type: "text/plain" }))
    expect((await screen.findByRole("alert")).textContent).toBe("Upload of notes.txt failed: Only PDF files can be uploaded.")
    expect(posts).toBe(0)
    expect((screen.getByLabelText("Upload a file") as HTMLInputElement).value).toBe("")
  })

  it("sends a file named .PDF even when the browser gives no type", async () => {
    const onChange = vi.fn()
    render(<SourcePicker value={{}} onChange={onChange} />)
    await screen.findByText("No files uploaded yet. Upload a PDF to start.")
    choose(new File([new Uint8Array(100)], "report.PDF", { type: "" }))
    await waitFor(() => expect(posts).toBe(1))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ sha: SAMPLE.sha, filename: SAMPLE.filename }))
  })

  it("in demo mode, refuses a file over the size limit without sending it", async () => {
    settings = { demo: true, limits: LIMITS }
    render(<SourcePicker value={{}} onChange={() => {}} />)
    await waitFor(() => expect(limitsLine()).toBe("PDF only, up to 10 MB and 20 pages."))
    choose(sized("big.pdf", 10485761))
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Upload of big.pdf failed: This file is 10.0 MB. The hosted demo takes files up to 10 MB. Or split out the pages you need and upload those.",
    )
    expect(posts).toBe(0)
  })

  it("in demo mode, sends a file of exactly the size limit", async () => {
    settings = { demo: true, limits: LIMITS }
    render(<SourcePicker value={{}} onChange={() => {}} />)
    await waitFor(() => expect(limitsLine()).toBe("PDF only, up to 10 MB and 20 pages."))
    choose(sized("edge.pdf", 10485760))
    await waitFor(() => expect(posts).toBe(1))
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
