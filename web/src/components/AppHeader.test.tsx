import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetAppSettingsForTests } from "@/api/useDemo"
import { ApiKeyProvider } from "@/api/apiKey"
import { pageFor, routeFor } from "@/App"
import { Home } from "@/routes/Home"
import { Inspect } from "@/routes/Inspect"
import { Learn, topicFor } from "@/routes/Learn"
import { Shell } from "@/routes/Shell"
import { Specimen } from "@/routes/Specimen"

import { AppHeader } from "./AppHeader"

beforeEach(() => {
  resetAppSettingsForTests()
  window.localStorage.clear()
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ source: "none" }), { status: 200 })),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function header(path = "/", lessonsEnabled = true) {
  render(
    <ApiKeyProvider>
      <AppHeader path={path} lessonsEnabled={lessonsEnabled} />
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

  it("has no Learn mode switch and no pop-over on Build: the lessons are always shown", () => {
    header("/build")
    expect(screen.queryByRole("switch", { name: "Learn mode" })).toBeNull()
    expect(screen.queryByRole("button", { name: "What Learn mode does" })).toBeNull()
  })

  it("marks the Dev button as current on a dev page", () => {
    header("/design")
    expect(devButton().getAttribute("data-current")).toBe("true")
  })
})

describe("AppHeader with the lessons hidden", () => {
  it("shows Build, Compare, Evaluate and GitHub, with no Lessons", () => {
    header("/build", false)
    const main = screen.getByRole("navigation", { name: "Main" })
    const links = within(main).getAllByRole("link")
    expect(links.map((l) => l.textContent)).toEqual(["Build", "Compare", "Evaluate", "GitHub"])
    expect(screen.queryByText("Lessons")).toBeNull()
  })

  it("links the brand to Build", () => {
    header("/build", false)
    expect(screen.getByRole("link", { name: "RAG Playground" }).getAttribute("href")).toBe("/build")
  })

  it("marks Build as current on /build", () => {
    header("/build", false)
    expect(screen.getByRole("link", { name: "Build" }).getAttribute("aria-current")).toBe("page")
  })
})

function serve(app: { demo: boolean }, keys: Record<string, string> = { anthropic: "none", openai: "none", custom: "none" }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/settings/app") return new Response(JSON.stringify(app), { status: 200 })
      if (url === "/api/settings/llm") return new Response(JSON.stringify(keys), { status: 200 })
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
    }),
  )
}

describe("AppHeader on the demo", () => {
  it("hides the Dev menu on the hosted demo", async () => {
    serve({ demo: true })
    header()
    await waitFor(() => expect(screen.queryByText("Dev")).toBeNull())
  })

  it("shows the Dev menu when running locally", async () => {
    serve({ demo: false })
    header()
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some((c) => c[0] === "/api/settings/app")).toBe(true))
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByText("Dev")).toBeTruthy()
  })
})

describe("the key button", () => {
  it("offers a key for chat answers, as an option, when no key is set", async () => {
    serve({ demo: true })
    header()
    await waitFor(() => expect(screen.getByTestId("api-key-button").textContent).toBe("Add a key for chat answers (optional)"))
  })

  it("stays API key with a count when a key is set in this tab", async () => {
    serve({ demo: true })
    header()
    fireEvent.click(screen.getByTestId("api-key-button"))
    const panel = await screen.findByRole("dialog", { name: "API keys" })
    const row = within(panel).getByRole("group", { name: "Anthropic" })
    fireEvent.change(within(row).getByLabelText("Anthropic API key"), { target: { value: "sk-ant-test-0000" } })
    fireEvent.click(within(row).getByRole("button", { name: "Apply" }))
    await waitFor(() => expect(screen.getByTestId("api-key-button").textContent).toContain("1 set"))
    expect(screen.getByTestId("api-key-button").textContent).toContain("API key")
  })
})

describe("routes", () => {
  it("renders the design page at /design and at the old /specimen", () => {
    expect(pageFor("/design", true)).toBe(Specimen)
    expect(pageFor("/specimen", true)).toBe(Specimen)
  })

  it("renders Home at /, Build at /build, and each lesson under /learn", () => {
    expect(pageFor("/", true)).toBe(Home)
    expect(pageFor("/build", true)).toBe(Shell)
    expect(pageFor("/learn/end-to-end", true)).toBe(Learn)
    expect(pageFor("/learn/chunking", true)).toBe(Learn)
    expect(pageFor("/learn/citations", true)).toBe(Learn)
    expect(topicFor("/learn/end-to-end")).toBe("end-to-end")
    expect(topicFor("/learn/citations")).toBe("citations")
    expect(topicFor("/learn/nope")).toBe("end-to-end")
  })

  it("redirects /learn to Home", () => {
    expect(routeFor("/learn", true)).toBe("/")
    expect(pageFor(routeFor("/learn", true), true)).toBe(Home)
    expect(routeFor("/build", true)).toBe("/build")
  })

  it("keeps /inspect", () => {
    expect(pageFor("/inspect", true)).toBe(Inspect)
  })

  it("sends an unknown path, including the removed /forms, to Home", () => {
    expect(pageFor("/forms", true)).toBe(Home)
    expect(pageFor("/nope", true)).toBe(Home)
  })
})
