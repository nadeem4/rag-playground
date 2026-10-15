import { useId } from "react"
import { ArrowDown, ArrowUp } from "lucide-react"

import type { Cost, Stage } from "@/api/types"
import { ordinal } from "@/components/inspectors/hits"
import { CONTROL } from "@/components/fields/types"
import { ChunkBar } from "@/components/pipeline/NodeCard"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { cellWords, costCell, costLine, seconds as secondsText, tokenCounts, unpricedTitle } from "@/state/cost"
import { firstDirection, sortRecipes, type RecipeStatus as Status, type SortKey } from "@/state/compare"

import { RecipeStatus } from "./RecipeStatus"
import { Swatches, type SwatchPiece } from "./Swatches"

/** One recipe in the overview, from the run's own response. */
export interface OverviewRow {
  i: number
  name: string
  code: string
  own: boolean
  status: Status
  seconds: number | null
  done: boolean
  values: Partial<Record<SortKey, number | null>>
  /** The chunk set, for its bar. */
  set?: unknown
  /** The top 5, for the swatches. */
  pieces?: SwatchPiece[]
  /** The server names this recipe best (pandion's Comparisons.best). */
  best?: boolean
  /** Its varied step and after (pandion-api's `varied_cost`); absent on older results. */
  cost?: Cost | null
}

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]
const word = (n: number) => WORDS[n] ?? String(n)
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)

/** The sort keys a stage offers, with their names in the Sort by menu and in the helper line. */
const SORTS: Partial<Record<Stage, [SortKey, string, string][]>> = {
  chunk: [
    ["order", "Recipe order", "recipe order"],
    ["pieces", "Pieces", "pieces"],
    ["tokens", "Tokens", "tokens"],
    ["median", "Median tokens", "median tokens"],
    ["p95", "Largest 5%", "the largest 5%"],
    ["uncovered", "Characters left out", "characters left out"],
  ],
  retrieve: [
    ["order", "Recipe order", "recipe order"],
    ["rank", "Answer", "the answer's place"],
    ["shared", "Shared with the baseline", "pieces shared with the baseline"],
    ["returned", "Returned", "pieces returned"],
  ],
}

const COLUMNS: Partial<Record<Stage, [SortKey, string][]>> = {
  chunk: [
    ["pieces", "Pieces"],
    ["tokens", "Tokens"],
    ["median", "Median"],
    ["p95", "Largest 5%"],
    ["uncovered", "Left out"],
  ],
  retrieve: [
    ["rank", "Answer"],
    ["shared", "Shared"],
    ["returned", "Returned"],
  ],
}

const TAG = "inline-block rounded-swatch px-2 py-px text-xs whitespace-nowrap"

/** The Time cell: the seconds, with a bar scaled to the slowest row. */
function TimeCell({ cost, slowest }: { cost: Cost; slowest: number }) {
  const width = Math.max(3, Math.round((56 * cost.seconds) / (slowest || 1)))
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="whitespace-nowrap">{secondsText(cost.seconds)}</span>
      <span aria-hidden className="inline-block h-[6px] shrink-0 rounded-full bg-primary opacity-55" style={{ width }} />
    </span>
  )
}

/** The Tokens cell: input in mono, output under it; a dash when no model counted any, never 0. */
function TokensCell({ cost }: { cost: Cost }) {
  const t = tokenCounts(cost)
  if (!t)
    return (
      <span aria-label="No tokens" className="text-fg-muted">
        -
      </span>
    )
  return (
    <span className="inline-flex flex-col items-end">
      <span>{t.input}</span>
      <small className="font-sans text-2xs text-fg-muted">in, {t.output} out</small>
    </span>
  )
}

/** The Cost cell: dollars when priced, else a tag that says why not. Never $0 for something unknown. */
function CostCell({ cost }: { cost: Cost }) {
  const cell = costCell(cost)
  const noPrice = (models: string[]) => (
    <span title={unpricedTitle(models)} className={cn(TAG, "bg-warn font-sans text-warn-text")}>
      no price
    </span>
  )
  if (cell.kind === "dollars")
    return cell.unpriced.length ? (
      <span className="inline-flex flex-col items-end gap-px">
        {cell.text}
        {noPrice(cell.unpriced)}
      </span>
    ) : (
      <>{cell.text}</>
    )
  if (cell.kind === "unpriced") return noPrice(cell.models)
  if (cell.kind === "uncounted")
    return (
      <span title={`${cell.models.join(", ")} sent no token count`} className="font-sans text-xs text-fg-muted">
        {cellWords(cell)}
      </span>
    )
  return <span className={cn(TAG, "bg-surface-elevated font-sans text-fg-muted")}>local</span>
}

