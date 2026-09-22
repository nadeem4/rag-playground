import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AppHeader } from "@/components/AppHeader"
import { NodeCard } from "@/components/pipeline/NodeCard"
import { Shell } from "@/routes/Shell"
import { TEST_REGISTRY } from "@/state/testRegistry"

import { ApiKeyProvider, checkMessage, keyShortLabel, keySourceLabel, needsKey } from "./apiKey"
import { api, KEY_HEADERS, keyHeaders } from "./client"
import type { LlmProvider } from "./types"

// Obviously fake keys. Never a real one in a test.
const FAKE: Record<LlmProvider, string> = {
  anthropic: "sk-ant-FAKE-test-key-0000",
  openai: "sk-FAKE-openai-test-key-1111",
  custom: "FAKE-custom-test-key-2222",
}
const PROVIDERS: LlmProvider[] = ["anthropic", "openai", "custom"]
const LABEL: Record<LlmProvider, string> = {
  anthropic: "Anthropic API key",
  openai: "OpenAI API key",
  custom: "Custom endpoint API key",
}
const ROW: Record<LlmProvider, string> = { anthropic: "Anthropic", openai: "OpenAI", custom: "Custom endpoint" }
const H = (p: LlmProvider) => KEY_HEADERS[p].toLowerCase()

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
let servers: Record<LlmProvider, string> = { anthropic: "none", openai: "none", custom: "none" }

function headersOf(init?: RequestInit): Record<string, string> {
  const h = new Headers(init?.headers)
  const out: Record<string, string> = {}
  h.forEach((v, k) => (out[k.toLowerCase()] = v))
  return out
}

