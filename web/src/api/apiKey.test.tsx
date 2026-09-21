import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AppHeader } from "@/components/AppHeader"
import { NodeCard } from "@/components/pipeline/NodeCard"
import { Shell } from "@/routes/Shell"
import { TEST_REGISTRY } from "@/state/testRegistry"

import { ApiKeyProvider, checkMessage, keyShortLabel, keySourceLabel, needsKey } from "./apiKey"
import { api, KEY_HEADER, keyHeaders } from "./client"

// An obviously fake key. Never a real one in a test.
const FAKE = "sk-ant-FAKE-test-key-0000"

class SilentEventSource {
  onmessage = null
  onerror = null
  onopen = null
  close() {}
}
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const SOURCE = { sha: "ab".repeat(32), filename: "report.pdf", size: 2048, content_type: "application/pdf" }

interface Sent {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}
let sent: Sent[] = []
let serverSource = "none"

function headersOf(init?: RequestInit): Record<string, string> {
  const h = new Headers(init?.headers)
  const out: Record<string, string> = {}
  h.forEach((v, k) => (out[k.toLowerCase()] = v))
  return out
}

beforeEach(() => {
  sent = []
  serverSource = "none"
  window.localStorage.clear()
  window.sessionStorage.clear()
  vi.stubGlobal("EventSource", SilentEventSource)
  vi.stubGlobal("ResizeObserver", NoopResizeObserver)
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({ url, method: init?.method ?? "GET", headers: headersOf(init), body: String(init?.body ?? "") })
      const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
      if (url === "/api/registry") return ok(TEST_REGISTRY)
      if (url === "/api/sources") return ok([SOURCE])
      if (url === "/api/settings/llm") return ok({ source: serverSource })
      if (url === "/api/settings/llm/check") {
        const has = headersOf(init)[KEY_HEADER.toLowerCase()]
        return ok(has ? { ok: false, source: "header", error: "invalid x-api-key" } : { ok: true, source: "dotenv", error: null })
      }
      if ((url === "/api/runs" || url === "/api/sweeps") && init?.method === "POST") return ok({ run_id: "r1" }, 202)
      if (url.endsWith("/pages")) return ok([{ n: 1, width: 612, height: 792 }])
      return ok({ detail: "not found" }, 404)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function storageText(s: Storage): string {
  let out = ""
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i)!
    out += k + "=" + s.getItem(k) + "\n"
  }
  return out
}

const card = (id: string) => document.querySelector(`[data-node-id="${id}"]`) as HTMLElement

async function page() {
  render(
    <ApiKeyProvider>
      <AppHeader path="/" />
      <Shell />
    </ApiKeyProvider>,
  )
  await waitFor(() => expect(card("parse")).toBeTruthy())
  const pick = await waitFor(() => within(card("source")).getByLabelText("File") as HTMLSelectElement)
  fireEvent.change(pick, { target: { value: SOURCE.sha } })
}

function openPanel() {
  fireEvent.click(screen.getByTestId("api-key-button"))
  return screen.getByRole("dialog", { name: "API key" })
}

function enterKey(key: string) {
  const panel = openPanel()
  fireEvent.change(within(panel).getByLabelText("Anthropic API key"), { target: { value: key } })
  fireEvent.click(within(panel).getByRole("button", { name: "Apply" }))
  return panel
}

const runPosts = () => sent.filter((s) => s.url === "/api/runs" && s.method === "POST")

