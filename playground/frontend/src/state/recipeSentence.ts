import type { JsonSchema, Variant } from "@/api/types"
import { isShown, optionLabel } from "@/components/fields/schema"

import { RECIPE_TITLES } from "./compare"

/**
 * A Compare recipe as one plain sentence, cut into parts: each value the
 * reader can change is its own part, named by its field (`transform` for the
 * strategy), so the card can make it a button.
 */

export interface SentencePart {
  text: string
  /** The setting this part shows; `transform` for the strategy. */
  field?: string
}

/** The unit after a number, by field; singular for a value of one. */
const UNITS: Record<string, string> = {
  chunk_size: "characters",
  chunk_overlap: "characters",
  max_tokens: "tokens",
  overlap: "tokens",
  sentences_per_chunk: "sentences",
  overlap_sentences: "sentences",
  top_k: "pieces",
  prf_docs: "pieces",
  prf_terms: "words",
  truncate_dim: "dimensions",
}

/** Values whose schema has no label of its own, in plain words. */
const VALUE_WORDS: Record<string, Record<string, string>> = {
  query_expansion: { none: "off", prf: "PRF" },
}

/** The templates, as in the prototype: `{transform}` and `{field}` are values. */
const TEMPLATES: Record<string, string> = {
  recursive_character: "Cut with {transform} into pieces of {chunk_size}, overlapping {chunk_overlap}. Heading context is {heading_context}.",
  sentence_window: "Cut {transform}, {sentences_per_chunk} to a piece, overlapping {overlap_sentences}.",
  layout_blocks: "Cut {transform}, up to {max_tokens} a piece, starting a new piece at headings down to level {section_level}.",
  token_based: "Cut by {transform}, {max_tokens} to a piece, overlapping {overlap}.",
  markdown_header: "Cut {transform}, up to {max_tokens} a piece.",
  hybrid_rrf: "Search with {transform}, keeping {top_k}, fused with RRF k {rrf_k}. Query rewrite is {query_expansion}.",
  dense: "Search with {transform}, keeping {top_k}.",
  bm25: "Search with {transform}, keeping {top_k}.",
}

/** A field's title in a sentence: Compare's sentence-case title, else the schema's. */
export function fieldTitle(key: string, schema: JsonSchema): string {
  return RECIPE_TITLES[key] ?? schema.properties?.[key]?.title ?? key.replace(/_/g, " ")
}

/** One value in words: a number with its unit, a switch as on or off, an option by its label. */
export function valueText(key: string, value: unknown, schema: JsonSchema): string {
  if (typeof value === "boolean") return value ? "on" : "off"
  if (value === null || value === undefined) return key === "truncate_dim" ? "native width" : "none"
  if (typeof value === "number") {
    const unit = UNITS[key]
    if (!unit) return String(value)
    return `${value} ${value === 1 ? unit.replace(/s$/, "") : unit}`
  }
  if (typeof value === "string") {
    const word = VALUE_WORDS[key]?.[value]
    if (word) return word
    const prop = schema.properties?.[key]
    return prop ? optionLabel(prop, value) : value
  }
  if (Array.isArray(value)) {
    const xs = value.map(String)
    return xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`
  }
  return JSON.stringify(value)
}

/**
 * The recipe as sentence parts. A strategy with a template reads as the
 * prototype's sentence; any shown field the template leaves out adds
 * "{Title} is {value}.", so every setting stays reachable. A strategy with no
 * template reads "Use {Strategy}." then those sentences. A field fixed by its
 * schema (`const`) cannot change, so it is left out.
 */
export function recipeSentence(variant: Variant, schema: JsonSchema, label: string): SentencePart[] {
  const config = variant.config
  const parts: SentencePart[] = []
  const used = new Set<string>()
  const template = TEMPLATES[variant.transform] ?? "Use {transform}."
  for (const piece of template.split(/(\{[a-z_]+\})/)) {
    if (!piece) continue
    const m = /^\{([a-z_]+)\}$/.exec(piece)
    if (!m) parts.push({ text: piece })
    else if (m[1] === "transform") parts.push({ text: label, field: "transform" })
    else {
      used.add(m[1])
      parts.push({ text: valueText(m[1], config[m[1]], schema), field: m[1] })
    }
  }
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (used.has(key) || "const" in prop || !isShown(prop, config)) continue
    parts.push({ text: ` ${fieldTitle(key, schema)} is ` }, { text: valueText(key, config[key] ?? prop.default, schema), field: key }, { text: "." })
  }
  return parts
}
