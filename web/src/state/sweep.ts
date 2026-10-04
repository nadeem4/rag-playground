import type { VariantState } from "@/api/runState"
import type { GraphNode, Registry, Stage, Variant } from "@/api/types"
import { defaultsFor } from "@/components/fields/schema"
import { fmtMs } from "@/components/pipeline/NodeCard"

/**
 * Sweep bookkeeping. The runState reducer has already grouped node events
 * under their `variant_started` (node ids repeat across variants); these read
 * those groups.
 */

export interface SweepTally {
  /** Executions per node id: `node_finished` with `cache_hit: false`, across all variants. */
  executed: Record<string, number>
  /** Every `node_finished` with `cache_hit: true`, any node. */
  cacheHits: number
  variants: number
  /** Variants with a failed node. */
  failed: number
  /** The longest single execution (not a cache hit), when one carries a duration. */
  slowest: { id: string; ms: number } | null
}

export function tallySweep(variants: VariantState[]): SweepTally {
  const executed: Record<string, number> = {}
  let cacheHits = 0
  let slowest: SweepTally["slowest"] = null
  for (const v of variants) {
    for (const n of Object.values(v.nodes)) {
      if (n.status !== "done" && n.status !== "cached") continue
      executed[n.id] = executed[n.id] ?? 0
      if (n.cache_hit) cacheHits += 1
      else {
        executed[n.id] += 1
        if (typeof n.duration_ms === "number" && (!slowest || n.duration_ms > slowest.ms)) slowest = { id: n.id, ms: n.duration_ms }
      }
    }
  }
  const failed = variants.filter((v) => Object.values(v.nodes).some((n) => n.status === "failed")).length
  return { executed, cacheHits, variants: variants.length, failed, slowest }
}

const times = (n: number) => `${n} ${n === 1 ? "time" : "times"}`

const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`)

/**
 * `Parse ran 1 time, Index ran 5 times. Load came from the cache.` Plain
 * words, no glyphs, nodes in column order. A node that finished but never
 * executed is named as coming from the cache rather than as "ran 0 times".
 * Then the slowest step's time, and how many recipes failed. While the run is
 * still going (`finished: false`), it never says "Nothing ran".
 */
export function tallyLine(t: SweepTally, column: { id: string; title: string }[], opts: { finished?: boolean } = {}): string {
  const titles = column.map((n) => n.title)
  const name = (n: { id: string; title: string }) => (titles.filter((x) => x === n.title).length > 1 ? `${n.title} ${n.id}` : n.title)
  const seen = column.filter((n) => n.id in t.executed)
  const ran = seen.filter((n) => t.executed[n.id] > 0).map((n) => `${name(n)} ran ${times(t.executed[n.id])}`)
  const cached = seen.filter((n) => t.executed[n.id] === 0).map(name)
  const failed = t.failed ? ` ${t.failed} ${t.failed === 1 ? "recipe" : "recipes"} failed.` : ""
  if (!ran.length) {
    if (!cached.length) return t.failed ? failed.trim() : "Nothing has finished yet."
    // Mid-run, the shared steps arrive from the cache before any recipe runs: say only that.
    if (opts.finished === false) return `${list(cached)} came from the cache.` + failed
    return (t.failed ? "Every step that finished came from the cache." : "Nothing ran: every step came from the cache.") + failed
  }
  const slow = t.slowest ? column.find((n) => n.id === t.slowest!.id) : undefined
  return (
    `${ran.join(", ")}.` +
    (cached.length ? ` ${list(cached)} came from the cache.` : "") +
    (slow ? ` The slowest step was ${name(slow)}, at ${fmtMs(t.slowest!.ms)}.` : "") +
    failed
  )
}

export interface VariantLabel {
  transform: string
  /** [field, value] pairs worth naming for this variant. */
  fields: [string, string][]
}

const show = (v: unknown) => (v === null ? "native" : typeof v === "string" ? v : JSON.stringify(v))
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

/** A variant's short name in running text: its distinguishing values, else its transform. */
export function variantName(label: VariantLabel | undefined): string {
  if (!label) return ""
  return label.fields.length ? label.fields.map(([, v]) => v).join(" ") : label.transform
}

/** The Matryoshka widths the preset asks for, below the native width. */
export const MATRYOSHKA_DIMS = [1024, 512, 256, 128, 64]

/**
 * The "Matryoshka dimensions" preset: the Index node at its native width, then
 * every preset width below it. `native` is the embedder's native width when
 * the Build page knew it (from the Index card's last output). Without it the
 * widest variant is `truncate_dim: null`, which is the native width whatever
 * the model, followed by 512 down to 64; a width the model cannot reach fails
 * as its own variant with the server's message.
 */
export function matryoshkaVariants(target: GraphNode, native?: number): Variant[] {
  const known = native !== undefined && native > 0
  const dims: (number | null)[] = known ? [native, ...MATRYOSHKA_DIMS.filter((d) => d < native)] : [null, ...MATRYOSHKA_DIMS.slice(1)]
  return dims.map((d) => ({ transform: target.transform, config: { ...target.config, truncate_dim: d } }))
}

/**
 * The variant every other is compared with. When the variants differ in
 * `truncate_dim`, the widest (native, `null`, counts as widest of all), since
 * the lesson is how much a narrower index loses. Otherwise the first variant.
 * Only variants that produced hits are eligible.
 */
export function baselineIndex(variants: Variant[], hasHits: (i: number) => boolean): number | null {
  const eligible = variants.map((_, i) => i).filter(hasHits)
  if (!eligible.length) return null
  const dims = variants.map((v) => v.config.truncate_dim)
  if (new Set(dims.map((d) => JSON.stringify(d ?? null))).size > 1) {
    const width = (i: number) => (dims[i] === null || dims[i] === undefined ? Infinity : Number(dims[i]))
    return eligible.reduce((best, i) => (width(i) > width(best) ? i : best), eligible[0])
  }
  return eligible[0]
}
