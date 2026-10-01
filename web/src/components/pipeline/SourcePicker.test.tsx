import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetAppSettingsForTests } from "@/api/useDemo"

import { SourcePicker } from "./SourcePicker"

const SAMPLE = { sha: "cd".repeat(32), filename: "report.pdf", size: 100, content_type: "application/pdf" }
const LIMITS = { max_bytes: 10485760, max_pages: 20, max_files: 3, max_total_bytes: 52428800, ttl_hours: 24 }

let settings: unknown = { demo: false }
let posts = 0

beforeEach(() => {
  resetAppSettingsForTests()
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

describe("SourcePicker grouped file list", () => {
  const PRIMER = { sha: "cd".repeat(32), filename: "chunking-primer.pdf", size: 4096, content_type: "application/pdf" }
  const TWO_COL = { sha: "11".repeat(32), filename: "two-column-report.pdf", size: 8192, content_type: "application/pdf" }
  const MINE = { sha: "ab".repeat(32), filename: "mine.pdf", size: 2048, content_type: "application/pdf" }
  const card = (name: string, title: string, src: typeof PRIMER, question: string) => ({
    name,
    title,
    blurb: "b",
    shows: "s",
    stresses: "chunk",
    pages: 2,
    default: false,
    filename: src.filename,
    sha: src.sha,
    question,
  })
  const CARDS = [
    card("chunking-primer", "A primer on chunking", PRIMER, "What are the two steps?"),
    card("two-column-report", "A two-column report", TWO_COL, "How long did the survey run?"),
  ]

  let sources: unknown[] = []
  let samplesReply: () => Promise<Response>
  let sampleReply: () => Promise<Response>
  let posted: string[] = []

  beforeEach(() => {
    sources = [PRIMER, MINE]
    posted = []
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
    samplesReply = async () => ok(CARDS)
    sampleReply = async () => ok(TWO_COL)
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/settings/app") return ok({ demo: true })
        if (url === "/api/sources") return ok(sources)
        if (url === "/api/samples") return samplesReply()
        if (url === "/api/sources/sample" && init?.method === "POST") {
          posted.push(JSON.parse(String(init.body)).name)
          return sampleReply()
        }
        return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
      }),
    )
  })

  const pick = () => screen.findByLabelText("File") as Promise<HTMLSelectElement>
  const groups = (sel: HTMLSelectElement) =>
    [...sel.querySelectorAll("optgroup")].map((g) => [g.label, [...g.querySelectorAll("option")].map((o) => o.textContent)])
  const grouped = async () => {
    const sel = await pick()
    await waitFor(() => expect(sel.querySelectorAll("optgroup")).toHaveLength(2))
    return sel
  }

  it("lists every sample under Samples and only this browser's files under Your uploads", async () => {
    render(<SourcePicker value={{}} onChange={() => {}} />)
    const sel = await grouped()
    expect(groups(sel)).toEqual([
      ["Samples", ["A primer on chunking", "A two-column report"]],
      ["Your uploads", ["mine.pdf"]],
    ])
    const values = [...sel.querySelectorAll("optgroup option")].map((o) => (o as HTMLOptionElement).value)
    expect(values).toEqual(["sample:chunking-primer", "sample:two-column-report", MINE.sha])
    expect(screen.queryByLabelText("Load a sample")).toBeNull()
  })

  it("says No uploads yet when this browser has no files, even with no files listed at all", async () => {
    sources = []
    render(<SourcePicker value={{}} onChange={() => {}} />)
    const sel = await grouped()
    const none = within(sel.querySelectorAll("optgroup")[1] as HTMLElement).getByRole("option", { name: "No uploads yet" }) as HTMLOptionElement
    expect(none.disabled).toBe(true)
    expect(groups(sel)[0][1]).toEqual(["A primer on chunking", "A two-column report"])
  })

  it("loads a chosen sample, disabling the select meanwhile, and hands back the source with the sample's question", async () => {
    let release!: () => void
    sampleReply = () => new Promise((r) => (release = () => r(new Response(JSON.stringify(TWO_COL), { status: 200 }))))
    const onSample = vi.fn()
    const onChange = vi.fn()
    render(<SourcePicker value={{}} onChange={onChange} onSample={onSample} />)
    const sel = await grouped()
    fireEvent.change(sel, { target: { value: "sample:two-column-report" } })
    await waitFor(() => expect(sel.disabled).toBe(true))
    release()
    await waitFor(() => expect(onSample).toHaveBeenCalledWith(TWO_COL, "How long did the survey run?"))
    expect(posted).toEqual(["two-column-report"])
    expect(onChange).not.toHaveBeenCalled()
    await waitFor(() => expect(sel.disabled).toBe(false))
  })

  it("without onSample, a chosen sample sets the file through onChange", async () => {
    const onChange = vi.fn()
    render(<SourcePicker value={{}} onChange={onChange} />)
    fireEvent.change(await grouped(), { target: { value: "sample:two-column-report" } })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ sha: TWO_COL.sha, filename: TWO_COL.filename }))
  })

  it("choosing an upload sets that file", async () => {
    const onChange = vi.fn()
    render(<SourcePicker value={{}} onChange={onChange} />)
    fireEvent.change(await grouped(), { target: { value: MINE.sha } })
    expect(onChange).toHaveBeenCalledWith({ sha: MINE.sha, filename: MINE.filename })
    expect(posted).toEqual([])
  })

  it("names the sample in a failed load", async () => {
    sampleReply = async () => new Response(JSON.stringify({ detail: "boom" }), { status: 500 })
    render(<SourcePicker value={{}} onChange={() => {}} />)
    fireEvent.change(await grouped(), { target: { value: "sample:two-column-report" } })
    expect((await screen.findByRole("alert")).textContent).toBe("Could not load A two-column report: boom")
  })

  it("shows a pipeline's sample selected under Samples, not missing", async () => {
    render(<SourcePicker value={{ sha: PRIMER.sha, filename: PRIMER.filename }} onChange={() => {}} />)
    const sel = await grouped()
    expect(sel.value).toBe("sample:chunking-primer")
    expect(screen.queryByText(/\(missing\)/)).toBeNull()
  })

  it("shows a sample selected even when this browser has never loaded it", async () => {
    sources = [MINE]
    render(<SourcePicker value={{ sha: TWO_COL.sha, filename: TWO_COL.filename }} onChange={() => {}} />)
    expect((await grouped()).value).toBe("sample:two-column-report")
  })

  it("shows an upload selected by its sha", async () => {
    render(<SourcePicker value={{ sha: MINE.sha, filename: MINE.filename }} onChange={() => {}} />)
    expect((await grouped()).value).toBe(MINE.sha)
  })

  it("shows a file this browser does not have as missing", async () => {
    render(<SourcePicker value={{ sha: "99".repeat(32), filename: "gone.pdf" }} onChange={() => {}} />)
    const sel = await grouped()
    expect(sel.value).toBe("")
    const missing = within(sel).getByRole("option", { name: "gone.pdf (missing)" }) as HTMLOptionElement
    expect(missing.disabled).toBe(true)
    expect(missing.selected).toBe(true)
  })

  it("says Pick a file when nothing is chosen", async () => {
    render(<SourcePicker value={{}} onChange={() => {}} />)
    const sel = await grouped()
    const first = sel.options[0]
    expect(first.textContent).toBe("Pick a file")
    expect(first.disabled).toBe(true)
    expect(sel.value).toBe("")
  })

  it("with samples off, lists only your uploads once samples arrive, with no groups and no sample select", async () => {
    render(<SourcePicker value={{}} onChange={() => {}} samples={false} />)
    const sel = await pick()
    await waitFor(() => expect([...sel.options].map((o) => o.textContent)).toEqual(["Pick a file", "mine.pdf"]))
    expect(sel.querySelectorAll("optgroup")).toHaveLength(0)
    expect(screen.queryByLabelText("Load a sample")).toBeNull()
  })

  it("with samples off and no files, keeps the empty sentence", async () => {
    sources = []
    render(<SourcePicker value={{}} onChange={() => {}} samples={false} />)
    expect(await screen.findByText("No files yet. Upload a PDF, or load a sample.")).toBeTruthy()
    expect(document.querySelector("select")).toBeNull()
  })

  it("until the samples arrive, says it is loading and never shows a sample as an upload, then groups them", async () => {
    let settle!: () => void
    samplesReply = () => new Promise((r) => (settle = () => r(new Response(JSON.stringify(CARDS), { status: 200 }))))
    let listed = 0
    const base = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/sources") listed += 1
        return base(url, init)
      }),
    )
    render(<SourcePicker value={{}} onChange={() => {}} />)
    await waitFor(() => expect(listed).toBe(1))
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.getByRole("status").textContent).toBe("Loading uploaded files")
    expect(document.querySelector("select")).toBeNull()
    settle()
    const sel = await grouped()
    expect(groups(sel)[1]).toEqual(["Your uploads", ["mine.pdf"]])
  })

  it("when the samples cannot be read, lists every file in one list", async () => {
    samplesReply = async () => new Response(JSON.stringify({ detail: "down" }), { status: 500 })
    render(<SourcePicker value={{}} onChange={() => {}} />)
    const sel = await pick()
    await waitFor(() => expect([...sel.options].map((o) => o.textContent)).toEqual(["Pick a file", "chunking-primer.pdf", "mine.pdf"]))
    expect(sel.querySelectorAll("optgroup")).toHaveLength(0)
  })
})
