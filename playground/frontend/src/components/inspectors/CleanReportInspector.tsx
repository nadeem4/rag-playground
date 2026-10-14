import { Fragment, useMemo, useRef, useState, type ReactNode } from "react"

import type { CleanReportEntry, CleanReportRow, ParsedDoc } from "@/api/types"
import { EmptyState } from "@/components/EmptyState"
import { cn } from "@/lib/utils"

import "./inspectors.css"
import { DocHeader } from "./ParsedDocInspector"
import { byOrder, ElementText, OrderGutter, PageBreak } from "./elements"
import { useSpineLayout } from "./spine"
import { fmt, Frame, statusScreen, type InspectorStatus } from "./status"

/**
 * What cleaning removed. The PRE-clean document is drawn as blocks; every
 * element a report lists as removed is struck through on the removed fill and
 * ticked on the position spine. Removals are matched by element `id`, never by
 * order: cleaners renumber `order`, ids survive.
 */

export interface CleanReportInspectorProps {
  /** The document as it was BEFORE the cleaners ran. */
  before?: ParsedDoc
  /** `parser_meta.clean_report` of the cleaned document, one entry per application. */
  report?: CleanReportEntry[]
  status?: InspectorStatus
}

interface Removal {
  step: number
  cleaner: string
  row: CleanReportRow
}

/** Index every removal by element id, in application order. */
export function removalsById(report: readonly CleanReportEntry[]): Map<string, Removal> {
  const out = new Map<string, Removal>()
  report.forEach((entry, step) => {
    for (const row of entry.removed) if (!out.has(row.id)) out.set(row.id, { step, cleaner: entry.cleaner, row })
  })
  return out
}

export function CleanReportInspector({ before, report, status }: CleanReportInspectorProps) {
  const screen = statusScreen(status, "clean report")
  if (screen) return <Frame><div className="bg-surface">{screen}</div></Frame>
  if (!before || !report) {
    return (
      <Frame>
        <div className="bg-surface">
          <EmptyState title="No clean report yet">Run a Clean step to see which elements it removes.</EmptyState>
        </div>
      </Frame>
    )
  }
  return <CleanReportView before={before} report={report} />
}

