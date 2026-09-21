import { describe, expect, it } from "vitest"

import {
  addCleaner,
  ancestors,
  columnOrder,
  initialGraph,
  loadGraph,
  removeNode,
  setConfig,
  setTransform,
  upstreamOfStage,
} from "./graph"
import type { Registry } from "@/api/types"

import { TEST_REGISTRY as R } from "./testRegistry"

const edgeSet = (g: { edges: { src: string; dst: string; port: string }[] }) =>
  g.edges.map((e) => `${e.src}->${e.dst}:${e.port}`).sort()

describe("graph state", () => {
  it("starts as Load, Parse, Chunk wired through each transform's declared ports", () => {
    const g = initialGraph(R)
    expect(columnOrder(g).map((n) => n.stage)).toEqual(["source", "parse", "chunk"])
    expect(edgeSet(g)).toEqual(["parse->chunk:doc", "source->parse:file"])
    // Configs start at the schema defaults.
    expect(g.nodes.find((n) => n.stage === "chunk")!.config).toEqual({ chunk_size: 1000, chunk_overlap: 200 })
  })

  it("Parse defaults to docling when the registry has it", () => {
    const withDocling: Registry = {
      ...R,
      parse: { ...R.parse, docling: { ...R.parse!.pdfium, name: "docling", config_schema: { type: "object", title: "doclingConfig", properties: { ocr: { type: "boolean", default: false, title: "Ocr" } } } } },
    }
    const parse = initialGraph(withDocling).nodes.find((n) => n.stage === "parse")!
    expect(parse).toMatchObject({ transform: "docling", config: { ocr: false } })
    expect(edgeSet(initialGraph(withDocling))).toEqual(["parse->chunk:doc", "source->parse:file"])
  })

  it("Parse falls back to the first parser when docling is absent", () => {
    expect(R.parse!.docling).toBeUndefined()
    expect(initialGraph(R).nodes.find((n) => n.stage === "parse")!.transform).toBe("pdfium")
  })

  it("adding a cleaner splices it between parse and chunk", () => {
    const g = addCleaner(initialGraph(R), R)
    const order = columnOrder(g)
    expect(order.map((n) => n.stage)).toEqual(["source", "parse", "clean", "chunk"])
    const clean = order[2]
    expect(edgeSet(g)).toEqual([`${clean.id}->chunk:doc`, `parse->${clean.id}:doc`, "source->parse:file"].sort())
  })

  it("stacking a second cleaner appends it after the first, and picks an unused cleaner", () => {
    const g = addCleaner(addCleaner(initialGraph(R), R), R)
    const order = columnOrder(g)
    expect(order.map((n) => n.stage)).toEqual(["source", "parse", "clean", "clean", "chunk"])
    const [c1, c2] = [order[2], order[3]]
    expect(c1.id).not.toBe(c2.id)
    expect(c1.transform).toBe("header_footer_strip")
    expect(c2.transform).toBe("dedupe_blocks")
    expect(edgeSet(g)).toEqual(
      [`parse->${c1.id}:doc`, `${c1.id}->${c2.id}:doc`, `${c2.id}->chunk:doc`, "source->parse:file"].sort(),
    )
  })

  it("removing the middle of a stack reconnects its neighbours", () => {
    const g = addCleaner(addCleaner(initialGraph(R), R), R)
    const [c1, c2] = columnOrder(g).filter((n) => n.stage === "clean")
    const h = removeNode(g, c1.id)
    expect(h.nodes.map((n) => n.id)).not.toContain(c1.id)
    expect(edgeSet(h)).toEqual([`parse->${c2.id}:doc`, `${c2.id}->chunk:doc`, "source->parse:file"].sort())
    // And removing the last one restores the original chain.
    expect(edgeSet(removeNode(h, c2.id))).toEqual(edgeSet(initialGraph(R)))
  })

  it("new cleaner ids never collide with ids still in the graph", () => {
    let g = addCleaner(addCleaner(initialGraph(R), R), R)
    const [c1] = columnOrder(g).filter((n) => n.stage === "clean")
    g = addCleaner(removeNode(g, c1.id), R)
    const ids = g.nodes.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("changing a transform resets its config to the new defaults and keeps the edges", () => {
    const g = setTransform(initialGraph(R), "chunk", "token_based", R)
    expect(g.nodes.find((n) => n.id === "chunk")).toMatchObject({ transform: "token_based", config: { max_tokens: 256, overlap: 32 } })
    expect(edgeSet(g)).toEqual(edgeSet(initialGraph(R)))
  })

  it("setConfig replaces one node's config only", () => {
    const g = setConfig(initialGraph(R), "chunk", { chunk_size: 400, chunk_overlap: 0 })
    expect(g.nodes.find((n) => n.id === "chunk")!.config).toEqual({ chunk_size: 400, chunk_overlap: 0 })
    expect(g.nodes.find((n) => n.id === "parse")!.config).toEqual({ mode: "text" })
  })

  it("finds ancestors and the nearest upstream node of a stage", () => {
    const g = addCleaner(addCleaner(initialGraph(R), R), R)
    const [c1, c2] = columnOrder(g).filter((n) => n.stage === "clean")
    expect([...ancestors(g, c2.id)].sort()).toEqual(["parse", "source", c1.id].sort())
    expect(upstreamOfStage(g, c2.id, "parse")?.id).toBe("parse")
    expect(upstreamOfStage(g, "parse", "parse")).toBeUndefined()
  })

  it("loads a stored graph only if every transform still exists", () => {
    const g = addCleaner(initialGraph(R), R)
    expect(loadGraph(JSON.stringify(g), R)).toEqual(g)
    const broken = { ...g, nodes: g.nodes.map((n) => (n.stage === "chunk" ? { ...n, transform: "gone" } : n)) }
    expect(loadGraph(JSON.stringify(broken), R)).toBeNull()
    expect(loadGraph("not json", R)).toBeNull()
    expect(loadGraph(null, R)).toBeNull()
  })
})
