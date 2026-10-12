import { describe, expect, it } from "vitest"

import { withDocument } from "./document"
import { initialGraph, sampleGraph, setTransform } from "./graph"
import { defaultChoice, ON_BUILD, pipelineChoices } from "./pipelineChoice"
import { STARTER_ID, type SavedPipeline } from "./pipelines"
import { TEST_REGISTRY as R } from "./testRegistry"

const primer = { sha: "a".repeat(64), filename: "chunking-primer.pdf" }
const table = { sha: "b".repeat(64), filename: "table-of-figures.pdf" }
const starter = { id: STARTER_ID, name: "Starter pipeline", graph: sampleGraph(R, primer), documents: [primer] }
const saved = (id: string, name: string, graph = sampleGraph(R, table)): SavedPipeline => ({ id, name, graph, documents: [table], savedAt: "2026-10-01T00:00:00Z" })
const tokens = (g = sampleGraph(R, table)) => setTransform(g, "chunk", "token_based", R)

describe("the pipelines Evaluate can score", () => {
  it("lists the Starter, then saved pipelines, and no On Build when Build shows one of them unedited", () => {
    const mine = saved("mine1234", "Mine")
    const choices = pipelineChoices({ starter, saved: [mine], registry: R, working: starter.graph, currentId: STARTER_ID })
    expect(choices.map((c) => [c.id, c.kind])).toEqual([
      [STARTER_ID, "ready"],
      ["mine1234", "saved"],
    ])
    expect(choices[1].documents).toEqual([table])
  })

  it("adds the pipeline on Build when it is not saved: new, or edited since it was picked", () => {
    const fresh = pipelineChoices({ starter, saved: [], registry: R, working: tokens(), currentId: null })
    expect(fresh.map((c) => c.id)).toEqual([STARTER_ID, ON_BUILD])
    expect(fresh[1]).toMatchObject({ name: "The pipeline on Build", label: "the pipeline on Build", key: "working", documents: [table] })

    const mine = saved("mine1234", "Mine")
    const edited = pipelineChoices({ starter, saved: [mine], registry: R, working: tokens(), currentId: "mine1234" })
    expect(edited.find((c) => c.id === ON_BUILD)).toMatchObject({ label: "Mine (edited)", key: "mine1234" })

    const starterEdited = pipelineChoices({ starter, saved: [], registry: R, working: tokens(starter.graph), currentId: STARTER_ID })
    expect(starterEdited.find((c) => c.id === ON_BUILD)).toMatchObject({ label: "the pipeline on Build", key: "working" })
  })

  it("lists the Starter on another document as the unsaved pipeline on Build, and opens on it", () => {
    const upload = { sha: "c".repeat(64), filename: "my-notes.pdf" }
    const choices = pipelineChoices({ starter, saved: [], registry: R, working: withDocument(starter.graph, upload), currentId: STARTER_ID })
    expect(choices.find((c) => c.id === ON_BUILD)).toMatchObject({ documents: [upload], label: "the pipeline on Build" })
    expect(defaultChoice(choices, STARTER_ID)).toBe(ON_BUILD)
  })

  it("leaves out the pipeline on Build when it has no document", () => {
    expect(pipelineChoices({ starter, saved: [], registry: R, working: initialGraph(R), currentId: null }).map((c) => c.id)).toEqual([STARTER_ID])
  })

  it("keeps a saved pipeline this server cannot run, with no graph", () => {
    const g = sampleGraph(R, table)
    const foreign = saved("far12345", "Foreign", { ...g, nodes: g.nodes.map((n) => (n.stage === "chunk" ? { ...n, transform: "semantic" } : n)) })
    const [, c] = pipelineChoices({ starter, saved: [foreign], registry: R, working: null, currentId: null })
    expect(c).toMatchObject({ id: "far12345", graph: null })
  })
})

describe("which pipeline Evaluate opens on", () => {
  const mine = saved("mine1234", "Mine")

  it("opens on the Starter when nothing is chosen", () => {
    const choices = pipelineChoices({ starter, saved: [mine], registry: R, working: null, currentId: null })
    expect(defaultChoice(choices, null)).toBe(STARTER_ID)
  })

  it("opens on the unsaved pipeline on Build, else Build's selection", () => {
    const unsaved = pipelineChoices({ starter, saved: [mine], registry: R, working: tokens(), currentId: null })
    expect(defaultChoice(unsaved, null)).toBe(ON_BUILD)
    const picked = pipelineChoices({ starter, saved: [mine], registry: R, working: withDocument(mine.graph, table), currentId: "mine1234" })
    expect(defaultChoice(picked, "mine1234")).toBe("mine1234")
  })

  it("opens on the pipeline a link asks for, when it can run", () => {
    const choices = pipelineChoices({ starter, saved: [mine], registry: R, working: tokens(), currentId: null })
    expect(defaultChoice(choices, null, "mine1234")).toBe("mine1234")
    expect(defaultChoice(choices, null, "gone1234")).toBe(ON_BUILD)
  })

  it("has nothing to open on with no Starter and nothing saved", () => {
    expect(defaultChoice(pipelineChoices({ starter: null, saved: [], registry: R, working: null, currentId: null }), null)).toBe("")
  })
})