describe("keyHeaders", () => {
  it("adds the header only when a key is set", () => {
    expect(keyHeaders(FAKE)).toEqual({ [KEY_HEADER]: FAKE })
    expect(keyHeaders(null)).toEqual({})
    expect(keyHeaders(undefined)).toEqual({})
    expect(keyHeaders("   ")).toEqual({})
  })

  it("createRun and createSweep send it only when asked to", async () => {
    await api.createRun({ graph: { nodes: [], edges: [] } })
    await api.createRun({ graph: { nodes: [], edges: [] } }, { apiKey: FAKE })
    await api.createSweep({ graph: { nodes: [], edges: [] }, node_id: "x", variants: [] }, { apiKey: null })
    await api.createSweep({ graph: { nodes: [], edges: [] }, node_id: "x", variants: [] }, { apiKey: FAKE })
    const keyed = sent.map((s) => s.headers[KEY_HEADER.toLowerCase()] ?? null)
    expect(keyed).toEqual([null, FAKE, null, FAKE])
    // Never in a body or a URL.
    expect(sent.every((s) => !s.body.includes(FAKE) && !s.url.includes(FAKE))).toBe(true)
  })

  it("the key check carries the header when a UI key is set, and not otherwise", async () => {
    await api.checkLlm()
    await api.checkLlm({ apiKey: FAKE })
    expect(sent.map((s) => [s.url, s.method, s.headers[KEY_HEADER.toLowerCase()] ?? null])).toEqual([
      ["/api/settings/llm/check", "POST", null],
      ["/api/settings/llm/check", "POST", FAKE],
    ])
  })

  it("other requests never carry it", async () => {
    await api.registry()
    await api.llmSettings()
    await api.pages("ab")
    expect(sent.every((s) => !(KEY_HEADER.toLowerCase() in s.headers))).toBe(true)
  })
})

describe("key source words", () => {
  it("names each source in plain words, a UI key first", () => {
    expect(keySourceLabel("dotenv", false)).toBe("Using the key from .env")
    expect(keySourceLabel("env", false)).toBe("Using ANTHROPIC_API_KEY from the environment")
    expect(keySourceLabel("none", false)).toBe("No key set")
    expect(keySourceLabel(null, false)).toBe("No key set")
    for (const s of ["env", "dotenv", "none"] as const) {
      expect(keySourceLabel(s, true)).toBe("Using the key entered here, this tab only, cleared on reload")
    }
    expect(keyShortLabel("none", false)).toBe("not set")
    expect(keyShortLabel("env", true)).toBe("this tab")
  })

  it("says what a check found", () => {
    expect(checkMessage({ ok: true, source: "dotenv", error: null })).toEqual({ ok: true, text: "The key works. Checked the key from .env." })
    expect(checkMessage({ ok: false, source: "header", error: "401" }).ok).toBe(false)
    expect(checkMessage({ ok: false, source: "none", error: null }).text).toMatch(/no key to check/)
  })

  it("points a chat failure about the key to the control, nothing else", () => {
    expect(needsKey("chat", "ValueError: No Anthropic API key. Add one in the UI (API key, top right) or put ANTHROPIC_API_KEY in .env.")).toBe(true)
    expect(needsKey("chat", "anthropic.AuthenticationError: invalid x-api-key")).toBe(true)
    expect(needsKey("chat", "ValueError: max_chunks must be positive")).toBe(false)
    expect(needsKey("search", "No API key")).toBe(false)
  })
})

