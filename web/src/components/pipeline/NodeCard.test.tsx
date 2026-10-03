import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import chunkRecursive from "@/api/fixtures/chunk_set.recursive_character.json"
import type { NodeState } from "@/api/runState"
import { initialGraph, transformsFor } from "@/state/graph"
import { TEST_REGISTRY as R } from "@/state/testRegistry"

import { describeResult, NodeCard, type NodeCardProps } from "./NodeCard"

/** Payloads by artifact id. Ids are unique per test: payloads are cached for the session. */
let payloads: Record<string, unknown> = {}

beforeEach(() => {
  payloads = {}
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      const payload = /^\/api\/artifacts\/([^/]+)\/payload$/.exec(url)
      if (payload) return ok(payloads[payload[1]])
      const meta = /^\/api\/artifacts\/([^/]+)$/.exec(url)
      if (meta) return ok({ id: meta[1], type: "chunk_set", meta: {} })
      return ok([])
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const chunkNode = initialGraph(R).nodes.find((n) => n.stage === "chunk")!

function renderCard(over: Partial<NodeCardProps> = {}) {
  const props: NodeCardProps = {
    node: chunkNode,
    title: "Chunk",
    transforms: transformsFor(R, "chunk"),
    selected: false,
    busy: false,
    onSelect: vi.fn(),
    onTransform: vi.fn(),
    onConfig: vi.fn(),
    onRun: vi.fn(),
    ...over,
  }
  render(<NodeCard {...props} />)
  return screen.getByRole("article")
}

const done = (artifact_id: string, status: "done" | "cached" = "done"): NodeState => ({
  id: "chunk",
  status,
  artifact_id,
  cache_hit: status === "cached",
  duration_ms: 3,
})

describe("describeResult", () => {
  it("names five looks and says changed, run again for a stale result", () => {
    expect(describeResult(undefined, false).look).toBe("idle")
    expect(describeResult({ id: "x", status: "running" }, false).look).toBe("running")
    expect(describeResult(done("a"), false).look).toBe("done")
    expect(describeResult(done("a", "cached"), false).look).toBe("done")
    expect(describeResult(done("a"), true)).toMatchObject({ look: "stale", label: "changed, run again" })
    expect(describeResult({ id: "x", status: "failed", error: "boom" }, false).look).toBe("failed")
    expect(describeResult(done("a"), false)).not.toHaveProperty("rule")
  })
})

describe("the step card's look", () => {
  it("idle: a hairline ring, no bar, no summary", () => {
    const card = renderCard()
    expect(card.dataset.look).toBe("idle")
    expect(card.hasAttribute("data-rule")).toBe(false)
    expect(card.style.borderLeft).toBe("")
    expect(within(card).getByTestId("status-ring").className).toContain("border-hairline")
    expect(within(card).queryByTestId("running-bar")).toBeNull()
    expect(within(card).queryByTestId("step-summary")).toBeNull()
  })

  it("running: the accent at half strength and a pulsing top edge that goes still under reduced motion", () => {
    const card = renderCard({ result: { id: "chunk", status: "running" } })
    expect(card.dataset.look).toBe("running")
    expect(within(card).getByTestId("status-ring").className).toContain("bg-primary/50")
    const bar = within(card).getByTestId("running-bar")
    expect(bar.className).toContain("step-running-edge")
    expect(bar.className).toContain("top-0")
  })

  it("done: an accent fill and the outcome sentence, without (was N), in the summary row", async () => {
    payloads = { look1: chunkRecursive }
    const card = renderCard({ result: done("look1"), previousArtifactId: "look0" })
    expect(card.dataset.look).toBe("done")
    expect(within(card).getByTestId("status-ring").className).toContain("bg-primary")
    const summary = await within(card).findByTestId("step-summary")
    await waitFor(() => expect(summary.textContent).toBe("Made 6 chunks. Median 67 tokens, largest 76. 3 overlaps."))
    // Numbers in mono, the sentence in the reading face.
    expect(summary.className).not.toContain("font-mono")
    expect(within(summary).getByText("6").className).toContain("font-mono")
  })

  it("done from the cache: the summary row says reused from an earlier run", () => {
    const card = renderCard({ result: done("look2", "cached") })
    expect(card.dataset.look).toBe("done")
    expect(within(card).getByTestId("step-summary").textContent).toBe("reused from an earlier run")
  })

  it("stale: an amber ring and the status word changed, run again", () => {
    const card = renderCard({ result: done("look3"), stale: true })
    expect(card.dataset.look).toBe("stale")
    expect(within(card).getByTestId("status-ring").className).toContain("border-stale")
    const chip = within(card).getByTestId("status-chip")
    expect(chip.textContent).toBe("changed, run again")
    expect(chip.className).toContain("rounded-full")
    expect(chip.className).toContain("text-stale")
    expect(card.textContent).not.toContain("changed, not run")
  })

  it("failed: a danger ring", () => {
    const card = renderCard({ result: { id: "chunk", status: "failed", error: "ValueError: boom" } })
    expect(card.dataset.look).toBe("failed")
    expect(within(card).getByTestId("status-ring").className).toContain("border-danger")
  })

  it("the duration is in mono", () => {
    const card = renderCard({ result: done("look4", "cached") })
    expect(within(card).getByText("3.0 ms").className).toContain("font-mono")
  })
})

describe("the transform line", () => {
  it("gives the plain name, then the code name in mono, and never truncates", () => {
    const card = renderCard()
    const line = within(card).getByTestId("step-transform")
    expect(line.textContent).toBe("Recursive (natural breaks), recursive_character")
    const code = within(line).getByText("recursive_character")
    expect(code.className).toContain("font-mono")
    expect(code.className).toContain("text-2xs")
    expect(card.querySelector(".truncate")).toBeNull()
  })

  it("the picker's options read the same way", () => {
    const card = renderCard()
    expect(within(card).getByRole("option", { name: "Recursive (natural breaks), recursive_character" })).toBeTruthy()
  })
})

describe("raised and open", () => {
  it("the selected card is raised and open; another is flat and closed", () => {
    const card = renderCard({ selected: true })
    expect(card.className).toContain("shadow-raised")
    expect(card.className).toContain("bg-surface-raised")
    expect(within(card).getByRole("button", { name: "Chunk" }).getAttribute("aria-expanded")).toBe("true")
    const body = within(card).getByTestId("step-options")
    expect(body.className).toContain("grid-rows-[1fr]")
    expect(body.className).toContain("duration-(--dur-mid)")
    expect(body.className).toContain("ease-(--ease-in)")
    expect(body.className).toContain("motion-reduce:transition-none")
    cleanup()

    const flat = renderCard({ selected: false })
    expect(flat.className).not.toContain("shadow-raised")
    expect(flat.className).toContain("bg-surface-elevated")
    expect(within(flat).getByRole("button", { name: "Chunk" }).getAttribute("aria-expanded")).toBe("false")
    expect(within(flat).getByTestId("step-options").className).toContain("grid-rows-[0fr]")
  })
})
