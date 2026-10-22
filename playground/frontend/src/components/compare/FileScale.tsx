import { FileTag } from "@/components/FileTag"
import { ChunkBar } from "@/components/pipeline/NodeCard"
import type { FileInfo } from "@/lib/files"

/** One file's chunk set, for its line in the scale picture. */
export interface FileLine {
  file: FileInfo
  set: unknown
}

/**
 * A recipe's pieces with several documents: each file on its own line, named
 * by its file tag, its pieces drawn to scale by tokens in the file's colour,
 * so a chunker that suits one file and not another shows at a glance.
 */
export function FileScale({ lines }: { lines: FileLine[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {lines.map(({ file, set }) => (
        <div key={file.sha} data-testid="file-scale-line" className="flex min-w-0 items-center gap-2">
          <span className="flex w-[45%] max-w-[180px] min-w-0 shrink-0">
            <FileTag file={file} />
          </span>
          <span className="min-w-0 flex-1 overflow-hidden">
            <ChunkBar data={set} size="bar" fill={`var(--file-${file.slot})`} />
          </span>
        </div>
      ))}
    </div>
  )
}