beforeEach(() => {
  sent = []
  servers = { anthropic: "none", openai: "none", custom: "none" }
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
      if (url === "/api/settings/llm") return ok(servers)
      if (url === "/api/settings/llm/check") {
        const p = JSON.parse(String(init?.body)).provider as LlmProvider
        const has = headersOf(init)[H(p)]
        return ok(has ? { ok: false, source: "header", error: "invalid key" } : { ok: true, source: "dotenv", error: null })
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
  const panel = screen.queryByRole("dialog", { name: "API keys" })
  if (panel) return panel
  fireEvent.click(screen.getByTestId("api-key-button"))
  return screen.getByRole("dialog", { name: "API keys" })
}

const row = (p: LlmProvider) => within(openPanel()).getByRole("group", { name: ROW[p] })

function enterKey(p: LlmProvider, key: string) {
  const r = row(p)
  fireEvent.change(within(r).getByLabelText(LABEL[p]), { target: { value: key } })
  fireEvent.click(within(r).getByRole("button", { name: "Apply" }))
  return r
}

const runPosts = () => sent.filter((s) => s.url === "/api/runs" && s.method === "POST")

describe("keyHeaders", () => {
  it("names one header per provider", () => {
    expect(KEY_HEADERS).toEqual({
      anthropic: "X-Anthropic-Api-Key",
      openai: "X-OpenAI-Api-Key",
      custom: "X-Custom-Api-Key",
    })
  })

  it("adds a header only for each key that is set", () => {
    expect(keyHeaders({ anthropic: FAKE.anthropic, openai: null, custom: "  " })).toEqual({ "X-Anthropic-Api-Key": FAKE.anthropic })
    expect(keyHeaders({ openai: FAKE.openai, custom: FAKE.custom })).toEqual({
      "X-OpenAI-Api-Key": FAKE.openai,
      "X-Custom-Api-Key": FAKE.custom,
    })
    expect(keyHeaders(null)).toEqual({})
    expect(keyHeaders(undefined)).toEqual({})
  })

  it("createRun and createSweep send every set key, and only when asked to", async () => {
    await api.createRun({ graph: { nodes: [], edges: [] } })
    await api.createRun({ graph: { nodes: [], edges: [] } }, { keys: FAKE })
    await api.createSweep({ graph: { nodes: [], edges: [] }, node_id: "x", variants: [] }, { keys: null })
    await api.createSweep({ graph: { nodes: [], edges: [] }, node_id: "x", variants: [] }, { keys: FAKE })
    for (const p of PROVIDERS) {
      expect(sent.map((s) => s.headers[H(p)] ?? null)).toEqual([null, FAKE[p], null, FAKE[p]])
    }
    // Never in a body or a URL.
    for (const k of Object.values(FAKE)) expect(sent.every((s) => !s.body.includes(k) && !s.url.includes(k))).toBe(true)
  })

  it("the check names its provider and carries only that provider's UI key", async () => {
    await api.checkLlm("openai")
    await api.checkLlm("openai", { keys: FAKE })
    expect(sent.map((s) => [s.url, s.method, JSON.parse(s.body), s.headers[H("openai")] ?? null])).toEqual([
      ["/api/settings/llm/check", "POST", { provider: "openai" }, null],
      ["/api/settings/llm/check", "POST", { provider: "openai" }, FAKE.openai],
    ])
    expect(sent[1].headers[H("anthropic")]).toBeUndefined()
    expect(sent[1].headers[H("custom")]).toBeUndefined()
  })

  it("other requests never carry a key", async () => {
    await api.registry()
    await api.llmSettings()
    await api.pages("ab")
    for (const p of PROVIDERS) expect(sent.every((s) => !(H(p) in s.headers))).toBe(true)
  })
})

describe("key source words", () => {
  it("names each source in plain words, a UI key first", () => {
    expect(keySourceLabel("anthropic", "dotenv", false)).toBe("Using the key from .env")
    expect(keySourceLabel("anthropic", "env", false)).toBe("Using ANTHROPIC_API_KEY from the environment")
    expect(keySourceLabel("openai", "env", false)).toBe("Using OPENAI_API_KEY from the environment")
    expect(keySourceLabel("custom", "env", false)).toBe("Using OPENAI_COMPATIBLE_API_KEY from the environment")
    expect(keySourceLabel("openai", "none", false)).toBe("No key set")
    expect(keySourceLabel("openai", null, false)).toBe("No key set")
    expect(keySourceLabel("custom", "none", false)).toBe("No key set. A local server may need none.")
    for (const s of ["env", "dotenv", "none"] as const) {
      expect(keySourceLabel("openai", s, true)).toBe("Using the key entered here, this tab only, cleared on reload")
    }
  })

  it("the header badge counts the providers that have a key", () => {
    const none = { anthropic: null, openai: null, custom: null }
    const allNone = { anthropic: "none", openai: "none", custom: "none" } as const
    expect(keyShortLabel(null, none)).toBe("")
    expect(keyShortLabel(allNone, none)).toBe("not set")
    expect(keyShortLabel({ ...allNone, anthropic: "dotenv" }, none)).toBe("1 set")
    expect(keyShortLabel({ ...allNone, anthropic: "dotenv" }, { ...none, anthropic: FAKE.anthropic, openai: FAKE.openai })).toBe("2 set")
    expect(keyShortLabel(null, { ...none, custom: FAKE.custom })).toBe("1 set")
  })

  it("says what a check found", () => {
    expect(checkMessage("anthropic", { ok: true, source: "dotenv", error: null })).toEqual({ ok: true, text: "The key works. Checked the key from .env." })
    expect(checkMessage("openai", { ok: true, source: "env", error: null }).text).toBe("The key works. Checked OPENAI_API_KEY from the environment.")
    expect(checkMessage("openai", { ok: false, source: "header", error: "401" }).ok).toBe(false)
    expect(checkMessage("openai", { ok: false, source: "none", error: null }).text).toMatch(/no key to check/)
    // A hosted demo ignores .env, so the message must not point there.
    expect(checkMessage("openai", { ok: false, source: "none", error: null }).text).not.toMatch(/\.env/)
  })

  it("points a chat failure about a key to the control, nothing else", () => {
    expect(needsKey("chat", "ValueError: No Anthropic API key. Add one in the UI (API key, top right) or put ANTHROPIC_API_KEY in .env.")).toBe(true)
    expect(needsKey("chat", "anthropic.AuthenticationError: invalid x-api-key")).toBe(true)
    expect(needsKey("chat", "RuntimeError: No OpenAI API key. Set OPENAI_API_KEY.")).toBe(true)
    expect(needsKey("chat", "ValueError: max_chunks must be positive")).toBe(false)
    expect(needsKey("search", "No API key")).toBe(false)
  })
})

describe("the API key panel", () => {
  it("has one row per provider, each showing the server's source", async () => {
    servers = { anthropic: "dotenv", openai: "env", custom: "none" }
    await page()
    await waitFor(() => expect(within(row("anthropic")).getByTestId("key-source").textContent).toBe("Using the key from .env"))
    expect(within(row("openai")).getByTestId("key-source").textContent).toBe("Using OPENAI_API_KEY from the environment")
    expect(within(row("custom")).getByTestId("key-source").textContent).toBe("No key set. A local server may need none.")
    expect(screen.getByTestId("api-key-button").textContent).toContain("2 set")
  })

  it.each(PROVIDERS)("%s: applying shows this tab's key, empties the field, and Clear restores the server's", async (p) => {
    servers = { anthropic: "dotenv", openai: "dotenv", custom: "dotenv" }
    await page()
    await waitFor(() => expect(within(row(p)).getByTestId("key-source").textContent).toBe("Using the key from .env"))
    const r = enterKey(p, FAKE[p])
    expect(within(r).getByTestId("key-source").textContent).toBe("Using the key entered here, this tab only, cleared on reload")
    // The field is emptied: the key is not left sitting in the DOM.
    expect((within(r).getByLabelText(LABEL[p]) as HTMLInputElement).value).toBe("")
    // The other rows are untouched.
    for (const q of PROVIDERS.filter((q) => q !== p)) {
      expect(within(row(q)).getByTestId("key-source").textContent).toBe("Using the key from .env")
    }
    fireEvent.click(within(r).getByRole("button", { name: "Clear" }))
    expect(within(r).getByTestId("key-source").textContent).toBe("Using the key from .env")
  })

  it("says in plain words what happens to a key", async () => {
    await page()
    expect(within(openPanel()).getByTestId("key-privacy").textContent).toBe(
      "The key stays in this tab's memory. It is never saved, and a reload clears it. It is sent only to this app's server.",
    )
  })

  it.each(PROVIDERS)("%s: the field is a nameless password input, so a native submit could not put it in a URL", async (p) => {
    await page()
    const input = within(row(p)).getByLabelText(LABEL[p]) as HTMLInputElement
    expect(input.type).toBe("password")
    expect(input.getAttribute("name")).toBeNull()
    expect(input.getAttribute("autocomplete")).toBe("off")
    // No action and no method, so even a submit the handler missed would not
    // navigate, which is what a password manager watches for.
    const form = input.closest("form") as HTMLFormElement
    expect(form.getAttribute("autocomplete")).toBe("off")
    expect(form.getAttribute("action")).toBeNull()
    expect(form.getAttribute("method")).toBeNull()
  })

  it("never echoes a key back into the page or the tab title", async () => {
    await page()
    for (const p of PROVIDERS) enterKey(p, FAKE[p])
    for (const p of PROVIDERS) {
      expect(document.body.textContent).not.toContain(FAKE[p])
      expect(document.body.innerHTML).not.toContain(FAKE[p])
      expect(document.title).not.toContain(FAKE[p])
    }
  })

  it("keeps a key out of the console and out of a failed check's message", async () => {
    const methods = ["log", "info", "warn", "error", "debug"] as const
    const spies = methods.map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    try {
      await page()
      const r = enterKey("anthropic", FAKE.anthropic)
      fireEvent.click(within(r).getByRole("button", { name: "Check key" }))
      await waitFor(() => expect(within(r).getByTestId("key-check").textContent).toMatch(/did not work/))
      expect(within(r).getByTestId("key-check").textContent).not.toContain(FAKE.anthropic)
      const said = spies.flatMap((s) => s.mock.calls).map((c) => c.map(String).join(" ")).join("\n")
      expect(said).not.toContain(FAKE.anthropic)
    } finally {
      spies.forEach((s) => s.mockRestore())
    }
  })

  it("custom: no Check (it needs the endpoint's URL); says when it is checked instead", async () => {
    await page()
    const r = row("custom")
    expect(within(r).queryByRole("button", { name: "Check key" })).toBeNull()
    expect(within(r).getByText("Checked when chat runs against your endpoint.")).toBeTruthy()
  })

  it.each(["anthropic", "openai"] as const)("%s: its own Check sends its own key and shows the result in its row", async (p) => {
    await page()
    const r = enterKey(p, FAKE[p])
    fireEvent.click(within(r).getByRole("button", { name: "Check key" }))
    await waitFor(() => expect(within(r).getByTestId("key-check").textContent).toMatch(/did not work/))
    const check = sent.find((s) => s.url === "/api/settings/llm/check")!
    expect(JSON.parse(check.body)).toEqual({ provider: p })
    expect(check.headers[H(p)]).toBe(FAKE[p])
  })

  it("a run sends no key header when none is set", async () => {
    await page()
    fireEvent.click(screen.getByRole("button", { name: "Run all" }))
    await waitFor(() => expect(runPosts()).toHaveLength(1))
    for (const p of PROVIDERS) expect(runPosts()[0].headers[H(p)]).toBeUndefined()
  })

  it("after entering every key and running, each is sent, and no storage, URL, graph or body holds any", async () => {
    await page()
    for (const p of PROVIDERS) enterKey(p, FAKE[p])
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    fireEvent.click(screen.getByRole("button", { name: "Run all" }))
    await waitFor(() => expect(runPosts()).toHaveLength(1))
    const post = runPosts()[0]
    const graph = window.localStorage.getItem("rag-playground:graph:v1")
    expect(graph).toBeTruthy()
    for (const p of PROVIDERS) {
      const k = FAKE[p]
      expect(post.headers[H(p)]).toBe(k)
      expect(graph).not.toContain(k)
      expect(post.body).not.toContain(k)
      for (const n of JSON.parse(post.body).graph.nodes as { config: Record<string, unknown> }[]) {
        expect(JSON.stringify(n.config)).not.toContain(k)
      }
      expect(storageText(window.localStorage)).not.toContain(k)
      expect(storageText(window.sessionStorage)).not.toContain(k)
      expect(window.location.href).not.toContain(k)
      expect(document.cookie).not.toContain(k)
      expect(sent.every((s) => !s.url.includes(k))).toBe(true)
    }
  })

  it("a remount (a reload) starts with no keys", async () => {
    await page()
    for (const p of PROVIDERS) enterKey(p, FAKE[p])
    cleanup()
    sent = []
    await page()
    fireEvent.click(screen.getByRole("button", { name: "Run all" }))
    await waitFor(() => expect(runPosts()).toHaveLength(1))
    for (const p of PROVIDERS) expect(runPosts()[0].headers[H(p)]).toBeUndefined()
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
    await waitFor(() => expect(screen.getByRole("dialog", { name: "API keys" })).toBeTruthy())
  })
})
