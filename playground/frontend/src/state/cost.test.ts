import { describe, expect, it } from "vitest"

import type { Cost } from "@/api/types"
import { CACHE_NOTE, cachedOnly, costCell, costLine, costValues, estimateLine, partlyCached, seconds, sharedLine, sharedStages, stageTitle } from "./cost"
import type { PipelineConfig } from "./config"

const cost =(over: Partial<Cost> = {}): Cost => ({
  seconds: 2.71,
  input_tokens: 4120,
  output_tokens: 96,
  dollars: 0.0046,
  unpriced_models: [],
  uncounted_models: [],
  steps_run: 1,
  steps_cached: 0,
  prices_as_of: "2026-10-15",
  ...over,
})

describe("seconds", () => {
  it("gives two places under a second and one above", () => {
    expect(seconds(0.05)).toBe("0.05 s")
    expect(seconds(41.62)).toBe("41.6 s")
  })
})

describe("costCell", () => {
  it("gives dollars to four places when they are set", () => {
    expect(costCell(cost())).toEqual({ kind: "dollars", text: "$0.0046", unpriced: [], uncounted: [] })
  })
  it("says local when nothing was priced and no model is missing a price or a count", () => {
    expect(costCell(cost({ dollars: null, input_tokens: null, output_tokens: null }))).toEqual({ kind: "local" })
  })
  it("says no price, with the models, when a model has no price", () => {
    expect(costCell(cost({ dollars: null, unpriced_models: ["openrouter/x"] }))).toEqual({ kind: "unpriced", models: ["openrouter/x"] })
  })
  it("says no token count when only a count is missing", () => {
    expect(costCell(cost({ dollars: null, uncounted_models: ["claude-haiku-4-5"] }))).toEqual({ kind: "uncounted", models: ["claude-haiku-4-5"] })
  })
})

describe("costValues", () => {
  it("sorts by seconds, both token counts, and dollars, with local as nothing spent", () => {
    expect(costValues(cost())).toEqual({ time: 2.71, modelTokens: 4216, cost: 0.0046 })
    expect(costValues(cost({ dollars: null, input_tokens: null, output_tokens: null }))).toEqual({ time: 2.71, modelTokens: null, cost: 0 })
  })
  it("leaves an unknown cost and a missing cost unknown, so they sort last", () => {
    expect(costValues(cost({ dollars: null, unpriced_models: ["m"] })).cost).toBeNull()
    expect(costValues(null)).toEqual({})
  })
  it("treats dollars with an unpriced model as unknown, since part of it has no price", () => {
    expect(costValues(cost({ unpriced_models: ["m"] })).cost).toBeNull()
  })
  it("leaves all three unknown for a recipe that came wholly from an earlier run's cache", () => {
    expect(costValues(cost({ steps_run: 0, steps_cached: 3, seconds: 0 }))).toEqual({ time: null, modelTokens: null, cost: null })
  })
})

describe("costLine", () => {
  it("puts the three values on one line", () => {
    expect(costLine(cost())).toBe("2.7 s · 4,120 in / 96 out model tokens · $0.0046")
    expect(costLine(cost({ dollars: null, input_tokens: null, output_tokens: null, seconds: 0.4 }))).toBe("0.40 s · no model tokens · local")
    expect(costLine(cost({ dollars: null, unpriced_models: ["m"] }))).toBe("2.7 s · 4,120 in / 96 out model tokens · no price for m")
  })
  it("says from cache when the recipe came wholly from an earlier run", () => {
    expect(costLine(cost({ steps_run: 0, steps_cached: 2 }))).toBe("from cache")
  })
  it("tells wholly and partly cached recipes apart", () => {
    expect(cachedOnly(cost({ steps_run: 0, steps_cached: 2 }))).toBe(true)
    expect(cachedOnly(cost({ steps_run: 0, steps_cached: 0 }))).toBe(false)
    expect(partlyCached(cost({ steps_run: 1, steps_cached: 2 }))).toBe(true)
    expect(partlyCached(cost({ steps_run: 1, steps_cached: 0 }))).toBe(false)
    expect(CACHE_NOTE).toBe("Recipes marked from cache were stored by an earlier run, so their time and cost were not measured this time.")
  })
})

describe("the shared line", () => {
  const config = {
    index: { parse: { use: "docling" }, clean: [{ use: "x" }], chunk: { use: "c" }, embed: { use: "e" }, store: { use: "s" } },
    retrieve: { search: { use: "hybrid" }, rerank: [{ use: "llm_rerank" }] },
  } as PipelineConfig

  it("names the steps before the varied one, in pipeline order", () => {
    expect(sharedStages(config, "rerank")).toEqual(["Parse", "Clean", "Chunk", "Index", "Retrieve"])
    expect(sharedStages({ ...config, index: { ...config.index, clean: [] } }, "chunk")).toEqual(["Parse"])
    expect(sharedStages({ ...config, retrieve: { ...config.retrieve!, rewrite: { use: "llm_rewrite" } } }, "search")).toEqual(["Parse", "Clean", "Chunk", "Index", "Ask"])
  })

  it("names Pandion's steps by the page's card titles", () => {
    expect(["parse", "clean", "chunk", "embed", "store", "rewrite", "search", "rerank"].map(stageTitle)).toEqual(["Parse", "Clean", "Chunk", "Index", "Index", "Ask", "Retrieve", "Rerank"])
    expect(sharedStages(config, "parse")).toEqual([])
  })

  it("counts an Enrich step among the shared steps, and names it Enrich", () => {
    const enriched = { ...config, index: { ...config.index, enrich: { use: "llm_context" } } }
    expect(stageTitle("enrich")).toBe("Enrich")
    expect(sharedStages(enriched, "embed")).toEqual(["Parse", "Clean", "Chunk", "Enrich"])
    expect(sharedStages(enriched, "enrich")).toEqual(["Parse", "Clean", "Chunk"])
    expect(sharedStages(config, "embed")).toEqual(["Parse", "Clean", "Chunk"])
  })

  it("says what the shared steps took once, and that Time leaves them out", () => {
    const shared = cost({ seconds: 41.62, input_tokens: null, output_tokens: null, dollars: null, steps_run: 6 })
    expect(sharedLine(shared, ["parse", "clean", "chunk"])).toBe(
      "Shared steps (parse, clean, chunk) took 41.6 s once, before the recipes split. They are the same for every recipe, so they are left out of Time.",
    )
  })

  it("adds the shared tokens and cost when there are any", () => {
    const shared = cost({ seconds: 3.2, input_tokens: 900, output_tokens: 40, dollars: 0.0012, steps_run: 2 })
    expect(sharedLine(shared, ["parse", "rewrite"])).toBe(
      "Shared steps (parse, rewrite) took 3.2 s once, with 900 in / 40 out tokens at $0.0012, before the recipes split. They are the same for every recipe, so they are left out of Time, Tokens and Cost.",
    )
  })

  it("says the shared steps came from the cache when none ran", () => {
    expect(sharedLine(cost({ seconds: 0, steps_run: 0, steps_cached: 4 }), ["parse"])).toBe("The shared steps came from the cache this time.")
  })

  it("says nothing when no step is shared", () => {
    expect(sharedLine(cost({ steps_run: 0, steps_cached: 0 }), [])).toBeNull()
  })

  it("says the cost is an estimate, with the date of the prices", () => {
    expect(estimateLine(cost())).toBe("Cost is an estimate, prices as of 2026-10-15.")
  })
})
