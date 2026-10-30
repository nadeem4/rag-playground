import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import registryFixture from "@/api/fixtures/registry.json"
import templates from "@/api/fixtures/templates.json"
import type { Registry } from "@/api/types"
import { columnOrder } from "@/state/graph"

import { TemplatePicker } from "./TemplatePicker"

const registry = registryFixture as unknown as Registry
const CURRENT = { documents: [{ sha: "ab".repeat(32), filename: "report.pdf" }], question: { text: "What is it?", gold_answers: [] } }

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => (String(url).endsWith("/api/templates") ? new Response(JSON.stringify(templates)) : new Response("null", { status: 404 }))),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const card = (group: string, name: RegExp) => within(screen.getByRole("group", { name: group })).getByRole("button", { name })

async function open(onUse = vi.fn(), onClose = vi.fn()) {
  render(<TemplatePicker registry={registry} current={CURRENT} onUse={onUse} onClose={onClose} />)
  await screen.findByRole("group", { name: "1. What are your documents like?" })
  return { onUse, onClose }
}

describe("TemplatePicker", () => {
  it("shows both sets of cards from the server, with Text documents and Balanced picked", async () => {
    await open()
    const docs = "1. What are your documents like?"
    const qs = "2. What will you ask?"
    expect(card(docs, /Text documents/).getAttribute("aria-pressed")).toBe("true")
    expect(within(card(docs, /Text documents/)).getByText("Picked")).toBeTruthy()
    expect(within(card(docs, /Text documents/)).getByText(/pdfium · header_footer_strip/)).toBeTruthy()
    expect(card(qs, /Balanced/).getAttribute("aria-pressed")).toBe("true")
    expect(within(card(qs, /Chat answer/)).getByText("Needs a key")).toBeTruthy()
    expect(within(card(qs, /Balanced/)).queryByText("Needs a key")).toBeNull()
    expect(within(card(docs, /Text documents/)).getByText(/Good for:/)).toBeTruthy()
  })

  it("shows Tables across pages disabled, as coming next", async () => {
    await open()
    const soon = card("1. What are your documents like?", /Tables across pages/)
    expect((soon as HTMLButtonElement).disabled).toBe(true)
    expect(within(soon).getByText("Coming next")).toBeTruthy()
  })

  it("lists the composed steps, the key notice and the sample for what is picked", async () => {
    await open()
    fireEvent.click(card("1. What are your documents like?", /Manuals and guides/))
    fireEvent.click(card("2. What will you ask?", /Vague questions/))
    const panel = screen.getByRole("region", { name: "Your pipeline" })
    expect(within(panel).getByText("Manuals and guides")).toBeTruthy()
    expect(within(panel).getByText("llm_rewrite")).toBeTruthy()
    expect(within(panel).getByText("layout_blocks")).toBeTruthy()
    expect(within(panel).getByText(/Add your key in Settings before you Ask/)).toBeTruthy()
    expect(within(panel).getByText(/Try it on the sample/).textContent).toMatch(/station-manual/)
    fireEvent.click(card("2. What will you ask?", /Balanced/))
    expect(within(panel).queryByText(/Add your key in Settings/)).toBeNull()
  })

  it("shows the Web pages card, and no sample line for it", async () => {
    await open()
    fireEvent.click(card("1. What are your documents like?", /Web pages/))
    const panel = screen.getByRole("region", { name: "Your pipeline" })
    expect(within(panel).getByText("markdown_header")).toBeTruthy()
    expect(within(panel).queryByText(/Try it on the sample/)).toBeNull()
  })

  it("hands Build the composed column, on the document and question in use", async () => {
    const { onUse } = await open()
    fireEvent.click(card("1. What are your documents like?", /Reports with tables/))
    fireEvent.click(screen.getByRole("button", { name: "Use this pipeline" }))
    expect(onUse).toHaveBeenCalledTimes(1)
    const [made] = onUse.mock.calls[0]
    const order = columnOrder(made.graph)
    expect(order.find((n) => n.stage === "parse")?.config.table_mode).toBe("accurate")
    expect(order.find((n) => n.stage === "source")?.config.filename).toBe("report.pdf")
    expect(made.line).toBe("Build now holds Reports with tables with Balanced: 8 steps.")
  })

  it("leaves without a change from Keep my current pipeline", async () => {
    const { onUse, onClose } = await open()
    fireEvent.click(screen.getByRole("button", { name: "Keep my current pipeline" }))
    expect(onClose).toHaveBeenCalled()
    expect(onUse).not.toHaveBeenCalled()
  })

  it("says so when the templates cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })))
    render(<TemplatePicker registry={registry} current={CURRENT} onUse={vi.fn()} onClose={vi.fn()} />)
    expect(await screen.findByText("The templates could not be loaded. Close this and try again.")).toBeTruthy()
  })
})
