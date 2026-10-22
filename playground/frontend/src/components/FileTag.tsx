import type { CSSProperties } from "react"

import type { FileInfo } from "@/lib/files"
import { cn } from "@/lib/utils"

/** A file's colour dot, alone: for a pill or a row that names the file beside it. */
export function FileDot({ slot }: { slot: number }) {
  return <span aria-hidden data-file-dot="" className="size-[7px] shrink-0 rounded-[2px]" style={{ background: `var(--file-${slot})` } as CSSProperties} />
}

/**
 * Which file something came from, when a pipeline has several: the file's
 * colour dot and its name (spec "File colours"). Shared by Ask, Evaluate and
 * Compare.
 */
export function FileTag({ file, className }: { file: Pick<FileInfo, "filename" | "slot">; className?: string }) {
  return (
    <span
      data-file-tag=""
      title={file.filename}
      className={cn("inline-flex max-w-full min-w-0 items-center gap-1 rounded-[4px] bg-surface-elevated px-2 align-baseline font-mono text-2xs text-fg", className)}
    >
      <FileDot slot={file.slot} />
      <span className="truncate">{file.filename}</span>
    </span>
  )
}
