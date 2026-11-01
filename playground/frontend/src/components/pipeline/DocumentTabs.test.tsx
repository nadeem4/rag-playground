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

  it("links each tab to the pane it controls, and the pane back to the chosen tab", () => {
    render(
      <>
        <DocumentTabs files={FILES} value="b" onChange={() => {}} panelId="pane" />
        <div role="tabpanel" id="pane" />
      </>,
    )
    const tab = screen.getByRole("tab", { name: "notes.md" })
    expect(tab.getAttribute("aria-controls")).toBe("pane")
    expect(tab.id).toBeTruthy()
    expect(screen.getByRole("tab", { name: "report.pdf" }).id).not.toBe(tab.id)
  })

  it("jumps to the first and last tab with Home and End", () => {
    const onChange = vi.fn()
    render(<DocumentTabs files={FILES} value="b" onChange={onChange} />)
    fireEvent.keyDown(screen.getByRole("tab", { name: "notes.md" }), { key: "End" })
    expect(onChange).toHaveBeenLastCalledWith("c")
    fireEvent.keyDown(screen.getByRole("tab", { name: "notes.md" }), { key: "Home" })
    expect(onChange).toHaveBeenLastCalledWith("a")
  })

  it("renders nothing for one file", () => {
    const { container } = render(<DocumentTabs files={FILES.slice(0, 1)} value="a" onChange={() => {}} />)
    expect(container.innerHTML).toBe("")
  })
})

describe("DocumentTabs category line", () => {
  it("a tab shows the category name and its reason", () => {
    render(<DocumentTabs files={FILES} value="a" onChange={() => {}} note={(sha) => (sha === "a" ? "Reports with tables, by rule 2" : null)} />)
    expect(screen.getByRole("tab", { name: /report.pdf/ }).textContent).toContain("Reports with tables, by rule 2")
  })

  it("shows each tab's status when asked", () => {
    const st = { a: "done", b: "running", c: "failed" } as const
    render(<DocumentTabs files={FILES} value="a" onChange={() => {}} status={(sha) => st[sha as "a"]} />)
    expect(screen.getAllByTestId("tab-status").map((e) => e.getAttribute("data-status"))).toEqual(["done", "running", "failed"])
    expect(screen.getByRole("tab", { name: "notes.md, running" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "notes.md, running" }).textContent).toContain("notes.md, running")
    expect(screen.getByRole("tab", { name: /notes.md/ }).getAttribute("title")).toBe("notes.md: running")
  })

  it("shows no status dot without a status", () => {
    render(<DocumentTabs files={FILES} value="a" onChange={() => {}} />)
    expect(screen.queryByTestId("tab-status")).toBeNull()
  })
})