function CleanReportView({ before, report }: { before: ParsedDoc; report: CleanReportEntry[] }) {
  const [selected, setSelected] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const elements = useMemo(() => byOrder(before.elements), [before])
  const removals = useMemo(() => removalsById(report), [report])
  const present = useMemo(() => new Set(elements.map((e) => e.id)), [elements])
  const removedCount = report.reduce((n, e) => n + e.removed.length, 0)

  useSpineLayout(rootRef, [elements, removals])

  // A discrete click: select the element and bring it into the scroll box.
  // Scrolls only the inspector's own box, never the page.
  const select = (id: string) => {
    setSelected(id)
    const box = scrollRef.current
    const el = box?.querySelector<HTMLElement>(`[data-element=${JSON.stringify(id)}]`)
    if (!box || !el) return
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
    box.scrollTo({ top: Math.max(0, top - 48) })
  }

  return (
    <Frame>
      <DocHeader doc={before}>
        <span className="flex items-baseline gap-1">
          <span className="font-mono text-sm tabular-nums">{fmt(removedCount)}</span>
          <span className="text-xs text-fg-muted">removed by {report.length} {report.length === 1 ? "cleaner" : "cleaners"}</span>
        </span>
      </DocHeader>
      <div className="grid gap-px bg-hairline xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div ref={scrollRef} className="max-h-[560px] min-w-0 overflow-y-auto bg-surface">
          {elements.length === 0 ? (
            <EmptyState title="No elements">The document before cleaning has no elements.</EmptyState>
          ) : (
            <div ref={rootRef} className="grid grid-cols-[8px_minmax(0,1fr)] gap-3 p-3">
              <div data-spine="" aria-label="Removals on the position spine" className="relative">
                <span aria-hidden className="absolute top-0 bottom-0 left-[3px] w-px bg-hairline" />
                {elements.map((el, k) =>
                  removals.has(el.id) ? (
                    <span
                      key={el.id}
                      data-tick={el.id}
                      data-first={k}
                      data-last={k}
                      aria-hidden
                      className="absolute left-0 w-[7px] bg-removed-mark"
                    />
                  ) : null,
                )}
              </div>
              <div className="flex min-w-0 flex-col gap-2">
                {elements.map((el, k) => {
                  const removal = removals.get(el.id)
                  return (
                    <Fragment key={el.id}>
                      {k === 0 || el.page !== elements[k - 1].page ? <PageBreak page={el.page} /> : null}
                      <div
                        data-element={el.id}
                        data-target={k}
                        data-removed={removal ? "" : undefined}
                        className={cn(
                          "grid grid-cols-[48px_minmax(0,82ch)] gap-3",
                          selected === el.id && "outline-2 outline-offset-2 outline-[var(--accent)]",
                        )}
                      >
                        <OrderGutter el={el} />
                        <div className="flex min-w-0 flex-col">
                          <div className={cn(removal && "cr-removed px-1")}>
                            <ElementText el={el} />
                          </div>
                          {removal ? (
                            <span className="meta normal-case">
                              {removal.cleaner}
                              {removal.row.duplicate_of ? `, duplicate of ${removal.row.duplicate_of}` : ""}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </Fragment>
                  )
                })}
              </div>
            </div>
          )}
        </div>
        <RemovalTable report={report} present={present} selected={selected} onSelect={select} />
      </div>
    </Frame>
  )
}

// ----------------------------------------------------------------- table --

const COLS = "64px 88px 40px minmax(160px,1.2fr) minmax(160px,1.4fr) 72px"

function RemovalTable({
  report,
  present,
  selected,
  onSelect,
}: {
  report: CleanReportEntry[]
  present: Set<string>
  selected: string | null
  onSelect: (id: string) => void
}) {
  if (report.every((e) => e.removed.length === 0)) {
    return (
      <div className="bg-surface">
        <EmptyState title="Nothing removed">
          {report.length === 0 ? "No cleaner has run on this document." : "The cleaners ran and kept every element."}
        </EmptyState>
      </div>
    )
  }
  return (
    <div className="max-h-[560px] min-w-0 overflow-auto bg-surface">
      <div role="table" aria-label="Removals" className="grid min-w-[584px] gap-px bg-hairline" style={{ gridTemplateColumns: COLS }}>
        <div role="row" className="contents">
          {["id", "type", "page", "preview", "reason", "dup of"].map((h) => (
            <div key={h} role="columnheader" className="meta sticky top-0 z-[1] flex h-row-compact items-center bg-surface-elevated px-2">
              {h}
            </div>
          ))}
        </div>
        {report.map((entry, step) => (
          <Fragment key={step}>
            <div
              role="row"
              data-cleaner={entry.cleaner}
              className="col-span-full flex flex-wrap items-baseline gap-x-3 bg-surface px-2 py-1"
            >
              <span className="font-mono text-xs font-semibold">{entry.cleaner}</span>
              <span className="font-mono text-xs text-fg-muted">v{entry.version}</span>
              <span className="font-mono text-xs text-fg-muted">
                {Object.entries(entry.config)
                  .map(([k, v]) => `${k} ${String(v)}`)
                  .join("  ")}
              </span>
              <span className="ml-auto font-mono text-xs text-fg-muted tabular-nums">
                removed {entry.removed_count} kept {entry.kept_count}
                {entry.retyped.length ? ` retyped ${entry.retyped.length}` : ""}
              </span>
            </div>
            {entry.removed.map((row) => {
              const found = present.has(row.id)
              return (
                <div
                  key={row.id}
                  role="row"
                  data-removal={row.id}
                  aria-selected={selected === row.id}
                  onClick={found ? () => onSelect(row.id) : undefined}
                  className={cn("group contents", found && "cursor-pointer")}
                >
                  <Td col="id" selected={selected === row.id} className="font-mono text-xs">
                    {row.id}
                  </Td>
                  <Td col="type" selected={selected === row.id} className="font-mono text-xs">
                    {row.type}
                  </Td>
                  <Td col="page" selected={selected === row.id} className="font-mono text-xs tabular-nums">
                    {row.page ?? ""}
                  </Td>
                  <Td col="preview" selected={selected === row.id} className="text-sm">
                    {found ? <span className="cr-removed px-1">{row.preview}</span> : <span className="text-danger">not in document</span>}
                  </Td>
                  <Td col="reason" selected={selected === row.id} className="text-xs text-fg-muted">
                    {row.reason ?? ""}
                  </Td>
                  <Td col="duplicate_of" selected={selected === row.id} className="font-mono text-xs">
                    {row.duplicate_of ? (
                      <button
                        type="button"
                        className="rounded-control underline decoration-hairline underline-offset-2 hover:decoration-current"
                        onClick={(e) => {
                          e.stopPropagation()
                          onSelect(row.duplicate_of!)
                        }}
                      >
                        {row.duplicate_of}
                      </button>
                    ) : (
                      ""
                    )}
                  </Td>
                </div>
              )
            })}
          </Fragment>
        ))}
      </div>
    </div>
  )
}

function Td({ col, selected, className, children }: { col: string; selected: boolean; className?: string; children: ReactNode }) {
  return (
    <div
      role="cell"
      data-col={col}
      className={cn(
        "flex min-h-[28px] min-w-0 items-center px-2 py-1 group-hover:bg-muted",
        selected ? "bg-selection" : "bg-surface",
        className,
      )}
    >
      {children}
    </div>
  )
}
