import { EmptyState } from "@/components/EmptyState"

import { Frame, statusScreen, type InspectorStatus } from "./status"

/**
 * The escape hatch: any artifact type without a dedicated inspector renders
 * as a collapsible JSON tree. Same role as the form renderer's JSON fallback.
 */

const MAX_ITEMS = 200 // children shown per node before "N more"

export interface JsonTreeInspectorProps {
  data?: unknown
  status?: InspectorStatus
  label?: string
}

export function JsonTreeInspector({ data, status, label = "artifact" }: JsonTreeInspectorProps) {
  const screen = statusScreen(status, label)
  return (
    <Frame>
      <div className="max-h-[560px] overflow-auto bg-surface">
        {screen ??
          (data === undefined ? (
            <EmptyState title="No data">This artifact has not been produced yet.</EmptyState>
          ) : (
            <div className="p-3 font-mono text-xs">
              <Node value={data} depth={0} />
            </div>
          ))}
      </div>
    </Frame>
  )
}

function Scalar({ value }: { value: unknown }) {
  if (typeof value === "string") return <span className="break-all whitespace-pre-wrap text-fg">{JSON.stringify(value)}</span>
  if (value === null) return <span className="text-fg-muted">null</span>
  return <span className="text-fg">{String(value)}</span>
}

function Node({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const key = name === undefined ? null : <span className="text-fg-muted">{name}</span>
  if (value === null || typeof value !== "object") {
    return (
      <div className="flex min-w-0 gap-2 py-px">
        {key}
        <Scalar value={value} />
      </div>
    )
  }
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>)
  const shape = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`
  return (
    <details open={depth < 2} className="py-px">
      <summary className="cursor-pointer rounded-control select-none">
        {key} <span className="text-fg-muted">{shape}</span>
      </summary>
      <div className="ml-2 border-l border-hairline pl-3">
        {entries.slice(0, MAX_ITEMS).map(([k, v]) => (
          <Node key={k} name={k} value={v} depth={depth + 1} />
        ))}
        {entries.length > MAX_ITEMS ? <div className="text-fg-muted">{entries.length - MAX_ITEMS} more</div> : null}
      </div>
    </details>
  )
}
