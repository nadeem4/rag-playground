import { useEffect } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiKeyProvider, useApiKey } from "@/api/apiKey"
import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"
import { resetAppSettingsForTests } from "@/api/useDemo"
import { resetWriteSessionsForTests, type WrittenSet } from "@/state/writeQuestions"

import { WriteQuestions } from "./WriteQuestions"

const registry = liveRegistry as unknown as Registry
const SHA = "cd".repeat(32)

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  closed = false
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onopen: ((ev: Event) => void) | null = null
  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }
  close() {
    this.closed = true
  }
  emit(seq: number, event: Record<string, unknown>) {
    act(() => {
      this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ ts: 1, ...event }), lastEventId: String(seq) }))
    })
  }
}

const WRITTEN: WrittenSet = {
  questions: [
    { id: "q1", question: "What two steps does RAG use?", gold_answers: ["First it finds passages, then it answers."], answer: "Find, then answer.", tags: [] },
    { id: "q2", question: "Why start a chunk at a heading?", gold_answers: ["A heading is a promise about what follows."], answer: "", tags: ["copied"] },
  ],
  dropped: [{ question: "What is chunk size?", reason: "Its gold passage is a heading, not a sentence." }],
  usage: { input_tokens: 8674, output_tokens: 2677, model: "claude-haiku-4-5" },
}

interface Served {
  generated: { body: unknown; headers: Record<string, string> }[]
  cancelled: string[]
}

const NO_SERVER_KEYS = { anthropic: "none", openai: "none", custom: "none", openrouter: "none" }

function serve({
  result = WRITTEN as unknown,
  ok = true,
  refuse,
  server = NO_SERVER_KEYS as Record<string, string>,
}: { result?: unknown; ok?: boolean; refuse?: { status: number; detail: string }; server?: Record<string, string> } = {}): Served {
  const served: Served = { generated: [], cancelled: [] }
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/settings/app") return json({ demo: false })
      if (url === "/api/v2/settings/models") return json(server)
      if (url === `/api/v2/documents/${SHA}/questions/generate` && init?.method === "POST") {
        served.generated.push({ body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> })
        return refuse ? json({ detail: refuse.detail }, refuse.status) : json({ run_id: "w1" }, 202)
      }
      if (url === "/api/v2/runs/w1/cancel") {
        served.cancelled.push("w1")
        return json({ run_id: "w1", cancel_requested: true }, 202)
      }
      if (url === "/api/v2/runs/w1")
        return json({ run_id: "w1", kind: "questions", status: ok ? "finished" : "failed", ok, cancel_requested: false, last_event_id: 3, events: [], result })
      return json({ detail: "not found" }, 404)
    }),
  )
  return served
}

/** Shows whether the Key dialog was asked to open. */
function KeyProbe({ anthropic }: { anthropic: string | null }) {
  const { setKey, panelOpen } = useApiKey()
  useEffect(() => setKey("anthropic", anthropic), [anthropic, setKey])
  return <p data-testid="key-panel">{panelOpen ? "open" : "closed"}</p>
}

function Page({ keyValue, onSave, saveError }: { keyValue: string | null; onSave: (file: File) => Promise<boolean>; saveError: string | null }) {
  return (
    <ApiKeyProvider>
      <KeyProbe anthropic={keyValue} />
      <WriteQuestions sha={SHA} filename="chunking-primer.pdf" registry={registry} locked={false} onSave={onSave} saveError={saveError} />
    </ApiKeyProvider>
  )
}

function setup({ key = "sk-ant-test" as string | null, onSave = vi.fn(async (_file: File) => true), saveError = null as string | null } = {}) {
  render(<Page keyValue={key} onSave={onSave} saveError={saveError} />)
  fireEvent.click(screen.getByRole("button", { name: "Write questions for me" }))
  return { onSave, sheet: () => screen.getByRole("dialog") }
}

const es = () => FakeEventSource.instances[FakeEventSource.instances.length - 1]

