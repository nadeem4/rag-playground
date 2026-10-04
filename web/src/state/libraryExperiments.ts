import { MAX_RECIPES } from "./compare"
import {
  isExperiment,
  MAX_EXPERIMENTS,
  readExperiments,
  readRawExperiments,
  requestOpenExperiment,
  useExperiments,
  writeRawExperiments,
  type SavedExperiment,
} from "./experiments"
import { mergeById, type ImportResult } from "./pipelines"

/**
 * Saved experiments for the Library page, on Compare's own store
 * (state/experiments.ts): the same list, the same checks and the same open
 * handoff. Only the Library's writes differ: a delete, an import or "Delete
 * saved" writes the raw stored entries back as they are, so an entry Compare
 * cannot read now, or a field it adds later, is never stripped.
 */

export { MAX_EXPERIMENTS, MAX_RECIPES, readExperiments, useExperiments, type SavedExperiment }

export const EXPERIMENTS_KEY = "rag-playground:experiments:v1"
/** Compare reads this id once on load (`takeOpenRequest`) and opens that experiment. */
export const OPEN_EXPERIMENT_KEY = "rag-playground:experiments:open"

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** An incoming entry fit to store: what Compare's store accepts, so within MAX_RECIPES. */
export function asIncomingExperiment(v: unknown): SavedExperiment | null {
  return isExperiment(v) ? v : null
}

/** The stored object an experiment was read from, untouched, so an export carries every field Compare wrote. */
export function rawExperiment(e: SavedExperiment): Record<string, unknown> {
  const raw = readRawExperiments().find((x) => isObject(x) && x.id === e.id)
  return isObject(raw) ? raw : (e as unknown as Record<string, unknown>)
}

export function deleteExperiment(id: string): void {
  writeRawExperiments(readRawExperiments().filter((e) => !(isObject(e) && e.id === id)))
}

export function clearExperiments(): void {
  writeRawExperiments([])
}

/**
 * Add experiments from a file: by id, never duplicated, never removing one
 * already saved, at most twenty in all. Each incoming entry is stored as it
 * came (its `kind` tag aside). `invalid` counts entries Compare's store would
 * refuse. Null when storage refused the write.
 */
export function importExperiments(incoming: readonly unknown[]): (ImportResult<SavedExperiment> & { invalid: number }) | null {
  const valid: SavedExperiment[] = []
  const rawOf = new Map<SavedExperiment, Record<string, unknown>>()
  for (const v of incoming) {
    const e = asIncomingExperiment(v)
    if (!e) continue
    const { kind: _kind, ...rest } = v as Record<string, unknown>
    rawOf.set(e, rest)
    valid.push(e)
  }
  const entries = readRawExperiments()
  const ids = new Set(entries.flatMap((e) => (isObject(e) && typeof e.id === "string" ? [e.id] : [])))
  const { add, result } = mergeById(ids, entries.length, valid, MAX_EXPERIMENTS)
  if (!writeRawExperiments([...entries, ...add.map((e) => rawOf.get(e))])) return null
  return { ...result, invalid: incoming.length - valid.length }
}

/** Ask Compare to open this experiment on its next load in this tab. */
export function openExperiment(id: string): void {
  requestOpenExperiment(id)
}
