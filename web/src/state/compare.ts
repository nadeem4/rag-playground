import type { Registry, Stage, Variant } from "@/api/types"
import { RETRIEVAL_LABEL } from "@/components/ask/AskSettings"
import { strategyLabel } from "@/learn/challenges"

import { variantLabels } from "./sweep"

/**
 * Compare's words: what each recipe is called. Pure, so the page and its
 * tests read the same sentences.
 */

/** A recipe's names: in words, its code name, and the short form a tab or a sentence uses. */
export interface RecipeName {
  /** `Recursive (natural breaks), 400 characters`. */
  name: string
  /** The transform's code name, `recursive_character`. */
  code: string
  /** `400 characters`, or the plain name when no size tells the recipe apart. */
  short: string
}

/** The fields whose value is a size, with its unit. */
export const SIZE_UNITS: Record<string, string> = {
  chunk_size: "characters",
  max_tokens: "tokens",
  sentences_per_chunk: "sentences",
  truncate_dim: "dimensions",
}

/** A size with its unit; a null width is the embedder's own. */
function sized(field: string, value: unknown): string {
  return value === null ? "native width" : `${String(value)} ${SIZE_UNITS[field]}`
}

/**
 * Each recipe by Build's plain name (the Ask panel's name on Retrieve), plus
 * the first field that tells it apart and has a unit.
 */
export function recipeNames(variants: Variant[], stage: Stage, registry: Registry): RecipeName[] {
  const labels = variantLabels(variants, registry, stage)
  return variants.map((v, i) => {
    const plain = (stage === "retrieve" ? RETRIEVAL_LABEL[v.transform] : undefined) ?? strategyLabel(v.transform)
    const field = labels[i].fields.find(([k]) => k in SIZE_UNITS)?.[0]
    const size = field ? sized(field, v.config[field]) : null
    return { name: size ? `${plain}, ${size}` : plain, code: v.transform, short: size ?? plain }
  })
}
