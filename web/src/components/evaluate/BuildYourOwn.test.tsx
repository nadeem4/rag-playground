import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"
import { choose } from "@/components/ui/pickerTesting"
import { rerankerOf, rewriteOf, sampleGraph } from "@/state/graph"

import { BuildYourOwn } from "./BuildYourOwn"

afterEach(cleanup)

const registry = liveRegistry as unknown as Registry
const primer = { sha: "cd".repeat(32), filename: "chunking-primer.pdf" }
const from = { name: "Starter pipeline", graph: sampleGraph(registry, primer) }

function setup(onSave = vi.fn(() => null as string | null), replacesUnsaved = false) {
  const onOpenBuild = vi.fn()
  const onClose = vi.fn()
  render(
    <BuildYourOwn
      registry={registry}
      from={from}
      documents={[primer]}
      onSave={onSave}
      onOpenBuild={onOpenBuild}
      replacesUnsaved={replacesUnsaved}
      onClose={onClose}
    />,
  )
  const sheet = screen.getByRole("dialog", { name: "Build your own pipeline" })
  return { onSave, onOpenBuild, onClose, sheet }
}

const stage = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) })

describe("Build your own", () => {
  it("is a side sheet with a name, the documents and one setting per stage, prefilled from the selected pipeline", () => {
    const { sheet } = setup()
    expect(within(sheet).getByText("Starts from Starter pipeline. Change any step, give it a name, and save.")).toBeTruthy()
    expect((within(sheet).getByLabelText("Name") as HTMLInputElement).value).toBe("")
    expect(within(sheet).getByText("chunking-primer.pdf")).toBeTruthy()
    expect(stage("Parse").textContent).toContain("Docling")
    expect(stage("Clean").textContent).toContain("Remove duplicate blocks")
    expect(stage("Chunk").textContent).toContain("Recursive (natural breaks)")
    expect(within(sheet).getByText("Index")).toBeTruthy()
    expect(stage("Retrieve").textContent).toContain("Hybrid (RRF)")
    expect(stage("Rerank").textContent).toContain("No reranker")
    expect(within(sheet).getByRole("group", { name: "Rewrite" })).toBeTruthy()
    expect(within(sheet).getByRole("button", { name: "None", pressed: true })).toBeTruthy()
  })

  it("says a missing name inline, under the field, and saves nothing", () => {
    const { onSave, sheet } = setup()
    fireEvent.click(within(sheet).getByRole("button", { name: "Save and select" }))
    expect(within(sheet).getByRole("alert").textContent).toBe("Give it a name, so you can find it in the list.")
    expect(onSave).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(within(sheet).getByLabelText("Name"))
  })

  it("saves the name and every changed step", () => {
    const { onSave, sheet } = setup()
    fireEvent.change(within(sheet).getByLabelText("Name"), { target: { value: "  Reranked  " } })
    choose(stage("Rerank"), "Cross-encoder")
    choose(stage("Clean"), "None")
    fireEvent.click(within(sheet).getByRole("button", { name: "PRF" }))
    fireEvent.click(within(sheet).getByRole("button", { name: "Save and select" }))
    expect(onSave).toHaveBeenCalledTimes(1)
    const [name, graph] = onSave.mock.calls[0] as unknown as [string, ReturnType<typeof sampleGraph>]
    expect(name).toBe("Reranked")
    expect(rerankerOf(graph)).toBe("cross_encoder")
    expect(rewriteOf(graph)).toBe("prf")
    expect(graph.nodes.some((n) => n.stage === "clean")).toBe(false)
  })

  it("shows why a save failed, from the page", () => {
    const { sheet } = setup(vi.fn(() => "The pipeline could not be saved in this browser."))
    fireEvent.change(within(sheet).getByLabelText("Name"), { target: { value: "Mine" } })
    fireEvent.click(within(sheet).getByRole("button", { name: "Save and select" }))
    expect(within(sheet).getByRole("alert").textContent).toBe("The pipeline could not be saved in this browser.")
  })

  it("opens Build with these settings, and says when that replaces an unsaved pipeline there", () => {
    const { onOpenBuild, sheet } = setup(undefined, true)
    choose(stage("Chunk"), "By sentence")
    expect(within(sheet).getByText("This replaces the unsaved pipeline on Build.")).toBeTruthy()
    fireEvent.click(within(sheet).getByRole("button", { name: "Open on Build to watch each step" }))
    const graph = onOpenBuild.mock.calls[0][0] as ReturnType<typeof sampleGraph>
    expect(graph.nodes.find((n) => n.stage === "chunk")?.transform).toBe("sentence_window")
  })
})
