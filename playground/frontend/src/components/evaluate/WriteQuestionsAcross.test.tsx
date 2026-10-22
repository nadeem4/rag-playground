import { useEffect } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiKeyProvider, useApiKey } from "@/api/apiKey"
import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"
import { resetAppSettingsForTests } from "@/api/useDemo"
import type { Question } from "@/state/goldSet"
import { resetWriteSessionsForTests } from "@/state/writeQuestions"

import { WriteQuestionsAcross } from "./WriteQuestionsAcross"

const registry = liveRegistry as unknown as Registry
const A = { sha: "aa".repeat(32), filename: "chunking-primer.pdf", slot: 1 }
const B = { sha: "bb".repeat(32), filename: "field-guide.docx", slot: 2 }
const FILES = [A, B]
const EXISTING: Question[] = [
  { id: "old", question: "What does overlap do?", gold_answers: ["Overlap keeps context."], tags: ["hard"], answer: "Context.", document: A.sha },
  { id: "any", question: "What is a page?", gold_answers: ["A page is a page."], tags: [], answer: "", document: "" },
]

class FakeEventSource {
  static instances: FakeEventSource[] = []
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror = null
  onopen = null
  constructor() {
    FakeEventSource.instances.push(this)
  }
  close() {}
  end(status: string) {
    act(() => {
      this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ ts: 1, event: "stream_end", status, ok: status === "finished" }), lastEventId: "1" }))
    })
  }
}

const written = (sha: string) => ({
  questions: [{ id: "q1", question: `A question about ${sha.slice(0, 2)}?`, gold_answers: ["Its passage."], answer: "", tags: [], document: sha }],
  dropped: [],
  usage: { input_tokens: 10, output_tokens: 5, model: "claude-haiku-4-5" },
})

/** Each run's id names the document it writes for; `outcome` says how each one ends. */
function serve(outcome: Record<string, "finished" | "cancelled" | { error: string }> = {}) {
  const served = { generated: [] as { sha: string; count: number }[], cancelled: [] as string[] }
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/settings/app") return json({ demo: false })
      if (url === "/api/v2/settings/models") return json({ anthropic: "none", openai: "none", custom: "none", openrouter: "none" })
      const gen = /^\/api\/v2\/documents\/([^/]+)\/questions\/generate$/.exec(url)
      if (gen && init?.method === "POST") {
        served.generated.push({ sha: gen[1], count: JSON.parse(String(init.body)).count })
        return json({ run_id: `w-${gen[1]}` }, 202)
      }
      const cancel = /^\/api\/v2\/runs\/w-([^/]+)\/cancel$/.exec(url)
      if (cancel) {
        served.cancelled.push(cancel[1])
        return json({ cancel_requested: true }, 202)
      }
      const snap = /^\/api\/v2\/runs\/w-([^/]+)$/.exec(url)
      if (snap) {
        const o = outcome[snap[1]] ?? "finished"
        const result = typeof o === "object" ? o : o === "finished" ? written(snap[1]) : null
        return json({ run_id: url, kind: "questions", status: typeof o === "object" ? "failed" : o, ok: o === "finished", last_event_id: 1, events: [], result })
      }
      return json({ detail: "not found" }, 404)
    }),
  )
  return served
}

function WithKey() {
  const { setKey } = useApiKey()
  useEffect(() => setKey("anthropic", "sk-ant-test"), [setKey])
  return null
}

function setup(onSave = vi.fn(async (_file: File) => true)) {
  render(
    <ApiKeyProvider>
      <WithKey />
      <WriteQuestionsAcross files={FILES} questions={EXISTING} filenames={["golden-set.csv"]} registry={registry} locked={false} onSave={onSave} saveError={null} />
    </ApiKeyProvider>,
  )
  fireEvent.click(screen.getByRole("button", { name: "Write questions for me" }))
  return { onSave, sheet: () => screen.getByRole("dialog") }
}

const last = () => FakeEventSource.instances[FakeEventSource.instances.length - 1]

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

