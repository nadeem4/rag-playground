import { describe, expect, it } from "vitest"

import type { SampleCard } from "@/api/types"

import { documentOf } from "./document"
import { sampleGraph } from "./graph"
import { STARTER_ID } from "./pipelines"
import { defaultSample, plantedLine, starterPipeline } from "./starter"
import { TEST_REGISTRY as R } from "./testRegistry"

const card = (name: string, extra: Partial<SampleCard> = {}): SampleCard => ({
  name,
  title: name,
  blurb: "",
  shows: "",
  stresses: "chunk",
  pages: 1,
  default: false,
  filename: `${name}.pdf`,
  sha: name.padEnd(64, "0"),
  question: `About ${name}?`,
  ...extra,
})

describe("the Starter pipeline", () => {
  const samples = [card("table"), card("primer", { default: true })]

  it("uses the default sample, else the first", () => {
    expect(defaultSample(samples)?.name).toBe("primer")
    expect(defaultSample([card("a"), card("b")])?.name).toBe("a")
    expect(defaultSample([])).toBeNull()
  })

  it("is the app's default recipe on the default sample, read-only by id", () => {
    const s = starterPipeline(R, samples)!
    expect(s.id).toBe(STARTER_ID)
    expect(s.name).toBe("Starter pipeline")
    expect(s.documents).toEqual([{ sha: samples[1].sha, filename: "primer.pdf" }])
    expect(s.graph).toEqual(sampleGraph(R, { sha: samples[1].sha, filename: "primer.pdf" }, "About primer?"))
    expect(documentOf(s.graph)?.sha).toBe(samples[1].sha)
  })

  it("can open on another sample", () => {
    const s = starterPipeline(R, samples, "table")!
    expect(s.documents[0].filename).toBe("table.pdf")
  })

  it("is null with no samples", () => {
    expect(starterPipeline(R, null)).toBeNull()
    expect(starterPipeline(R, [])).toBeNull()
  })
})

describe("the planted-miss line", () => {
  const q = (...tags: string[]) => ({ tags })

  it("counts the questions tagged designed to miss", () => {
    expect(plantedLine([q("sentence"), q("designed to miss: long sentence"), q("designed to miss: different words")])).toBe(
      "2 questions are planted to miss. Open them after the run to see why.",
    )
    expect(plantedLine([q("designed to miss: footer"), q("number")])).toBe("1 question is planted to miss. Open it after the run to see why.")
    expect(plantedLine([q("designed to miss: no text layer"), q("sentence", "designed to miss: no text layer")])).toBe(
      "All 2 questions are planted to miss. Open them after the run to see why.",
    )
  })

  it("says nothing when no question is planted", () => {
    expect(plantedLine([q("sentence"), q("misses if you change: Fast text")])).toBeNull()
    expect(plantedLine([])).toBeNull()
  })
})