/** Starts a run and plays it to its end, so the review is on screen. */
async function toReview(served: Served) {
  fireEvent.click(screen.getByRole("button", { name: "Write 15 questions" }))
  await waitFor(() => expect(served.generated).toHaveLength(1))
  await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0))
  es().emit(0, { event: "part_finished", number: 1, total: 2 })
  es().emit(1, { event: "part_finished", number: 2, total: 2 })
  es().emit(2, { event: "stream_end", status: "finished", ok: true })
  await screen.findByText("What two steps does RAG use?")
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal("EventSource", FakeEventSource)
  resetAppSettingsForTests()
  resetWriteSessionsForTests()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("Write questions for me: set up", () => {
  it("without a key, says to add one first, disables Write and opens the Key dialog", async () => {
    serve()
    const { sheet } = setup({ key: null })
    // Until the server says it has no key either, a key is not ruled out.
    expect(await within(sheet()).findByText("Add a key first.")).toBeTruthy()
    expect((within(sheet()).getByRole("button", { name: /^Write \d+ questions?$/ }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(sheet()).getByRole("button", { name: "Add a key" }))
    expect(screen.getByTestId("key-panel").textContent).toBe("open")
  })

  it("with a key, says whose key it uses, defaults to the cheapest Anthropic model and 15 questions", async () => {
    serve()
    const { sheet } = setup()
    await waitFor(() => expect(within(sheet()).getByText("This way, you're going to use your key.")).toBeTruthy())
    expect(sheet().textContent).toMatch(/20 questions with Claude Sonnet 5 used about 8,700 tokens in and 2,700 out/)
    expect((within(sheet()).getByLabelText("Model") as HTMLSelectElement).value).toBe("claude-haiku-4-5")
    expect((within(sheet()).getByLabelText("Questions") as HTMLInputElement).value).toBe("15")
    expect(sheet().textContent).toMatch(/What gets checked for you\./)
  })
})

describe("Write questions for me: a key the server has", () => {
  it("counts a key from .env and says where it comes from", async () => {
    const served = serve({ server: { ...NO_SERVER_KEYS, anthropic: "dotenv" } })
    const { sheet } = setup({ key: null })
    await waitFor(() => expect(within(sheet()).getByText("This way, you're going to use your key.")).toBeTruthy())
    expect(sheet().textContent).toMatch(/Using the key from \.env\./)
    expect(sheet().textContent).not.toMatch(/The key stays in this browser/)
    fireEvent.click(within(sheet()).getByRole("button", { name: "Write 15 questions" }))
    await waitFor(() => expect(served.generated).toHaveLength(1))
    expect(served.generated[0].headers["X-Anthropic-Api-Key"]).toBeUndefined()
  })

  it("keeps the browser sentence for a key typed here", async () => {
    serve({ server: { ...NO_SERVER_KEYS, anthropic: "dotenv" } })
    const { sheet } = setup()
    await waitFor(() => expect(sheet().textContent).toMatch(/The key stays in this browser and is sent only with this request\./))
  })
})

describe("Write questions for me: writing", () => {
  it("sends the model and count with the key, and the progress follows part_finished", async () => {
    const served = serve()
    const { sheet } = setup()
    fireEvent.change(within(sheet()).getByLabelText("Model"), { target: { value: "claude-sonnet-5" } })
    fireEvent.change(within(sheet()).getByLabelText("Questions"), { target: { value: "3" } })
    fireEvent.click(within(sheet()).getByRole("button", { name: "Write 3 questions" }))
    await waitFor(() => expect(served.generated).toHaveLength(1))
    expect(served.generated[0].body).toEqual({ model: "claude-sonnet-5", count: 3 })
    expect(served.generated[0].headers["X-Anthropic-Api-Key"]).toBe("sk-ant-test")
    await waitFor(() => expect(es().url).toBe("/api/v2/runs/w1/events"))
    es().emit(0, { event: "part_finished", number: 1, total: 3 })
    const text = within(sheet()).getByText("Part 1 of 3 done.")
    expect(text.getAttribute("aria-live")).toBe("polite")
    const bar = within(sheet()).getByRole("progressbar")
    expect(bar.getAttribute("aria-valuenow")).toBe("1")
    expect(bar.getAttribute("aria-valuemax")).toBe("3")
    es().emit(1, { event: "part_finished", number: 2, total: 3 })
    expect(within(sheet()).getByText("Part 2 of 3 done.")).toBeTruthy()
  })

  it("Stop only asks to cancel: the run is still followed, and a cancelled run goes back to set up", async () => {
    const served = serve()
    const { sheet } = setup()
    fireEvent.click(within(sheet()).getByRole("button", { name: "Write 15 questions" }))
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1))
    fireEvent.click(within(sheet()).getByRole("button", { name: "Stop" }))
    await waitFor(() => expect(served.cancelled).toEqual(["w1"]))
    // Still writing until the run says it ended.
    expect(within(sheet()).getByText("Writing questions")).toBeTruthy()
    es().emit(0, { event: "part_finished", number: 1, total: 3 })
    expect(within(sheet()).getByText("Part 1 of 3 done.")).toBeTruthy()
    es().emit(1, { event: "stream_end", status: "cancelled", ok: false })
    await waitFor(() => expect(within(sheet()).getByRole("button", { name: "Write 15 questions" })).toBeTruthy())
  })

  it("a run that finishes after Stop lands in review", async () => {
    const served = serve()
    const { sheet } = setup()
    fireEvent.click(within(sheet()).getByRole("button", { name: "Write 15 questions" }))
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1))
    fireEvent.click(within(sheet()).getByRole("button", { name: "Stop" }))
    await waitFor(() => expect(served.cancelled).toEqual(["w1"]))
    es().emit(0, { event: "stream_end", status: "finished", ok: true })
    expect(await within(sheet()).findByText("What two steps does RAG use?")).toBeTruthy()
  })

  it("keeps a run in flight across a remount of the page", async () => {
    serve()
    const onSave = vi.fn(async (_file: File) => true)
    const { unmount } = render(<Page keyValue="sk-ant-test" onSave={onSave} saveError={null} />)
    fireEvent.click(screen.getByRole("button", { name: "Write questions for me" }))
    fireEvent.click(screen.getByRole("button", { name: "Write 15 questions" }))
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1))
    unmount()
    render(<Page keyValue="sk-ant-test" onSave={onSave} saveError={null} />)
    fireEvent.click(screen.getByRole("button", { name: "Write questions for me" }))
    expect(screen.getByText("Writing questions")).toBeTruthy()
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(2))
    es().emit(0, { event: "stream_end", status: "finished", ok: true })
    expect(await screen.findByText("What two steps does RAG use?")).toBeTruthy()
  })

  it("closing the sheet does not cancel, and opening it again shows the progress", async () => {
    const served = serve()
    setup()
    fireEvent.click(screen.getByRole("button", { name: "Write 15 questions" }))
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1))
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(screen.queryByRole("dialog")).toBeNull()
    es().emit(0, { event: "part_finished", number: 1, total: 4 })
    fireEvent.click(screen.getByRole("button", { name: "Write questions for me" }))
    expect(screen.getByText("Part 1 of 4 done.")).toBeTruthy()
    expect(served.cancelled).toEqual([])
  })

  it("shows a refusal of the request in the sheet, in plain words", async () => {
    serve({ refuse: { status: 400, detail: "The demo writes at most 25 questions at a time." } })
    const { sheet } = setup()
    fireEvent.click(within(sheet()).getByRole("button", { name: "Write 15 questions" }))
    const alert = await within(sheet()).findByRole("alert")
    expect(alert.textContent).toBe("The demo writes at most 25 questions at a time.")
  })

  it("shows a run's error in the sheet, with a way back to set up", async () => {
    const served = serve({ ok: false, result: { error: "The key was rejected by Anthropic." } })
    const { sheet } = setup()
    fireEvent.click(within(sheet()).getByRole("button", { name: "Write 15 questions" }))
    await waitFor(() => expect(served.generated).toHaveLength(1))
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1))
    es().emit(0, { event: "stream_end", status: "failed", ok: false })
    const alert = await within(sheet()).findByRole("alert")
    expect(alert.textContent).toMatch(/The key was rejected by Anthropic\./)
    fireEvent.click(within(sheet()).getByRole("button", { name: "Back to set up" }))
    expect(within(sheet()).getByRole("button", { name: "Write 15 questions" })).toBeTruthy()
  })
})

