import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { FileInfo } from "@/lib/files"

import { DocumentTabs } from "./DocumentTabs"

afterEach(cleanup)

const FILES: FileInfo[] = [
  { sha: "a", filename: "report.pdf", slot: 1 },
  { sha: "b", filename: "notes.md", slot: 2 },
  { sha: "c", filename: "faq.txt", slot: 3 },
]

describe("DocumentTabs", () => {
  it("renders one tab per file with its name", () => {
    render(<DocumentTabs files={FILES} value="a" onChange={() => {}} />)
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["report.pdf", "notes.md", "faq.txt"])
  })

  it("marks the chosen tab selected", () => {
    render(<DocumentTabs files={FILES} value="b" onChange={() => {}} />)
    expect(screen.getByRole("tab", { name: "notes.md" }).getAttribute("aria-selected")).toBe("true")
    expect(screen.getByRole("tab", { name: "report.pdf" }).getAttribute("aria-selected")).toBe("false")
  })

  it("calls onChange with the sha of the clicked tab", () => {
    const onChange = vi.fn()
    render(<DocumentTabs files={FILES} value="a" onChange={onChange} />)
    fireEvent.click(screen.getByRole("tab", { name: "faq.txt" }))
    expect(onChange).toHaveBeenCalledWith("c")
  })

  it("moves with the arrow keys", () => {
    const onChange = vi.fn()
    render(<DocumentTabs files={FILES} value="a" onChange={onChange} />)
    fireEvent.keyDown(screen.getByRole("tab", { name: "report.pdf" }), { key: "ArrowRight" })
    expect(onChange).toHaveBeenLastCalledWith("b")
    fireEvent.keyDown(screen.getByRole("tab", { name: "report.pdf" }), { key: "ArrowLeft" })
    expect(onChange).toHaveBeenLastCalledWith("c")
  })

  it("shows a note beside a tab when given one", () => {
    render(<DocumentTabs files={FILES} value="a" onChange={() => {}} note={(sha) => (sha === "b" ? "12 chunks" : null)} />)
    expect(screen.getByText("12 chunks")).toBeTruthy()
  })

  it("renders nothing for one file", () => {
    const { container } = render(<DocumentTabs files={FILES.slice(0, 1)} value="a" onChange={() => {}} />)
    expect(container.innerHTML).toBe("")
  })
})
