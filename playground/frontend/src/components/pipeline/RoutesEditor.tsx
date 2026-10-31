import { useId, useRef } from "react"

import { defaultsFor } from "@/components/fields/schema"
import { SchemaForm } from "@/components/SchemaForm"
import { Button } from "@/components/ui/button"
import type { CategoryDef, RouteRule, Step } from "@/state/config"
import { addCheck, addRule, checksOfRule, moveRule, removeCheck, removeRule, routeProblem, ruleSentence, setCategory, setCheck, type CheckInfo } from "@/state/routes"

const SELECT = "h-8 rounded-md border border-hairline bg-surface px-2 text-sm"

/** A step for check `use`, with its settings at their defaults. */
const newStep = (use: string, checks: Record<string, CheckInfo>): Step => ({ use, ...defaultsFor(checks[use].config_schema, checks[use].config_schema) })

/**
 * The route: ordered rules, each with one or more checks and a category. The
 * first rule whose checks all pass picks the category. The last rule is fixed
 * as "Anything else". `checks` is the server's list, so the hosted demo shows
 * only the built-in ones.
 */
export function RoutesEditor({
  route,
  categories,
  checks,
  onChange,
}: {
  route: RouteRule[]
  categories: Record<string, CategoryDef>
  checks: Record<string, CheckInfo>
  onChange: (route: RouteRule[]) => void
}) {
  const id = useId()
  // One id per rule, kept in step with the rules, so a rule's own form state
  // (such as a JSON field's error) moves with it when it moves.
  const next = useRef(0)
  const ids = useRef<number[]>([])
  while (ids.current.length < route.length) ids.current.push(next.current++)
  ids.current.length = route.length
  const change = (rules: RouteRule[], ruleIds = ids.current) => {
    ids.current = ruleIds
    onChange(rules)
  }
  const names = Object.keys(checks)
  const last = route.length - 1
  const problem = routeProblem(route, categories)
  const nameOf = (c: string) => categories[c]?.name ?? c
  const moved = (from: number, to: number) => {
    const out = [...ids.current]
    out.splice(to, 0, ...out.splice(from, 1))
    return out
  }
  const picker = (label: string, onPick: (use: string) => void) => (
    <select
      aria-label={label}
      className={SELECT}
      value=""
      onChange={(e) => {
        if (e.target.value) onPick(e.target.value)
      }}
    >
      <option value="">{label}</option>
      {names.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  )
  return (
    <div className="flex flex-col gap-2 p-3 text-sm">
      <h3 className="font-semibold">Routes</h3>
      <p className="text-fg-muted">New documents only: documents already sorted stay where they are.</p>
      {problem ? (
        <p role="alert" className="text-danger">
          {problem}
        </p>
      ) : null}
      <ol className="flex flex-col gap-2">
        {route.map((rule, i) => {
          const n = i + 1
          const isLast = i === last
          return (
            <li key={ids.current[i]} className="flex flex-col gap-2 rounded-md border border-hairline p-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{isLast ? "Anything else" : `Rule ${n}`}</span>
                {isLast ? null : (
                  <>
                    <Button size="sm" variant="ghost" aria-label={`Move rule ${n} up`} disabled={i === 0} onClick={() => change(moveRule(route, i, i - 1), moved(i, i - 1))}>
                      Up
                    </Button>
                    <Button size="sm" variant="ghost" aria-label={`Move rule ${n} down`} disabled={i === last - 1} onClick={() => change(moveRule(route, i, i + 1), moved(i, i + 1))}>
                      Down
                    </Button>
                    <Button size="sm" variant="ghost" aria-label={`Remove rule ${n}`} onClick={() => change(removeRule(route, i), ids.current.filter((_, n) => n !== i))}>
                      Remove
                    </Button>
                  </>
                )}
                <label htmlFor={`${id}-c${i}`} className="text-xs text-fg-muted">
                  {`Category of rule ${n}`}
                </label>
                <select id={`${id}-c${i}`} aria-label={`Category of rule ${n}`} className={SELECT} value={rule.category} onChange={(e) => onChange(setCategory(route, i, e.target.value))}>
                  {Object.keys(categories).map((c) => (
                    <option key={c} value={c}>
                      {nameOf(c)}
                    </option>
                  ))}
                </select>
              </div>
              {checksOfRule(rule).map((step, j) => {
                const info = checks[step.use]
                const { use, ...settings } = step
                return (
                  <div key={j} className="flex flex-col gap-1 border-l border-hairline pl-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{use}</span>
                      {info ? <span className="text-fg-muted">{info.summary}</span> : <span className="text-danger">{`This server has no check called ${use}.`}</span>}
                      {checksOfRule(rule).length > 1 ? (
                        <Button size="sm" variant="ghost" aria-label={`Remove check ${j + 1} of rule ${n}`} onClick={() => onChange(removeCheck(route, i, j))}>
                          Remove check
                        </Button>
                      ) : null}
                    </div>
                    {info ? <SchemaForm schema={info.config_schema} value={settings} onChange={(v) => onChange(setCheck(route, i, j, { use, ...v }))} /> : null}
                  </div>
                )
              })}
              {isLast ? null : picker(`Add a check to rule ${n}`, (use) => onChange(addCheck(route, i, newStep(use, checks))))}
              <p className="text-fg-muted">{ruleSentence(rule, checks, nameOf(rule.category))}</p>
            </li>
          )
        })}
      </ol>
      {picker("Add a rule", (use) => change(addRule(route, last, newStep(use, checks)), [...ids.current.slice(0, last), next.current++, ...ids.current.slice(last)]))}
    </div>
  )
}
