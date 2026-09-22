import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { clearPdfCaches } from "@/api/usePdf"

import { CitationsLesson } from "./CitationsLesson"

const SHA = "12".repeat(32)
let finds: string[] = []

beforeEach(() => {
  finds = []
  clearPdfCaches()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b))
      if (url === `/api/sources/${SHA}/pages`) return ok([{ n: 1, width: 612, height: 792 }])
      if (url.startsWith(`/api/sources/${SHA}/pages/1/find`)) {
        finds.push(new URL(url, "http://x").searchParams.get("text")!)
        return ok({ rects: [[72, 600, 540, 612]], matched: "exact" })
      }
      return new Response("{}", { status: 404 })
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const tabs = () => screen.getAllByRole("tab")
const panel = () => screen.getByRole("tabpanel")

describe("How citations work", () => {
  it("has six steps and starts on the first, with every sentence numbered", () => {
    render(<CitationsLesson sha={SHA} onTry={() => {}} />)
    expect(tabs()).toHaveLength(6)
    expect(tabs()[0].getAttribute("aria-selected")).toBe("true")
    expect(within(panel()).getByRole("heading", { name: "We number every sentence" })).toBeTruthy()
    expect(within(panel()).getByText("[1.2]")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("moves with Next and Back, and jumps with a step", () => {
    render(<CitationsLesson sha={SHA} onTry={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "Next step" }))
    expect(within(panel()).getByRole("heading", { name: "We ask the model to cite numbers" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(within(panel()).getByRole("heading", { name: "We number every sentence" })).toBeTruthy()
    fireEvent.click(tabs()[5])
    expect(tabs()[5].getAttribute("aria-selected")).toBe("true")
    expect((screen.getByRole("button", { name: "Next step" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("shows each support score as a number against the pass line, with no filled bar", () => {
    render(<CitationsLesson sha={SHA} onTry={() => {}} />)
    fireEvent.click(tabs()[3])
    expect(within(panel()).getByText("0.86")).toBeTruthy()
    expect(within(panel()).getAllByText(/above the pass line of 0.55/).length).toBe(2)
    expect(within(panel()).getByText(/below the pass line of 0.55/)).toBeTruthy()
    expect(within(panel()).queryByRole("progressbar")).toBeNull()
  })

  it("clicking a claim finds its real sentence on the sample page and boxes it", async () => {
    render(<CitationsLesson sha={SHA} onTry={() => {}} />)
    fireEvent.click(tabs()[4])
    fireEvent.click(within(panel()).getByRole("button", { name: /A table can lose its caption/ }))
    await waitFor(() => expect(panel().querySelectorAll("[data-highlight]").length).toBe(1))
    expect(finds[0]).toMatch(/^A definition separated from the term it defines/)
    fireEvent.click(within(panel()).getByRole("button", { name: /Most teams use 500 tokens/ }))
    expect(within(panel()).getByText(/Nothing to show/)).toBeTruthy()
    expect(panel().querySelectorAll("[data-highlight]").length).toBe(0)
  })

  it("ends with Try it yourself", () => {
    const onTry = vi.fn()
    render(<CitationsLesson sha={SHA} onTry={onTry} />)
    fireEvent.click(tabs()[5])
    fireEvent.click(within(panel()).getByRole("button", { name: "Try it yourself" }))
    expect(onTry).toHaveBeenCalled()
  })

  it("uses no em-dashes and at most one middle dot per line", () => {
    render(<CitationsLesson sha={SHA} onTry={() => {}} />)
    for (let i = 0; i < 6; i++) {
      fireEvent.click(tabs()[i])
      const text = document.body.textContent ?? ""
      expect(text).not.toMatch(/[—–]/)
      for (const el of document.querySelectorAll("p, li, span, button")) expect((el.textContent ?? "").split("·").length).toBeLessThanOrEqual(2)
    }
  })
})
