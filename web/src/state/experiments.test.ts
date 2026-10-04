import { beforeEach, describe, expect, it } from "vitest"

import liveRegistry from "@/api/fixtures/registry.json"
import type { Registry } from "@/api/types"

import {
  deleteExperiment,
  MAX_EXPERIMENTS,
  readExperiments,
  requestOpenExperiment,
  resetExperimentsForTests,
  saveExperiment,
  takeOpenRequest,
  updateExperiment,
  usableExperiment,
} from "./experiments"

const registry = liveRegistry as unknown as Registry
const recipes = [{ transform: "recursive_character", config: { chunk_size: 400 } }, { transform: "sentence_window", config: {} }]
const doc = { sha: "cd".repeat(32), filename: "chunking-primer.pdf" }

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  resetExperimentsForTests()
})

describe("experiments", () => {
  it("saves the step, the recipes and the document, and nothing about a run", () => {
    const { saved } = saveExperiment("Chunk sizes", { stage: "chunk", recipes, doc })!
    expect(readExperiments()).toEqual([saved])
    expect(Object.keys(JSON.parse(window.localStorage.getItem("rag-playground:experiments:v1")!)[0]).sort()).toEqual(["doc", "id", "name", "recipes", "savedAt", "stage"])
  })

  it("updates in place, deletes, and starts from what storage holds now", () => {
    const { saved } = saveExperiment("A", { stage: "chunk", recipes, doc })!
    window.localStorage.setItem("rag-playground:experiments:v1", JSON.stringify([...JSON.parse(window.localStorage.getItem("rag-playground:experiments:v1")!), { ...saved, id: "other", name: "From another tab" }]))
    updateExperiment(saved.id, { stage: "chunk", recipes: recipes.slice(0, 1), doc })
    expect(readExperiments().map((e) => e.name)).toEqual(["A", "From another tab"])
    expect(readExperiments()[0].recipes).toHaveLength(1)
    deleteExperiment(saved.id)
    expect(readExperiments().map((e) => e.name)).toEqual(["From another tab"])
  })

  it("keeps twenty and says which one it dropped", () => {
    expect(MAX_EXPERIMENTS).toBe(20)
    for (let i = 0; i < 20; i++) saveExperiment(`E${i}`, { stage: "chunk", recipes, doc })
    expect(saveExperiment("E20", { stage: "chunk", recipes, doc })!.dropped!.name).toBe("E0")
    expect(readExperiments()).toHaveLength(20)
  })

  it("lists but will not open an experiment whose strategy this server lacks", () => {
    const { saved } = saveExperiment("Old", { stage: "chunk", recipes: [{ transform: "gone", config: {} }], doc })!
    expect(readExperiments()).toHaveLength(1)
    expect(usableExperiment(saved, registry)).toBeNull()
    const ok = saveExperiment("New", { stage: "chunk", recipes, doc })!.saved
    expect(usableExperiment(ok, registry)).toEqual(ok)
  })

  it("leaves out entries that are not experiments, or carry more than ten recipes", () => {
    const { saved } = saveExperiment("A", { stage: "chunk", recipes, doc })!
    window.localStorage.setItem("rag-playground:experiments:v1", JSON.stringify([saved, { id: 1 }, { ...saved, id: "big", recipes: Array(11).fill(recipes[0]) }]))
    resetExperimentsForTests()
    expect(readExperiments().map((e) => e.id)).toEqual([saved.id])
  })

  it("hands an experiment to Compare through this tab's session, once", () => {
    requestOpenExperiment("abc")
    expect(window.sessionStorage.getItem("rag-playground:experiments:open")).toBe("abc")
    expect(takeOpenRequest()).toBe("abc")
    expect(window.sessionStorage.getItem("rag-playground:experiments:open")).toBeNull()
    expect(takeOpenRequest()).toBeNull()
  })
})