describe("the API key control", () => {
  it("shows the server's source, then this tab's once a key is applied", async () => {
    serverSource = "dotenv"
    await page()
    const panel = openPanel()
    await waitFor(() => expect(within(panel).getByTestId("key-source").textContent).toBe("Using the key from .env"))
    fireEvent.change(within(panel).getByLabelText("Anthropic API key"), { target: { value: FAKE } })
    fireEvent.click(within(panel).getByRole("button", { name: "Apply" }))
    expect(within(panel).getByTestId("key-source").textContent).toBe("Using the key entered here, this tab only, cleared on reload")
    // The field is emptied: the key is not left sitting in the DOM.
    expect((within(panel).getByLabelText("Anthropic API key") as HTMLInputElement).value).toBe("")
    fireEvent.click(within(panel).getByRole("button", { name: "Clear" }))
    expect(within(panel).getByTestId("key-source").textContent).toBe("Using the key from .env")
  })

  it("the field is a nameless password input, so a native submit could not put it in a URL", async () => {
    await page()
    const input = within(openPanel()).getByLabelText("Anthropic API key") as HTMLInputElement
    expect(input.type).toBe("password")
    expect(input.getAttribute("name")).toBeNull()
    expect(input.getAttribute("autocomplete")).toBe("off")
  })

  it("Check key sends the UI key and shows the result", async () => {
    await page()
    const panel = enterKey(FAKE)
    fireEvent.click(within(panel).getByRole("button", { name: "Check key" }))
    await waitFor(() => expect(within(panel).getByTestId("key-check").textContent).toMatch(/did not work/))
    const check = sent.find((s) => s.url === "/api/settings/llm/check")!
    expect(check.headers[KEY_HEADER.toLowerCase()]).toBe(FAKE)
  })

  it("a run sends the header only when a key is set", async () => {
    await page()
    fireEvent.click(screen.getByRole("button", { name: "Run all" }))
    await waitFor(() => expect(runPosts()).toHaveLength(1))
    expect(runPosts()[0].headers[KEY_HEADER.toLowerCase()]).toBeUndefined()
  })

  it("after entering a key and running, no storage, URL, graph or body holds it", async () => {
    await page()
    enterKey(FAKE)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    fireEvent.click(screen.getByRole("button", { name: "Run all" }))
    await waitFor(() => expect(runPosts()).toHaveLength(1))
    const post = runPosts()[0]
    expect(post.headers[KEY_HEADER.toLowerCase()]).toBe(FAKE)

    // The stored graph exists, and does not contain the key.
    const graph = window.localStorage.getItem("rag-playground:graph:v1")
    expect(graph).toBeTruthy()
    expect(graph).not.toContain(FAKE)
    expect(post.body).not.toContain(FAKE)
    for (const n of JSON.parse(post.body).graph.nodes as { config: Record<string, unknown> }[]) {
      expect(JSON.stringify(n.config)).not.toContain(FAKE)
    }
    expect(storageText(window.localStorage)).not.toContain(FAKE)
    expect(storageText(window.sessionStorage)).not.toContain(FAKE)
    expect(window.location.href).not.toContain(FAKE)
    expect(document.cookie).not.toContain(FAKE)
    expect(sent.every((s) => !s.url.includes(FAKE))).toBe(true)
  })

  it("a remount (a reload) starts with no key", async () => {
    await page()
    enterKey(FAKE)
    cleanup()
    sent = []
    await page()
    fireEvent.click(screen.getByRole("button", { name: "Run all" }))
    await waitFor(() => expect(runPosts()).toHaveLength(1))
    expect(runPosts()[0].headers[KEY_HEADER.toLowerCase()]).toBeUndefined()
  })
})

describe("a chat card that failed for want of a key", () => {
  it("points to the API key control, and the link opens it", async () => {
    render(
      <ApiKeyProvider>
        <AppHeader path="/" />
        <NodeCard
          node={{ id: "use_case", stage: "use_case", transform: "chat", config: {} }}
          title="Chat"
          transforms={[]}
          result={{ id: "use_case", status: "failed", error: "Traceback (most recent call last):\nRuntimeError: No Anthropic API key. Set ANTHROPIC_API_KEY in .env or enter one in the UI." } as never}
          selected={false}
          busy={false}
          onSelect={() => {}}
          onTransform={() => {}}
          onConfig={() => {}}
          onRun={() => {}}
        />
      </ApiKeyProvider>,
    )
    expect(screen.getAllByText(/No Anthropic API key/).length).toBeGreaterThan(0)
    fireEvent.click(within(screen.getByTestId("key-hint")).getByRole("button", { name: "Open API key" }))
    await waitFor(() => expect(screen.getByRole("dialog", { name: "API key" })).toBeTruthy())
  })
})
