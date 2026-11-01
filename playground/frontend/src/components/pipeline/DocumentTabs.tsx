import { useRef, type KeyboardEvent } from "react"

import type { NodeStatus } from "@/api/runState"
import { FileDot } from "@/components/FileTag"
import type { FileInfo } from "@/lib/files"
import { cn } from "@/lib/utils"

/**
 * One tab per document, on the Parse, Clean and Chunk panes of a pipeline with
 * several documents. Every pane shares one choice, so the cards and the panes
 * all show the same file. With fewer than two files there is nothing to pick.
 */
const STATUS_WORD: Partial<Record<NodeStatus, string>> = { done: "done", cached: "done", running: "running", failed: "failed", skipped: "skipped", pending: "waiting" }
/** The status dot's look, the same as the step cards' ring. */
const DOT: Record<string, string> = {
  pending: "border-fg-muted",
  skipped: "border-fg-muted bg-fg-muted/30",
  running: "border-primary bg-[linear-gradient(90deg,var(--accent)_50%,transparent_50%)]",
  done: "border-primary bg-primary",
  cached: "border-primary bg-primary",
  failed: "border-danger bg-danger",
}

/** The id of a tab, so the pane it controls can name it as its label. */
export const tabIdOf = (panelId: string, sha: string) => `${panelId}-tab-${sha}`

export function DocumentTabs({
  files,
  value,
  onChange,
  note,
  panelId,
  status,
}: {
  files: readonly FileInfo[]
  value: string
  onChange: (sha: string) => void
  /** A short line beside a tab, or null for none. */
  note?: (sha: string) => string | null
  /** The id of the tabpanel these tabs control. */
  panelId?: string
  /** Each document's run state, for a dot on its tab. */
  status?: (sha: string) => NodeStatus | undefined
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  if (files.length < 2) return null

  const move = (e: KeyboardEvent, i: number) => {
    const to =
      e.key === "ArrowRight" ? (i + 1) % files.length
      : e.key === "ArrowLeft" ? (i - 1 + files.length) % files.length
      : e.key === "Home" ? 0
      : e.key === "End" ? files.length - 1
      : -1
    if (to < 0) return
    e.preventDefault()
    const next = files[to]
    onChange(next.sha)
    refs.current[next.sha]?.focus()
  }

  return (
    <div role="tablist" aria-label="Document" data-testid="document-tabs" className="flex flex-wrap gap-1 border-b border-hairline pb-2">
      {files.map((f, i) => {
        const on = f.sha === value
        const line = note?.(f.sha)
        const st = status?.(f.sha)
        return (
          <button
            key={f.sha}
            ref={(el) => {
              refs.current[f.sha] = el
            }}
            type="button"
            role="tab"
            id={panelId ? tabIdOf(panelId, f.sha) : undefined}
            aria-controls={panelId}
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            title={st ? `${f.filename}: ${STATUS_WORD[st] ?? st}` : f.filename}
            onClick={() => onChange(f.sha)}
            onKeyDown={(e) => move(e, i)}
            className={cn(
              "inline-flex min-h-[32px] max-w-full min-w-0 items-center gap-2 rounded-control border px-2 text-sm focus-visible:outline-2 focus-visible:outline-(--focus-ring)",
              on ? "border-primary bg-surface-raised text-fg" : "border-hairline bg-surface text-fg-muted hover:border-field-border",
            )}
          >
            <FileDot slot={f.slot} />
            {st ? <span aria-hidden data-testid="tab-status" data-status={st} className={cn("size-[7px] shrink-0 rounded-full border", DOT[st] ?? DOT.pending)} /> : null}
            <span className="truncate">{f.filename}</span>
            {st ? <span className="sr-only">, {STATUS_WORD[st] ?? st}</span> : null}
            {line ? <span className="text-xs text-fg-muted">{line}</span> : null}
          </button>
        )
      })}
    </div>
  )
}
