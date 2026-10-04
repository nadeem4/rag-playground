import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetAppSettingsForTests } from "@/api/useDemo"
import { resetDocumentForTests } from "@/state/document"
import { resetStoredGraphForTests } from "@/state/graph"
import { ApiKeyProvider } from "@/api/apiKey"
import { pageFor, routeFor } from "@/App"
import { Home } from "@/routes/Home"
import { Lessons } from "@/routes/Lessons"
import { Inspect } from "@/routes/Inspect"
import { Learn, topicFor } from "@/routes/Learn"
import { Shell } from "@/routes/Shell"
import { Specimen } from "@/routes/Specimen"

import { AppHeader } from "./AppHeader"

beforeEach(() => {
  resetAppSettingsForTests()
  window.localStorage.clear()
  resetStoredGraphForTests()
  resetDocumentForTests()
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
  it("shows Home, Lessons, Build, Compare, Evaluate, Read and Library as primary navigation", () => {
    header()
    const main = screen.getByRole("navigation", { name: "Main" })
    const links = within(main).getAllByRole("link")
    expect(links.map((l) => l.textContent)).toEqual(["Home", "Lessons", "Build", "Compare", "Evaluate", "Read", "Library"])
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/", "/learn", "/build", "/compare", "/evaluate", "/read", "/library"])
    expect(screen.queryByText("Forms")).toBeNull()
    expect(screen.queryByText("Tokens")).toBeNull()
  })

  it("links the brand to Home", () => {
    header("/build")
    expect(screen.getByRole("link", { name: "RAG Playground" }).getAttribute("href")).toBe("/")
  })

  it("marks Build as current on /build, Home on / and Lessons on /learn", () => {
    header("/build")
    expect(screen.getByRole("link", { name: "Build" }).getAttribute("aria-current")).toBe("page")
    cleanup()
    header("/")
    expect(screen.getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBe("page")
    expect(screen.getByRole("link", { name: "Lessons" }).getAttribute("aria-current")).toBeNull()
    cleanup()
    header("/learn")
    expect(screen.getByRole("link", { name: "Lessons" }).getAttribute("aria-current")).toBe("page")
    expect(screen.getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBeNull()
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

describe("the theme and contrast switches", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme
    delete document.documentElement.dataset.contrast
  })

  const option = (group: string, name: string) =>
    within(screen.getByRole("group", { name: group })).getByRole("button", { name }) as HTMLButtonElement

  it("the theme switch is a segmented control with System, Light and Dark", () => {
    header()
    expect(option("Theme", "System").getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(option("Theme", "Dark"))
    expect(option("Theme", "Dark").getAttribute("aria-pressed")).toBe("true")
    expect(option("Theme", "Dark").className).toContain("bg-accent-wash")
    expect(document.documentElement.dataset.theme).toBe("dark")
  })

  it("the contrast switch offers Normal and More contrast; More contrast sets data-contrast, Normal takes it off", () => {
    header()
    const names = within(screen.getByRole("group", { name: "Contrast" }))
      .getAllByRole("button")
      .map((b) => b.textContent)
    expect(names).toEqual(["Normal", "More contrast"])
    expect(option("Contrast", "Normal").getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(option("Contrast", "More contrast"))
    expect(document.documentElement.dataset.contrast).toBe("more")
    expect(option("Contrast", "More contrast").getAttribute("aria-pressed")).toBe("true")
    expect(window.localStorage.getItem("rag-contrast")).toBe("more")
    fireEvent.click(option("Contrast", "Normal"))
    expect(document.documentElement.hasAttribute("data-contrast")).toBe(false)
  })

  it("starts from a stored More contrast", () => {
    window.localStorage.setItem("rag-contrast", "more")
    header()
    expect(option("Contrast", "More contrast").getAttribute("aria-pressed")).toBe("true")
  })

  it("each switch is named by a small label before it: visible from md up, hidden from sight below", () => {
    header()
    for (const name of ["Theme", "Contrast"]) {
      const group = screen.getByRole("group", { name })
      const caption = group.firstElementChild!
      expect(caption.textContent).toBe(name)
      expect(group.getAttribute("aria-labelledby")).toBe(caption.id)
      const c = caption.className.split(/\s+/)
      expect(c).toContain("sr-only")
      expect(c).toContain("md:not-sr-only")
    }
  })
})

describe("the header on a phone", () => {
  it("puts the brand and the right cluster on the first row and the nav on its own row below md", () => {
    header()
    const nav = screen.getByRole("navigation", { name: "Main" })
    const c = nav.className.split(/\s+/)
    for (const k of ["flex-wrap", "min-w-0", "order-3", "w-full", "md:order-2", "md:w-auto"]) expect(c).toContain(k)
    const right = screen.getByTestId("header-controls").className.split(/\s+/)
    for (const k of ["order-2", "ml-auto", "md:order-5", "md:ml-0"]) expect(right).toContain(k)
  })

  it("gives the Document control its own full-width row under the tabs below md", () => {
    header()
    const c = screen.getByTestId("header-document").className.split(/\s+/)
    for (const k of ["order-4", "w-full", "md:ml-auto", "md:w-auto"]) expect(c).toContain(k)
  })

  it("keeps the inline switches for xl and up, and a Display menu holds them below xl, so the header is one row from md", async () => {
    header()
    const inline = screen.getByRole("group", { name: "Theme" }).parentElement!.className.split(/\s+/)
    expect(inline).toContain("hidden")
    expect(inline).toContain("xl:flex")
    const display = screen.getByRole("button", { name: "Display" })
    expect(display.className.split(/\s+/)).toContain("xl:hidden")
    fireEvent.click(display)
    const dialog = await screen.findByRole("dialog", { name: "Display" })
    expect(within(dialog).getByRole("group", { name: "Theme" })).toBeTruthy()
    expect(within(dialog).getByRole("group", { name: "Contrast" })).toBeTruthy()
    // In the menu the labels are always visible.
    expect(within(dialog).getByText("Contrast").className.split(/\s+/)).not.toContain("sr-only")
  })

  it("shortens the key button to Key at every width, with the full words as its title and its name", async () => {
    serve({ demo: true })
    header()
    const button = screen.getByTestId("api-key-button")
    const words = "Add a key for chat answers and the LLM reranker (optional)"
    await waitFor(() => expect(button.title).toBe(words))
    expect(button.textContent).toBe("Key")
    expect(button.getAttribute("aria-label")).toBe(words)
    expect(screen.getByRole("button", { name: words })).toBe(button)
  })

  it("caps the Document control so the header stays one row from md up", () => {
    header()
    const c = screen.getByTestId("document-trigger").className.split(/\s+/)
    for (const k of ["md:max-w-[240px]", "xl:max-w-[360px]"]) expect(c).toContain(k)
    expect(c).not.toContain("md:max-w-[360px]")
    // From md up its slot takes what the row has left rather than wrapping to a row of its own.
    const slot = screen.getByTestId("header-document").className.split(/\s+/)
    for (const k of ["md:flex-1", "md:basis-0", "md:justify-end"]) expect(slot).toContain(k)
    // The small Document label shows from lg, where there is room for it.
    expect(within(screen.getByTestId("document-trigger")).getByText("Document").className.split(/\s+/)).toContain("lg:inline")
  })
})

describe("AppHeader with the lessons hidden", () => {
  it("shows the Document control on every page, Read included", () => {
    for (const path of ["/build", "/compare", "/evaluate", "/read", "/design"]) {
      header(path, false)
      expect(screen.getByTestId("header-document")).toBeTruthy()
      expect(screen.getByTestId("document-trigger")).toBeTruthy()
      cleanup()
    }
  })

  it("never turns the control amber when the lists cannot be read", async () => {
    header("/build", false)
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByTestId("document-trigger").className).not.toContain("bg-stale-wash")
  })

  it("shows Home first, then Build, Compare, Evaluate, Read and Library, with no Lessons", () => {
    header("/build", false)
    const main = screen.getByRole("navigation", { name: "Main" })
    const links = within(main).getAllByRole("link")
    expect(links.map((l) => l.textContent)).toEqual(["Home", "Build", "Compare", "Evaluate", "Read", "Library"])
    expect(links[0].getAttribute("href")).toBe("/")
    expect(screen.queryByText("Lessons")).toBeNull()
  })

  it("links the brand to Home", () => {
    header("/build", false)
    expect(screen.getByRole("link", { name: "RAG Playground" }).getAttribute("href")).toBe("/")
  })

  it("leaves GitHub to Home, so the Home tab costs the Document control no width", () => {
    header("/build", false)
    expect(screen.queryByRole("link", { name: "GitHub" })).toBeNull()
  })

  it("marks Home as current on /", () => {
    header("/", false)
    expect(screen.getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBe("page")
  })

  it("marks Build as current on /build", () => {
    header("/build", false)
    expect(screen.getByRole("link", { name: "Build" }).getAttribute("aria-current")).toBe("page")
  })

  it("marks Library as current on /library", () => {
    header("/library", false)
    expect(screen.getByRole("link", { name: "Library" }).getAttribute("aria-current")).toBe("page")
  })

  it("marks Read as current on /read", () => {
    header("/read", false)
    expect(screen.getByRole("link", { name: "Read" }).getAttribute("aria-current")).toBe("page")
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
    await waitFor(() => expect(screen.getByTestId("api-key-button").textContent).toBe("Key"))
    expect(screen.getByTestId("api-key-button").getAttribute("aria-label")).toBe("Add a key for chat answers and the LLM reranker (optional)")
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

  it("lists the lessons at /learn", () => {
    expect(routeFor("/learn", true)).toBe("/learn")
    expect(pageFor(routeFor("/learn", true), true)).toBe(Lessons)
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