const CHECK_BOX = "inline-flex items-center justify-center pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px]"

/**
 * Four recipes or more after a run: the helper line, then a table whose
 * number headers sort (a list with Sort by when narrow), each finished row
 * opening beside Your pipeline or ticked, up to `fit`, to read side by side.
 * An unfinished row shows its status where its numbers will be. Parse and
 * Index have no numbers to sort, so they are a plain list.
 */
export function Overview({
  stage,
  rows,
  sort,
  onSort,
  ticked,
  onTick,
  onClear,
  onRead,
  onOpen,
  onChange,
  fit,
  narrow,
  goldKnown,
  top,
  baseAt = 0,
  baseName = "Your pipeline",
  variedFrom = null,
}: {
  stage: Stage
  /** In recipe order. */
  rows: OverviewRow[]
  sort: { key: SortKey; dir: 1 | -1 }
  onSort: (key: SortKey, dir: 1 | -1) => void
  ticked: number[]
  onTick: (i: number, on: boolean) => void
  onClear: () => void
  onRead: (from: HTMLElement) => void
  onOpen: (i: number, from: HTMLElement) => void
  /** Change this recipe, on a failed row. */
  onChange: (i: number) => void
  fit: number
  narrow: boolean
  /** The question is one of the sample's own: only then is there an Answer column. */
  goldKnown: boolean
  /** How many places Shared counts against: Your pipeline's top 5, or fewer when it returned fewer. */
  top: number
  /** The recipe the others are read against. */
  baseAt?: number
  /** Its name in sentences: Your pipeline, or its phrase when no recipe was the pipeline's own. */
  baseName?: string
  /** The stage the comparison varies, from its result; null for a result saved before speed and cost. */
  variedFrom?: string | null
}) {
  const sortId = useId()
  // Time, Tokens and Cost, when the result carries each recipe's varied cost. On Chunk, Tokens are already the pieces'.
  const costShown = !!variedFrom && rows.some((r) => r.cost)
  const tokensName = stage === "chunk" ? "Model tokens" : "Tokens"
  const costSorts: [SortKey, string, string][] = costShown
    ? [
        ["time", "Time", "time"],
        ["modelTokens", tokensName, tokensName.toLowerCase()],
        ["cost", "Cost", "cost"],
      ]
    : []
  const plain = (SORTS[stage] ?? []).length === 0
  const sorts = plain ? [] : [...(SORTS[stage] ?? []), ...costSorts].filter(([k]) => k !== "rank" || goldKnown)
  const columns = (COLUMNS[stage] ?? []).filter(([k]) => k !== "rank" || goldKnown)
  const slowest = Math.max(0, ...rows.map((r) => r.cost?.seconds ?? 0))
  const list = sortRecipes(rows, sort.key, sort.dir)
  const finished = rows.filter((r) => r.done)
  const pieces = finished.map((r) => r.values.pieces).filter((x): x is number => typeof x === "number")
  const most = stage === "chunk" && pieces.length > 1 ? Math.max(...pieces) : null
  const fewest = stage === "chunk" && pieces.length > 1 ? Math.min(...pieces) : null
  // One row at each end carries the label: the first in recipe order, as the finding names it.
  const mostAt = most !== fewest ? finished.find((r) => r.values.pieces === most)?.i : undefined
  const fewestAt = most !== fewest ? finished.find((r) => r.values.pieces === fewest)?.i : undefined
  const extreme = (r: OverviewRow) => (r.i === mostAt ? "most" : r.i === fewestAt ? "fewest" : null)
  const ticks = fit > 1
  const caption = `Results for ${word(rows.length)} recipes`
  const helperKey = sorts.find(([k]) => k === sort.key)?.[2] ?? "recipe order"
  const helper = plain
    ? "Open any recipe to read it."
    : `Sorted by ${helperKey}. ${fit > 1 ? `Tap a name to open it beside ${baseName}, or tick up to ${word(fit)} to read side by side.` : "Open any recipe to read it."}`
  const openLabel = (r: OverviewRow) =>
    r.i === baseAt ? (r.own ? "Open Your pipeline" : `Open ${r.name}`) : fit > 1 ? `Open ${r.name} beside ${baseName}` : `Open ${r.name}`

  const tick = (r: OverviewRow) => {
    if (!ticks || !r.done) return null
    const on = ticked.includes(r.i)
    return (
      <label className={CHECK_BOX}>
        <input type="checkbox" aria-label={`Select ${r.name}`} checked={on} disabled={!on && ticked.length >= fit} onChange={(e) => onTick(r.i, e.target.checked)} />
      </label>
    )
  }
  const tag = (r: OverviewRow) =>
    r.own || r.best ? (
      <span className="flex flex-wrap items-baseline gap-2">
        {r.own ? <span className="inline-block self-start rounded-swatch bg-accent-wash px-2 py-px text-xs font-semibold text-primary">Your pipeline</span> : null}
        {r.best ? <span className="text-xs font-medium text-fg">Best</span> : null}
      </span>
    ) : null
  const status = (r: OverviewRow) => <RecipeStatus status={r.status} seconds={r.seconds} onChange={() => onChange(r.i)} />
  const numberWords = (r: OverviewRow) => {
    const v = r.values
    if (stage === "chunk") {
      const ext = extreme(r)
      return [`${v.pieces} ${v.pieces === 1 ? "piece" : "pieces"}${ext ? ` (${ext})` : ""}`, `${v.tokens} tokens`, ...(v.median != null ? [`median ${v.median}`] : []), `${v.uncovered} characters left out`].join(", ")
    }
    const answer = goldKnown ? `Answer ${v.rank ? ordinal(v.rank) : "not found"}. ` : ""
    return `${answer}${r.i === baseAt ? "The baseline." : `Shares ${v.shared ?? 0} of ${top} with ${baseName}.`}`
  }
  const picture = (r: OverviewRow) => (stage === "chunk" ? <ChunkBar data={r.set} size="bar" /> : r.pieces ? <Swatches pieces={r.pieces} /> : null)

  let body
  if (!narrow && !plain) {
    const th = (key: SortKey, label: string, numeric: boolean, extra?: string) => {
      const on = sort.key === key
      return (
        <th key={key} scope="col" aria-sort={on ? (sort.dir === 1 ? "ascending" : "descending") : "none"} className={cn("px-2 py-1 font-medium", numeric ? "text-right" : "text-left", extra)}>
          <button
            type="button"
            onClick={() => onSort(key, on ? (sort.dir === 1 ? -1 : 1) : firstDirection(key))}
            className={cn("inline-flex min-h-row items-center gap-1 rounded-control px-1 text-xs hover:bg-muted pointer-coarse:min-h-[44px]", on ? "text-fg" : "text-fg-muted")}
          >
            {label}
            {on ? sort.dir === 1 ? <ArrowUp aria-hidden className="size-[12px]" /> : <ArrowDown aria-hidden className="size-[12px]" /> : null}
          </button>
        </th>
      )
    }
    body = (
      <table className={cn("w-full table-fixed border-collapse text-sm", costShown && "min-w-[880px]")}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-hairline">
            <th scope="col" className="w-[48px] px-2 py-1">
              <span className="sr-only">Select</span>
            </th>
            {th("order", "Recipe", false)}
            {columns.map(([k, l]) => th(k, l, true))}
            <th scope="col" className={cn("px-2 py-1 text-left text-xs font-medium text-fg-muted", stage === "chunk" ? "w-[30%]" : "w-[180px]")}>
              {stage === "chunk" ? "The document, to scale" : "Top 5, by piece"}
            </th>
            {costShown ? (
              <>
                {th("time", `Time, ${variedFrom} and after`, true, "w-[132px] border-l border-hairline")}
                {th("modelTokens", tokensName, true, "w-[104px]")}
                {th("cost", "Cost", true, "w-[96px]")}
              </>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.i} data-recipe={r.i} className={cn("border-b border-hairline align-middle", r.own && "bg-accent-wash/40", ticked.includes(r.i) && "bg-surface-elevated")}>
              <td className="px-2 py-2 text-center">{tick(r)}</td>
              <td className="px-2 py-2">
                <div className="flex min-w-0 flex-col items-start gap-px">
                  {tag(r)}
                  {r.done ? (
                    <button
                      type="button"
                      aria-label={openLabel(r)}
                      onClick={(e) => onOpen(r.i, e.currentTarget)}
                      className="rounded-control text-left font-medium break-words text-fg underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring) pointer-coarse:inline-flex pointer-coarse:min-h-[44px] pointer-coarse:items-center"
                    >
                      {r.name}
                    </button>
                  ) : (
                    <span className="font-medium break-words">{r.name}</span>
                  )}
                  <span className="font-mono text-2xs break-all text-fg-muted">{r.code}</span>
                </div>
              </td>
              {r.done ? (
                <>
                  {columns.map(([k]) => (
                    <td key={k} className="px-2 py-2 text-right font-mono tabular-nums">
                      {k === "pieces" && extreme(r) ? (
                        <span className="inline-flex flex-col items-end">
                          {r.values.pieces}
                          <small className="font-sans text-2xs text-fg-muted">{extreme(r)}</small>
                        </span>
                      ) : k === "rank" ? (
                        r.values.rank ? (
                          ordinal(r.values.rank)
                        ) : (
                          <span className="inline-flex flex-col items-end">
                            none<small className="font-sans text-2xs text-fg-muted">not found</small>
                          </span>
                        )
                      ) : k === "shared" ? (
                        r.i === baseAt ? (
                          <span className="font-sans text-sm text-fg-muted">baseline</span>
                        ) : (
                          `${r.values.shared ?? 0} of ${top}`
                        )
                      ) : (
                        (r.values[k] ?? "")
                      )}
                    </td>
                  ))}
                  <td className="px-2 py-2">{picture(r)}</td>
                  {costShown ? (
                    r.cost ? (
                      <>
                        <td className="border-l border-hairline px-2 py-2 text-right font-mono tabular-nums">
                          <TimeCell cost={r.cost} slowest={slowest} />
                        </td>
                        <td className="px-2 py-2 text-right font-mono tabular-nums">
                          <TokensCell cost={r.cost} />
                        </td>
                        <td className="px-2 py-2 text-right font-mono tabular-nums">
                          <CostCell cost={r.cost} />
                        </td>
                      </>
                    ) : (
                      <td colSpan={3} className="border-l border-hairline px-2 py-2" />
                    )
                  ) : null}
                </>
              ) : (
                <td colSpan={columns.length + 1 + (costShown ? 3 : 0)} className="px-2 py-2">
                  {status(r)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    )
  } else {
    body = (
      <>
        {plain ? null : (
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={sortId} className="text-sm text-fg-muted">
              Sort by
            </label>
            <select
              id={sortId}
              className={cn(CONTROL, "w-auto pointer-coarse:min-h-[44px]")}
              value={sort.key}
              onChange={(e) => {
                const key = e.target.value as SortKey
                onSort(key, firstDirection(key))
              }}
            >
              {sorts.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            {sort.key !== "order" ? (
              <Button variant="ghost" size="sm" className="pointer-coarse:min-h-[44px]" onClick={() => onSort(sort.key, sort.dir === 1 ? -1 : 1)}>
                {sort.dir === 1 ? "Lowest first" : "Highest first"}
              </Button>
            ) : null}
          </div>
        )}
        <ul aria-label={caption} className="m-0 flex list-none flex-col p-0">
          {list.map((r) => (
            <li key={r.i} data-recipe={r.i} className={cn("flex min-w-0 items-start gap-2 border-b border-hairline py-2", r.own && "bg-accent-wash/40")}>
              {ticks ? <span className="w-[44px] shrink-0">{tick(r)}</span> : null}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                {r.done ? (
                  <button
                    type="button"
                    aria-label={openLabel(r)}
                    onClick={(e) => onOpen(r.i, e.currentTarget)}
                    className="flex min-h-[44px] flex-col items-start justify-center gap-px rounded-control text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)"
                  >
                    {tag(r)}
                    <span className="font-medium break-words">{r.name}</span>
                    <span className="font-mono text-2xs break-all text-fg-muted">{r.code}</span>
                  </button>
                ) : (
                  <div className="flex flex-col items-start gap-px">
                    {tag(r)}
                    <span className="font-medium break-words">{r.name}</span>
                  </div>
                )}
                {r.done ? (
                  <>
                    {plain ? null : <p className="m-0 text-sm text-fg-muted">{numberWords(r)}</p>}
                    {costShown && r.cost ? <p className="m-0 font-mono text-xs text-fg-muted tabular-nums">{costLine(r.cost)}</p> : null}
                    {plain ? null : picture(r)}
                  </>
                ) : (
                  status(r)
                )}
              </div>
            </li>
          ))}
        </ul>
      </>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-3 px-3 py-3">
      <p className="m-0 text-sm text-fg-muted">{helper}</p>
      {costShown && !narrow && !plain ? <div className="min-w-0 overflow-x-auto">{body}</div> : body}
      {ticks && ticked.length ? (
        <section aria-label="Selection" className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 rounded-panel border border-hairline bg-surface-raised p-3 shadow-sheet">
          <span className="text-sm">
            {ticked.length >= fit ? `${cap(word(ticked.length))} picked, the most that fit side by side at this width.` : `${cap(word(ticked.length))} picked. You can pick up to ${word(fit)}.`}
          </span>
          <span className="flex-1" />
          <Button variant="ghost" size="sm" className="pointer-coarse:min-h-[44px]" onClick={onClear}>
            Clear
          </Button>
          <Button size="sm" className="pointer-coarse:min-h-[44px]" disabled={ticked.length < 2} onClick={(e) => onRead(e.currentTarget)}>
            {ticked.length < 2 ? "Read side by side" : `Read ${word(ticked.length)} side by side`}
          </Button>
        </section>
      ) : null}
    </div>
  )
}
