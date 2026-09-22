import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { FirstRun } from "./FirstRun"
import { SourcePicker } from "./SourcePicker"

const SAMPLE = { sha: "cd".repeat(32), filename: "chunking-primer.pdf", size: 4096, content_type: "application/pdf" }

let demo = false
let appCalls = 0

beforeEach(() => {
  demo = false
  appCalls = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url === "/api/settings/app") {
        appCalls += 1
        return ok({ demo })
      }
      if (url === "/api/sources") return ok([SAMPLE])
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const uploadButton = () => screen.queryByRole("button", { name: "Upload" })
const NOTE = "This is a hosted demo with a sample document. To use your own PDFs, run it locally."

describe("SourcePicker", () => {
  it("offers Upload outside demo mode", async () => {
    render(<SourcePicker value={{}} onChange={() => {}} />)
    await screen.findByLabelText("File")
    await waitFor(() => expect(appCalls).toBe(1))
    expect(uploadButton()).not.toBeNull()
  })

  it("hides Upload in demo mode, and still lists the sample", async () => {
    demo = true
    render(<SourcePicker value={{}} onChange={() => {}} />)
    const pick = (await screen.findByLabelText("File")) as HTMLSelectElement
    expect([...pick.options].map((o) => o.textContent)).toContain("chunking-primer.pdf")
    await waitFor(() => expect(appCalls).toBe(1))
    expect(uploadButton()).toBeNull()
    expect(screen.queryByLabelText("Upload a file")).toBeNull()
  })

  it("keeps Upload when the app settings cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => new Response(JSON.stringify(url === "/api/sources" ? [SAMPLE] : { detail: "x" }), { status: url === "/api/sources" ? 200 : 500 })),
    )
    render(<SourcePicker value={{}} onChange={() => {}} />)
    await screen.findByLabelText("File")
    expect(uploadButton()).not.toBeNull()
  })
})

describe("FirstRun", () => {
  it("outside demo mode: Upload and the sample, no demo note", async () => {
    render(<FirstRun onSource={() => {}} onSample={() => {}} />)
    await waitFor(() => expect(appCalls).toBeGreaterThan(0))
    await waitFor(() => expect(uploadButton()).not.toBeNull())
    expect(screen.getByTestId("try-sample").textContent).toBe("Try the sample document")
    expect(document.body.textContent).not.toContain("hosted demo")
  })

  it("in demo mode: no Upload, the sample stays, and one line points to running it locally", async () => {
    demo = true
    render(<FirstRun onSource={() => {}} onSample={() => {}} />)
    const note = await screen.findByTestId("demo-note")
    expect(note.textContent).toBe(NOTE)
    const link = screen.getByRole("link", { name: "run it locally" }) as HTMLAnchorElement
    expect(link.href).toBe("https://github.com/nadeem4/rag-playground")
    expect(uploadButton()).toBeNull()
    expect(screen.getByTestId("try-sample").textContent).toBe("Try the sample document")
  })
})
