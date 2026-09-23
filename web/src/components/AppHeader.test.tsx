import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiKeyProvider } from "@/api/apiKey"
import { canonicalPath, pageFor } from "@/App"
import { Home } from "@/routes/Home"
import { Inspect } from "@/routes/Inspect"
import { Learn, topicFor } from "@/routes/Learn"
import { readLearnMode, resetLearnModeForTests } from "@/state/learnMode"
import { Shell } from "@/routes/Shell"
import { Specimen } from "@/routes/Specimen"

import { AppHeader } from "./AppHeader"

beforeEach(() => {
  window.localStorage.clear()
  resetLearnModeForTests()
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ source: "none" }), { status: 200 })),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function header(path = "/") {
  render(
    <ApiKeyProvider>
      <AppHeader path={path} />
    </ApiKeyProvider>,
  )
}

const devButton = () => screen.getByRole("button", { name: "Dev" })

describe("AppHeader", () => {
  it("shows Lessons, Build, Compare, Evaluate and GitHub as primary navigation", () => {
    header()
    const main = screen.getByRole("navigation", { name: "Main" })
    const links = within(main).getAllByRole("link")
    expect(links.map((l) => l.textContent)).toEqual(["Lessons", "Build", "Compare", "Evaluate", "GitHub"])
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/",
      "/build",
      "/compare",
      "/evaluate",
      "https://github.com/nadeem4/rag-playground",
    ])
    expect(screen.queryByText("Forms")).toBeNull()
    expect(screen.queryByText("Tokens")).toBeNull()
  })

  it("links the brand to Home", () => {
    header("/build")
    expect(screen.getByRole("link", { name: "RAG Playground" }).getAttribute("href")).toBe("/")
  })

  it("marks Build as current on /build and Lessons on Home", () => {
    header("/build")
    expect(screen.getByRole("link", { name: "Build" }).getAttribute("aria-current")).toBe("page")
    cleanup()
    header("/")
    expect(screen.getByRole("link", { name: "Lessons" }).getAttribute("aria-current")).toBe("page")
  })

  it("keeps the dev pages out of sight until the Dev menu opens", () => {
    header()
    expect(devButton().getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByText("Inspectors")).toBeNull()
    expect(screen.queryByText("Design")).toBeNull()
  })

  it("opens the Dev menu from the keyboard and lists Inspectors and Design", async () => {
    header()
    fireEvent.keyDown(devButton(), { key: "Enter" })
    const menu = await screen.findByRole("menu")
    const items = within(menu).getAllByRole("menuitem")
    expect(items.map((i) => i.textContent)).toEqual(["Inspectors", "Design"])
    expect(items.map((i) => i.getAttribute("href"))).toEqual(["/inspect", "/design"])
  })

  it("closes the Dev menu on Escape", async () => {
    header()
    fireEvent.keyDown(devButton(), { key: "Enter" })
    const menu = await screen.findByRole("menu")
    fireEvent.keyDown(menu, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
  })

  it("marks Lessons as current on any lesson", () => {
    header("/learn/citations")
    expect(screen.getByRole("link", { name: "Lessons" }).getAttribute("aria-current")).toBe("page")
  })

  it("keeps the Learn mode switch off Home and the lessons, where it does nothing", () => {
    header("/")
    expect(screen.queryByRole("switch", { name: "Learn mode" })).toBeNull()
    cleanup()
    header("/learn/chunking")
    expect(screen.queryByRole("switch", { name: "Learn mode" })).toBeNull()
  })

  it("explains what Learn mode does, beside the switch", async () => {
    header("/build")
    fireEvent.click(screen.getByRole("button", { name: "What Learn mode does" }))
    const about = await screen.findByRole("dialog", { name: "About Learn mode" })
    expect(within(about).getByText(/adds a short explanation under every setting/)).toBeTruthy()
    expect(within(about).getByText(/Turn it off for a clean workbench\./)).toBeTruthy()
  })

  it("has a Learn mode switch on Build, on for a first visit, remembered when turned off", () => {
    header("/build")
    const sw = screen.getByRole("switch", { name: "Learn mode" }) as HTMLInputElement
    expect(sw.checked).toBe(true)
    fireEvent.click(sw)
    expect(sw.checked).toBe(false)
    resetLearnModeForTests()
    expect(readLearnMode()).toBe(false)
  })

  it("marks the Dev button as current on a dev page", () => {
    header("/design")
    expect(devButton().getAttribute("data-current")).toBe("true")
  })
})

describe("routes", () => {
  it("renders the design page at /design and at the old /specimen", () => {
    expect(pageFor("/design")).toBe(Specimen)
    expect(pageFor("/specimen")).toBe(Specimen)
  })

  it("renders Home at /, Build at /build, and each lesson under /learn", () => {
    expect(pageFor("/")).toBe(Home)
    expect(pageFor("/build")).toBe(Shell)
    expect(pageFor("/learn/end-to-end")).toBe(Learn)
    expect(pageFor("/learn/chunking")).toBe(Learn)
    expect(pageFor("/learn/citations")).toBe(Learn)
    expect(topicFor("/learn/end-to-end")).toBe("end-to-end")
    expect(topicFor("/learn/citations")).toBe("citations")
    expect(topicFor("/learn/nope")).toBe("end-to-end")
  })

  it("redirects /learn to Home", () => {
    expect(canonicalPath("/learn")).toBe("/")
    expect(pageFor(canonicalPath("/learn"))).toBe(Home)
    expect(canonicalPath("/build")).toBe("/build")
  })

  it("keeps /inspect", () => {
    expect(pageFor("/inspect")).toBe(Inspect)
  })

  it("sends an unknown path, including the removed /forms, to Home", () => {
    expect(pageFor("/forms")).toBe(Home)
    expect(pageFor("/nope")).toBe(Home)
  })
})
