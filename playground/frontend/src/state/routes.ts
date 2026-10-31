import type { RouteCheckInfo } from "@/api/types"

import type { CategoryDef, RouteRule, Step } from "./config"

/** Operations on a pipeline's route: the ordered rules that choose a category. Each returns a new route. */

/** One route check as `GET /strategies` lists it under `route`. */
export type CheckInfo = RouteCheckInfo

const checksOf = (rule: RouteRule): Step[] => (rule.when === undefined ? [] : Array.isArray(rule.when) ? rule.when : [rule.when])
/** One check is stored as itself, more as a list. */
const whenOf = (checks: Step[]): Step | Step[] => (checks.length === 1 ? checks[0] : checks)
const withChecks = (rule: RouteRule, checks: Step[]): RouteRule => ({ ...rule, when: whenOf(checks) })
const replaceAt = (route: RouteRule[], i: number, rule: RouteRule) => route.map((r, n) => (n === i ? rule : r))

/** A new rule before the last one, at place `at` (past the end means just before the last). It sends documents to the category the last rule does. */
export function addRule(route: RouteRule[], at: number, check: Step): RouteRule[] {
  const last = route.length - 1
  const place = Math.max(0, Math.min(at, last))
  const rule: RouteRule = { when: check, category: route[last]?.category ?? "default" }
  return [...route.slice(0, place), rule, ...route.slice(place)]
}

/** Rule `from` moved to place `to`. The last rule stays last, so a move that touches it changes nothing. */
export function moveRule(route: RouteRule[], from: number, to: number): RouteRule[] {
  const last = route.length - 1
  if (from === to || from < 0 || to < 0 || from >= last || to >= last) return route
  const next = [...route]
  const [rule] = next.splice(from, 1)
  next.splice(to, 0, rule)
  return next
}

/** The route without rule `i`. The last rule cannot be removed. */
export function removeRule(route: RouteRule[], i: number): RouteRule[] {
  if (i < 0 || i >= route.length - 1) return route
  return route.filter((_, n) => n !== i)
}

export function setCategory(route: RouteRule[], i: number, category: string): RouteRule[] {
  return replaceAt(route, i, { ...route[i], category })
}

/** Check `j` of rule `i` replaced by `step`. */
export function setCheck(route: RouteRule[], i: number, j: number, step: Step): RouteRule[] {
  const checks = checksOf(route[i])
  if (j < 0 || j >= checks.length) return route
  return replaceAt(route, i, withChecks(route[i], checks.map((c, n) => (n === j ? step : c))))
}

/** A check added to rule `i`. The last rule has none. */
export function addCheck(route: RouteRule[], i: number, step: Step): RouteRule[] {
  if (i >= route.length - 1) return route
  return replaceAt(route, i, withChecks(route[i], [...checksOf(route[i]), step]))
}

/** Check `j` of rule `i` removed. A rule keeps at least one check. */
export function removeCheck(route: RouteRule[], i: number, j: number): RouteRule[] {
  const checks = checksOf(route[i])
  if (checks.length < 2 || j < 0 || j >= checks.length) return route
  return replaceAt(route, i, withChecks(route[i], checks.filter((_, n) => n !== j)))
}

export const checksOfRule = checksOf

// The list field keeps a blank row while it is being typed into, so the sentence leaves blanks out.
const list = (v: unknown): string => (Array.isArray(v) ? v.filter((x) => String(x ?? "").trim() !== "").join(" or ") : String(v ?? ""))
const KEYED = (label: string, s: Step) =>
  s.equals != null ? `${label} ${s.key} equals ${s.equals}` : s.contains != null ? `${label} ${s.key} contains ${s.contains}` : `${label} ${s.key} matches ${s.pattern}`

/** How each built-in check reads in a sentence. */
const PHRASES: Record<string, (s: Step) => string> = {
  file_type: (s) => `the file type is ${list(s.types)}`,
  name: (s) => `the file name matches ${s.pattern}`,
  path: (s) => `the path matches ${s.pattern}`,
  metadata: (s) => KEYED("the label", s),
  properties: (s) => KEYED("the property", s),
  text_layer: (s) => (s.has === false ? "the PDF has no text layer" : "the PDF has a text layer"),
  contains: (s) => `the first page has ${list(s.words)}`,
}

function phrase(step: Step, checks: Record<string, CheckInfo>): string {
  const own = PHRASES[step.use]
  if (own) return own(step)
  const summary = (checks[step.use]?.summary ?? step.use).replace(/\.$/, "")
  return summary.charAt(0).toLowerCase() + summary.slice(1)
}

/** One rule as a sentence, for example "When the file type is pdf and the PDF has no text layer, use Scanned PDFs." */
export function ruleSentence(rule: RouteRule, checks: Record<string, CheckInfo>, categoryName: string): string {
  if (rule.when === undefined) return `Anything else uses ${categoryName}.`
  const text = checksOf(rule).map((s) => phrase(s, checks)).join(" and ")
  return `When ${text}, use ${categoryName}.`
}

/** The first thing wrong with the route, in Pandion's words, or null. */
export function routeProblem(route: RouteRule[], categories: Record<string, CategoryDef> | Record<string, unknown>): string | null {
  if (route.length === 0) return "The file has categories but no route. route lists the rules that choose a category, and its last rule has no when."
  const known = Object.keys(categories)
  for (const [i, rule] of route.entries()) {
    const n = i + 1
    if (!known.includes(rule.category)) {
      return `Rule ${n} names the category '${rule.category}', which is not under categories. The categories are: ${known.map((k) => `'${k}'`).join(", ")}.`
    }
    if (rule.when === undefined && n < route.length) {
      return `Rule ${n} has no when, so it takes every document and the rules after it can never run. Only the last rule may leave out when.`
    }
    if (rule.when !== undefined && checksOf(rule).length === 0) return `Rule ${n} must hold at least one check.`
  }
  if (route[route.length - 1].when !== undefined) return "The last rule of route must have no when, so every document goes to some category."
  return null
}