describe("Write questions for me, several documents: set up", () => {
  it("lists each document with how many questions it already has, all ticked, 6 each at first", async () => {
    serve()
    const { sheet } = setup()
    await waitFor(() => expect(within(sheet()).getByText("This way, you're going to use your key.")).toBeTruthy())
    const group = within(sheet()).getByRole("group", { name: "Documents to write for" })
    const boxes = within(group).getAllByRole("checkbox") as HTMLInputElement[]
    expect(boxes.map((b) => b.checked)).toEqual([true, true])
    expect(group.textContent).toBe("Write forchunking-primer.pdf1 in your setfield-guide.docx0 in your set")
    expect((within(sheet()).getByLabelText("Questions per document") as HTMLInputElement).value).toBe("6")
    expect(within(sheet()).getByTestId("write-total").textContent).toBe(
      "6 for each of 2 documents: 12 questions, written one document at a time. They join your set; nothing in it is replaced.",
    )
    expect(within(sheet()).getByRole("button", { name: "Write 12 questions" })).toBeTruthy()
  })

  it("writes only the documents ticked, at most 25 each, and asks for one when none is", async () => {
    const served = serve()
    const { sheet } = setup()
    const boxes = within(await within(sheet()).findByRole("group", { name: "Documents to write for" })).getAllByRole("checkbox")
    fireEvent.change(within(sheet()).getByLabelText("Questions per document"), { target: { value: "40" } })
    expect(sheet().textContent).toContain("At most 25 at a time.")
    fireEvent.click(boxes[0])
    fireEvent.click(boxes[1])
    expect(within(sheet()).getByTestId("write-total").textContent).toBe("Pick at least one document.")
    expect((within(sheet()).getByRole("button", { name: "Write 0 questions" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(boxes[1])
    await waitFor(() => expect((within(sheet()).getByRole("button", { name: "Write 25 questions" }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(within(sheet()).getByRole("button", { name: "Write 25 questions" }))
    await waitFor(() => expect(served.generated).toEqual([{ sha: B.sha, count: 25 }]))
  })
})

describe("Write questions for me, several documents: writing", () => {
  it("Stop during the second document cancels it, starts no other, and reviews what the first wrote", async () => {
    const served = serve({ [B.sha]: "cancelled" })
    const { sheet, onSave } = setup()
    fireEvent.click(await within(sheet()).findByRole("button", { name: "Write 12 questions" }))
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    last().end("finished")
    await waitFor(() => expect(served.generated).toHaveLength(2))
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2))
    expect(sheet().textContent).toContain("Document 2 of 2")
    fireEvent.click(within(sheet()).getByRole("button", { name: "Stop" }))
    await waitFor(() => expect(served.cancelled).toEqual([B.sha]))
    last().end("cancelled")
    const groups = await within(sheet()).findAllByTestId("review-group")
    expect(groups).toHaveLength(1)
    expect(groups[0].textContent).toContain("chunking-primer.pdf")
    expect(served.generated).toHaveLength(2)
    fireEvent.click(within(sheet()).getByRole("button", { name: "Save 1 question" }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const set = JSON.parse(await onSave.mock.calls[0][0].text())
    expect(set.questions.map((q: Question) => [q.id, q.document])).toEqual([
      ["old", A.sha],
      ["any", ""],
      ["q1", A.sha],
    ])
  })

  it("Stop during the first document goes back to set up", async () => {
    serve({ [A.sha]: "cancelled" })
    const { sheet } = setup()
    fireEvent.click(await within(sheet()).findByRole("button", { name: "Write 12 questions" }))
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    fireEvent.click(within(sheet()).getByRole("button", { name: "Stop" }))
    last().end("cancelled")
    expect(await within(sheet()).findByRole("button", { name: "Write 12 questions" })).toBeTruthy()
  })

  it("a document whose run fails stops the writing, names the file and keeps what was written before", async () => {
    serve({ [B.sha]: { error: "The model refused." } })
    const { sheet } = setup()
    fireEvent.click(await within(sheet()).findByRole("button", { name: "Write 12 questions" }))
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    last().end("finished")
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2))
    last().end("failed")
    const alert = await within(sheet()).findByRole("alert")
    expect(alert.textContent).toBe("field-guide.docx: The model refused. The questions written before it are below.")
    expect(within(sheet()).getAllByTestId("review-group")).toHaveLength(1)
  })
})
