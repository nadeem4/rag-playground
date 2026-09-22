import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiKeyProvider } from "@/api/apiKey"
import { pageFor } from "@/App"
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
  it("shows Build, Compare and Learn as primary navigation", () => {
    header()
    const main = screen.getByRole("navigation", { name: "Main" })
    const links = within(main).getAllByRole("link")
    expect(links.map((l) => l.textContent)).toEqual(["Build", "Compare", "Learn"])
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/", "/compare", "/learn"])
    expect(screen.queryByText("Forms")).toBeNull()
    expect(screen.queryByText("Tokens")).toBeNull()
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

  it("marks Learn as current on any Learn topic", () => {
    header("/learn/citations")
    expect(screen.getByRole("link", { name: "Learn" }).getAttribute("aria-current")).toBe("page")
  })

  it("has a Learn mode switch, on for a first visit, remembered when turned off", () => {
    header()
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

  it("renders Learn at /learn and at each topic", () => {
    expect(pageFor("/learn")).toBe(Learn)
    expect(pageFor("/learn/chunking")).toBe(Learn)
    expect(pageFor("/learn/citations")).toBe(Learn)
    expect(topicFor("/learn")).toBe("chunking")
    expect(topicFor("/learn/citations")).toBe("citations")
    expect(topicFor("/learn/nope")).toBe("chunking")
  })

  it("keeps /inspect", () => {
    expect(pageFor("/inspect")).toBe(Inspect)
  })

  it("no longer has a /forms gallery: it falls through to Build like any unknown path", () => {
    expect(pageFor("/forms")).toBe(Shell)
    expect(pageFor("/nope")).toBe(Shell)
    expect(pageFor("/")).toBe(Shell)
  })
})
