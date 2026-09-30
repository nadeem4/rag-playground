import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { FirstRun } from "./FirstRun"
import { SourcePicker } from "./SourcePicker"

const SAMPLE = { sha: "cd".repeat(32), filename: "chunking-primer.pdf", size: 4096, content_type: "application/pdf" }

const SAMPLES = [
  {
    name: "chunking-primer",
    title: "A primer on chunking",
    blurb: "Three pages of notes on chunking.",
    shows: "Headings, a footer and a repeated paragraph.",
    stresses: "chunk",
    pages: 3,
    default: true,
    filename: "chunking-primer.pdf",
    sha: "cd".repeat(32),
    question: "What are the two steps?",
  },
  {
    name: "scanned-notes",
    title: "Scanned notes",
    blurb: "Two pages that are pictures of text.",
    shows: "Without OCR the parse returns nothing.",
    stresses: "parse",
    pages: 2,
    default: false,
    filename: "scanned-notes.pdf",
    sha: "ef".repeat(32),
    question: "What does a scanner actually do to a page?",
  },
]

let demo = false
let appCalls = 0
let posted: (string | null)[] = []

beforeEach(() => {
  demo = false
  appCalls = 0
  posted = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (url === "/api/settings/app") {
        appCalls += 1
        return ok({ demo })
      }
      if (url === "/api/sources") return ok([SAMPLE])
      if (url === "/api/samples") return ok(SAMPLES)
      if (url === "/api/sources/sample") {
        posted.push(init?.body ? JSON.parse(String(init.body)).name : null)
        return ok(SAMPLE)
      }
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const uploadButton = () => screen.queryByRole("button", { name: "Upload" })
const NOTE = "This is a hosted demo with sample documents. To use your own PDFs, run it locally."

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

  it("offers the samples not yet loaded under the file list, and loads one", async () => {
    const onChange = vi.fn()
    render(<SourcePicker value={{ sha: SAMPLE.sha, filename: SAMPLE.filename }} onChange={onChange} />)
    const pick = (await screen.findByLabelText("Load a sample")) as HTMLSelectElement
    expect([...pick.options].map((o) => o.textContent)).toEqual(["Pick one", "Scanned notes"])
    fireEvent.change(pick, { target: { value: "scanned-notes" } })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ sha: SAMPLE.sha, filename: SAMPLE.filename }))
    expect(posted).toEqual(["scanned-notes"])
  })

  it("hides its own sample select when told samples are offered elsewhere (F2)", async () => {
    render(<SourcePicker value={{ sha: SAMPLE.sha, filename: SAMPLE.filename }} onChange={() => {}} samples={false} />)
    await screen.findByLabelText("File")
    expect(screen.queryByLabelText("Load a sample")).toBeNull()
  })

  it("names the sample in a failed load, disables the select meanwhile, and clears the message on a later success", async () => {
    const onChange = vi.fn()
    let fail = true
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
        if (url === "/api/sources") return ok([SAMPLE])
        if (url === "/api/samples") return ok(SAMPLES)
        if (url === "/api/sources/sample") {
          posted.push(init?.body ? JSON.parse(String(init.body)).name : null)
          return fail ? new Response(JSON.stringify({ detail: "boom" }), { status: 500 }) : ok(SAMPLE)
        }
        return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
      }),
    )
    render(<SourcePicker value={{ sha: SAMPLE.sha, filename: SAMPLE.filename }} onChange={onChange} />)
    const pick = (await screen.findByLabelText("Load a sample")) as HTMLSelectElement
    fireEvent.change(pick, { target: { value: "scanned-notes" } })
    expect(pick.disabled).toBe(true)
    const err = await screen.findByRole("alert")
    expect(err.textContent).toBe("Could not load Scanned notes: 500 /sources/sample: boom")
    await waitFor(() => expect(pick.disabled).toBe(false))

    fail = false
    fireEvent.change(pick, { target: { value: "scanned-notes" } })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ sha: SAMPLE.sha, filename: SAMPLE.filename }))
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
  })
})

describe("FirstRun", () => {
  it("lists every sample, the default first, with its title, blurb and the stage it stresses", async () => {
    render(<FirstRun onSource={() => {}} onSample={() => {}} />)
    const rows = await screen.findAllByRole("listitem")
    expect(rows.map((r) => within(r).getByRole("heading").textContent)).toEqual(["A primer on chunking", "Scanned notes"])
    expect(within(rows[1]).getByText("Two pages that are pictures of text.")).toBeTruthy()
    expect(within(rows[1]).getByText("parse")).toBeTruthy()
  })

  it("Load posts the sample's name and hands the source back, with the sample's own question (F6)", async () => {
    const onSample = vi.fn()
    render(<FirstRun onSource={() => {}} onSample={onSample} />)
    const rows = await screen.findAllByRole("listitem")
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Load" }))
    await waitFor(() => expect(onSample).toHaveBeenCalledWith(SAMPLE, "What does a scanner actually do to a page?"))
    expect(posted).toEqual(["scanned-notes"])
  })

  it("does not also offer the file picker's own sample select (F2)", async () => {
    render(<FirstRun onSource={() => {}} onSample={() => {}} />)
    await screen.findAllByRole("listitem")
    expect(screen.queryByLabelText("Load a sample")).toBeNull()
  })

  it("says so, and still shows Upload, when the sample list cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url === "/api/sources" ? [] : { detail: "down" }), { status: url === "/api/sources" ? 200 : 500 })))
    render(<FirstRun onSource={() => {}} onSample={() => {}} />)
    expect((await screen.findByRole("alert")).textContent).toMatch(/Could not list the samples/)
    await waitFor(() => expect(uploadButton()).not.toBeNull())
  })

  it("in demo mode: no Upload, the samples stay, and one line points to running it locally", async () => {
    demo = true
    render(<FirstRun onSource={() => {}} onSample={() => {}} />)
    const note = await screen.findByTestId("demo-note")
    expect(note.textContent).toBe(NOTE)
    expect(uploadButton()).toBeNull()
    expect(await screen.findAllByRole("listitem")).toHaveLength(2)
  })
})
