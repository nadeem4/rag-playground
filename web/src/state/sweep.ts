import type { VariantState } from "@/api/runState"
import type { Registry, Stage, Variant } from "@/api/types"
import { defaultsFor } from "@/components/fields/schema"

/**
 * Sweep bookkeeping. The runState reducer has already grouped node events
 * under their `variant_started` (node ids repeat across variants); these read
 * those groups.
 */

export interface SweepTally {
  /** Parse nodes that actually executed: `node_finished` with `cache_hit: false`. */
  parsed: number
  /** Executions of the swept node. */
  swept: number
  /** Every `node_finished` with `cache_hit: true`, any node. */
  cacheHits: number
  variants: number
}

export function tallySweep(
  variants: VariantState[],
  stageOf: Record<string, Stage | undefined>,
  sweptId: string,
): SweepTally {
  let parsed = 0
  let swept = 0
  let cacheHits = 0
  for (const v of variants) {
    for (const n of Object.values(v.nodes)) {
      const finished = n.status === "done" || n.status === "cached"
      if (!finished) continue
      if (n.cache_hit) {
        cacheHits += 1
        continue
      }
      if (stageOf[n.id] === "parse") parsed += 1
      if (n.id === sweptId) swept += 1
    }
  }
  return { parsed, swept, cacheHits, variants: variants.length }
}

const times = (n: number) => `${n} ${n === 1 ? "time" : "times"}`

const PAST: Partial<Record<Stage, string>> = { chunk: "chunked", clean: "cleaned", parse: "parsed" }

/** `parsed 1 time, chunked 3 times, 4 cache hits`. Plain words, no glyphs. */
export function tallyLine(t: SweepTally, sweptStage: Stage): string {
  const verb = PAST[sweptStage] ?? `${sweptStage} ran`
  return `parsed ${times(t.parsed)}, ${verb} ${times(t.swept)}, ${t.cacheHits} cache ${t.cacheHits === 1 ? "hit" : "hits"}`
}

export interface VariantLabel {
  transform: string
  /** [field, value] pairs worth naming for this variant. */
  fields: [string, string][]
}

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v))
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Each variant's transform plus the config fields that tell it apart: fields
 * whose values differ between variants of the same transform, or, for a
 * transform used once, fields set away from its defaults.
 */
export function variantLabels(variants: Variant[], registry: Registry, stage: Stage): VariantLabel[] {
  return variants.map((v) => {
    const peers = variants.filter((p) => p.transform === v.transform)
    const schema = registry[stage]?.[v.transform]?.config_schema
    const defaults = schema ? defaultsFor(schema, schema) : {}
    const fields = Object.entries(v.config)
      .filter(([k, val]) => (peers.length > 1 ? peers.some((p) => !same(p.config[k], val)) : !same(defaults[k], val)))
      .map(([k, val]): [string, string] => [k, show(val)])
    return { transform: v.transform, fields }
  })
}