describe("Write questions for me: review", () => {
  it("Edit, Put back, Drop and Keep after all change the row and the summary", async () => {
    const served = serve()
    const { sheet } = setup()
    await toReview(served)
    const summary = within(sheet()).getByTestId("review-summary")
    expect(summary.textContent).toMatch(/2 to keep/)
    expect(summary.textContent).toMatch(/1 marked copied/)
    expect(summary.textContent).toMatch(/Claude Haiku 4\.5, 8,674 in \/ 2,677 out tokens/)
    const row = () => within(screen.getByTestId("review-list")).getAllByRole("listitem")[0]
    expect(row().textContent).toMatch(/Answered by:\s*First it finds passages, then it answers\./)

    fireEvent.click(within(row()).getByRole("button", { name: "Edit" }))
    fireEvent.change(within(row()).getByRole("textbox"), { target: { value: "Which two steps does RAG take?" } })
    fireEvent.click(within(row()).getByRole("button", { name: "Done" }))
    expect(row().textContent).toMatch(/Which two steps does RAG take\?/)
    expect(within(row()).getByText("edited")).toBeTruthy()
    expect(summary.textContent).toMatch(/1 edited/)

    fireEvent.click(within(row()).getByRole("button", { name: "Edit" }))
    fireEvent.click(within(row()).getByRole("button", { name: "Put back the original" }))
    expect(row().textContent).toMatch(/What two steps does RAG use\?/)
    expect(summary.textContent).toMatch(/0 edited/)

    fireEvent.click(within(row()).getByRole("button", { name: "Drop" }))
    expect(within(row()).getByText("dropped")).toBeTruthy()
    expect(summary.textContent).toMatch(/1 to keep/)
    expect(summary.textContent).toMatch(/1 dropped by you/)
    fireEvent.click(within(row()).getByRole("button", { name: "Keep after all" }))
    expect(summary.textContent).toMatch(/2 to keep/)

    // The checks' own drops, with their reasons, in a closed fold.
    const fold = within(sheet()).getByText("1 question dropped by the checks").closest("details")!
    expect(fold.open).toBe(false)
    expect(fold.textContent).toMatch(/Its gold passage is a heading, not a sentence\./)

    for (const r of within(screen.getByTestId("review-list")).getAllByRole("listitem")) fireEvent.click(within(r).getByRole("button", { name: "Drop" }))
    expect((within(sheet()).getByRole("button", { name: "Save 0 questions" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("keeps a paid review across a remount of the page", async () => {
    const served = serve()
    const onSave = vi.fn(async (_file: File) => true)
    const { unmount } = render(<Page keyValue="sk-ant-test" onSave={onSave} saveError={null} />)
    fireEvent.click(screen.getByRole("button", { name: "Write questions for me" }))
    await toReview(served)
    fireEvent.click(within(within(screen.getByTestId("review-list")).getAllByRole("listitem")[1]).getByRole("button", { name: "Drop" }))
    unmount()
    render(<Page keyValue="sk-ant-test" onSave={onSave} saveError={null} />)
    fireEvent.click(screen.getByRole("button", { name: "Write questions for me" }))
    expect(screen.getByTestId("review-summary").textContent).toMatch(/1 dropped by you/)
  })

  it("moves focus into the textarea on Edit and back to the row's button after each action", async () => {
    const served = serve()
    setup()
    await toReview(served)
    const row = () => within(screen.getByTestId("review-list")).getAllByRole("listitem")[0]
    fireEvent.click(within(row()).getByRole("button", { name: "Edit" }))
    expect(document.activeElement).toBe(within(row()).getByRole("textbox"))
    fireEvent.click(within(row()).getByRole("button", { name: "Done" }))
    await waitFor(() => expect(document.activeElement).toBe(within(row()).getByRole("button", { name: "Edit" })))
    fireEvent.click(within(row()).getByRole("button", { name: "Edit" }))
    fireEvent.click(within(row()).getByRole("button", { name: "Put back the original" }))
    await waitFor(() => expect(document.activeElement).toBe(within(row()).getByRole("button", { name: "Edit" })))
    fireEvent.click(within(row()).getByRole("button", { name: "Drop" }))
    await waitFor(() => expect(document.activeElement).toBe(within(row()).getByRole("button", { name: "Keep after all" })))
    fireEvent.click(within(row()).getByRole("button", { name: "Keep after all" }))
    await waitFor(() => expect(document.activeElement).toBe(within(row()).getByRole("button", { name: "Edit" })))
  })

  it("Save uploads the kept questions with their edits as a JSON set", async () => {
    const served = serve()
    const onSave = vi.fn(async (_file: File) => true)
    const { sheet } = setup({ onSave })
    await toReview(served)
    const [first, second] = within(screen.getByTestId("review-list")).getAllByRole("listitem")
    fireEvent.click(within(first).getByRole("button", { name: "Edit" }))
    fireEvent.change(within(first).getByRole("textbox"), { target: { value: "Which two steps?" } })
    fireEvent.click(within(first).getByRole("button", { name: "Done" }))
    fireEvent.click(within(second).getByRole("button", { name: "Drop" }))
    fireEvent.click(within(sheet()).getByRole("button", { name: "Save 1 question" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const file = onSave.mock.calls[0][0]
    expect(file.name).toBe("questions written by Claude Haiku 4.5.json")
    expect(JSON.parse(await file.text())).toEqual({
      version: 1,
      document: "chunking-primer.pdf",
      questions: [{ id: "q1", question: "Which two steps?", gold_answers: ["First it finds passages, then it answers."], answer: "Find, then answer.", tags: [] }],
    })
    // Saved: the sheet closes, and the next open starts over.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    fireEvent.click(screen.getByRole("button", { name: "Write questions for me" }))
    expect(screen.getByRole("button", { name: "Write 15 questions" })).toBeTruthy()
  })

  it("keeps the review open and says why when the upload fails", async () => {
    const served = serve()
    const { sheet } = setup({ onSave: vi.fn(async (_file: File) => false), saveError: "question 1: no gold passage." })
    await toReview(served)
    fireEvent.click(within(sheet()).getByRole("button", { name: "Save 2 questions" }))
    const alert = await within(sheet()).findByRole("alert")
    expect(alert.textContent).toBe("question 1: no gold passage.")
    expect(within(sheet()).getByText("What two steps does RAG use?")).toBeTruthy()
  })

  it("Discard all clears the review", async () => {
    const served = serve()
    const { sheet } = setup()
    await toReview(served)
    fireEvent.click(within(sheet()).getByRole("button", { name: "Discard all" }))
    expect(screen.queryByRole("dialog")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Write questions for me" }))
    expect(screen.getByRole("button", { name: "Write 15 questions" })).toBeTruthy()
  })
})
