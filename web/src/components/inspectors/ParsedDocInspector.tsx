import { Fragment, useState, type ReactNode } from "react"

import type { ParsedDoc } from "@/api/types"
import { EmptyState } from "@/components/EmptyState"
import { cn } from "@/lib/utils"

import { byOrder, ElementText, OrderGutter, PageBreak } from "./elements"
import { fmt, Frame, statusScreen, type InspectorStatus } from "./status"

/**
 * A parsed document two ways: as readable blocks, and as a hairline element
 * table. The table is where two parsers will later disagree about reading
 * order, so `order` is the first and heaviest column.
 */

export interface ParsedDocInspectorProps {
  doc?: ParsedDoc
  status?: InspectorStatus
}

type View = "blocks" | "table"

export function ParsedDocInspector({ doc, status }: ParsedDocInspectorProps) {
  const [view, setView] = useState<View>("blocks")
  const screen = statusScreen(status, "parsed document")
  if (screen) return <Frame><div className="bg-surface">{screen}</div></Frame>
  if (!doc) {
    return (
      <Frame>
        <div className="bg-surface">
          <EmptyState title="No parsed document yet">Run the Parse stage to extract elements from the source file.</EmptyState>
        </div>
      </Frame>
    )
  }
  const elements = byOrder(doc.elements)
  return (
    <Frame>
      <DocHeader doc={doc}>
        <ViewToggle value={view} onChange={setView} />
      </DocHeader>
      <div className="max-h-[560px] overflow-y-auto bg-surface">
        {elements.length === 0 ? (
          <EmptyState title="No elements">The parser returned no elements for this file. A scanned PDF without OCR is the usual cause.</EmptyState>
        ) : view === "blocks" ? (
          <div className="flex flex-col gap-2 p-3">
            {elements.map((el, k) => (
              <Fragment key={el.id}>
                {k === 0 || el.page !== elements[k - 1].page ? <PageBreak page={el.page} /> : null}
                <div data-element={el.id} className="grid grid-cols-[48px_minmax(0,82ch)] gap-3">
                  <OrderGutter el={el} />
                  <ElementText el={el} />
                </div>
              </Fragment>
            ))}
          </div>
        ) : (
          <ElementTable doc={doc} />
        )}
      </div>
    </Frame>
  )
}

export function DocHeader({ doc, children }: { doc: ParsedDoc; children?: ReactNode }) {
  const parser = typeof doc.parser_meta.parser === "string" ? doc.parser_meta.parser : null
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 bg-surface-elevated px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-sm font-medium">{doc.filename || doc.source_id || "Untitled"}</span>
        <span className="flex items-baseline gap-1">
          <span className="font-mono text-sm tabular-nums">{fmt(doc.elements.length)}</span>
          <span className="text-xs text-fg-muted">elements</span>
        </span>
        <span className="flex items-baseline gap-1">
          <span className="font-mono text-sm tabular-nums">{fmt(doc.page_count)}</span>
          <span className="text-xs text-fg-muted">pages</span>
        </span>
        {parser ? <span className="font-mono text-xs text-fg-muted">{parser}</span> : null}
      </div>
      {children}
    </div>
  )
}

function ViewToggle({ value, onChange }: { value: View; onChange: (v: View) => void }) {
  const options: [View, string][] = [
    ["blocks", "Blocks"],
    ["table", "Table"],
  ]
  return (
    <div role="radiogroup" aria-label="View" className="grid grid-cols-2 gap-px overflow-hidden rounded-control border border-hairline bg-hairline">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn("h-row-compact px-2 text-xs", value === v ? "bg-selection text-fg" : "bg-surface text-fg-muted hover:bg-muted")}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

const COLS = "56px 72px 96px 48px 48px minmax(240px,1fr)"

function ElementTable({ doc }: { doc: ParsedDoc }) {
  const head = ["order", "id", "type", "page", "level", "text"]
  return (
    <div role="table" aria-label="Elements" className="grid min-w-max gap-px bg-hairline md:min-w-0" style={{ gridTemplateColumns: COLS }}>
      <div role="row" className="contents">
        {head.map((h) => (
          <div key={h} role="columnheader" className="meta sticky top-0 flex h-row-compact items-center bg-surface-elevated px-2">
            {h}
          </div>
        ))}
      </div>
      {byOrder(doc.elements).map((el) => (
        <div key={el.id} role="row" data-row="" className="contents">
          <Td col="order" className="font-mono text-sm font-semibold text-fg tabular-nums">{el.order}</Td>
          <Td col="id" className="font-mono text-xs text-fg-muted">{el.id}</Td>
          <Td col="type" className="font-mono text-xs">{el.type}</Td>
          <Td col="page" className="font-mono text-xs tabular-nums">{el.page ?? ""}</Td>
          <Td col="level" className="font-mono text-xs tabular-nums">{el.level ?? ""}</Td>
          <Td col="text" className="truncate text-sm text-fg-muted">{el.text}</Td>
        </div>
      ))}
    </div>
  )
}

function Td({ col, className, children }: { col: string; className?: string; children: ReactNode }) {
  return (
    <div role="cell" data-col={col} className={cn("flex h-row min-w-0 items-center bg-surface px-2", className)}>
      {col === "text" ? <span className="truncate">{children}</span> : children}
    </div>
  )
}
