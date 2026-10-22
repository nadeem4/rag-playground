import type { Registry, Stage, TransformInfo } from "@/api/types"

/**
 * Settings Pandion's catalog already says, read from it rather than copied:
 * a default that changes in Pandion changes here, and a new chunker's size
 * and overlap settings are found by what they do, not by their names.
 */

/** A setting's default in the catalog for one strategy, or undefined when the catalog has none. */
export function settingDefault(registry: Registry, stage: Stage, use: string, field: string): unknown {
  return registry[stage]?.[use]?.config_schema?.properties?.[field]?.default
}

const numberOr = (v: unknown): number | null => (typeof v === "number" ? v : null)

/** How many of the top pieces `pandion.evaluate` checks unless told: the eval step's default `top_k`. */
export const evaluateTopK = (registry: Registry): number | null => numberOr(settingDefault(registry, "use_case", "eval", "top_k"))

/** How close a claim must be to the sentence it cites to count as supported: the chat step's default. */
export const supportThreshold = (registry: Registry): number | null =>
  numberOr(settingDefault(registry, "use_case", "chat", "support_threshold"))

/** A chunker's size setting and its overlap setting when it has one, as its schema marks them (`x-role`). */
export function sizeFields(chunker: TransformInfo | undefined): { size?: string; overlap?: string } {
  const properties = chunker?.config_schema?.properties ?? {}
  const role = (r: string) => Object.keys(properties).find((k) => properties[k]?.["x-role"] === r)
  return { size: role("size"), overlap: role("overlap") }
}
