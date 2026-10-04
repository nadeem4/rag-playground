/**
 * Is a transform at home behind the upstream it is wired to?
 *
 * Mirrors the server's capability check (`core/graph.py`): a transform's
 * `requires` and `prefers` are per input port, and each is a subset test
 * against what the upstream on that port `provides`. The server only enforces
 * `requires`; this helper is what lets the UI say so before Run, and explain
 * a soft `prefers` miss that the server would silently fall back on.
 */

import type { TransformInfo } from "@/api/types"

export type Compat = { kind: "ok" } | { kind: "soft" | "hard"; reason: string }

/** Plain words for the capability values plugins declare. Unknown values show as-is. */
const WORDS: Record<string, string> = {
  headings: "headings",
  dense: "a dense index",
  fts: "text search",
}

function missing(need: Record<string, unknown>, have: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const [key, want] of Object.entries(need)) {
    const got = have[key]
    if (Array.isArray(want)) {
      const gotList: unknown[] = Array.isArray(got) ? got : []
      for (const v of want) if (!gotList.includes(v)) out.push(WORDS[String(v)] ?? String(v))
    } else if (got !== want) {
      out.push(`${key} ${String(want)}`)
    }
  }
  return out
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("")
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}

/** `upstream` maps each of the candidate's input ports to the transform wired into it, when known. */
export function compatibility(candidate: TransformInfo, upstream: Record<string, TransformInfo | undefined>): Compat {
  for (const [port, need] of Object.entries(candidate.requires ?? {})) {
    const up = upstream[port]
    if (!up) continue
    const gap = missing(need, up.provides ?? {})
    if (gap.length) {
      return { kind: "hard", reason: `Needs ${list(gap)} from the ${up.stage} step. ${up.name} does not provide it, so this cannot run.` }
    }
  }
  for (const [port, need] of Object.entries(candidate.prefers ?? {})) {
    const up = upstream[port]
    if (!up) continue
    const gap = missing(need, up.provides ?? {})
    if (gap.length) {
      const fallback = candidate.fallback?.trim() || "It falls back."
      const tail = fallback.charAt(0).toLowerCase() + fallback.slice(1)
      return { kind: "soft", reason: `Needs ${list(gap)} from the ${up.stage} step. ${up.name} does not find any, so ${tail}` }
    }
  }
  return { kind: "ok" }
}
