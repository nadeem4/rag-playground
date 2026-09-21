import type { ReactNode } from "react"

/**
 * Every inspector has three non-result screens: loading, error, and "no
 * artifact yet" (an un-run stage). They are plain copy, never a mocked panel.
 */
export type InspectorStatus = { kind: "ready" } | { kind: "loading" } | { kind: "error"; message: string }

export function InspectorLoading({ what }: { what: string }) {
  return (
    <div role="status" aria-busy="true" className="p-4 text-sm text-fg-muted">
      Loading {what}
    </div>
  )
}

export function InspectorError({ what, message }: { what: string; message: string }) {
  return (
    <div role="alert" className="flex flex-col gap-1 p-4">
      <p className="text-sm font-medium text-danger">Could not load {what}</p>
      <p className="max-w-[82ch] font-mono text-xs whitespace-pre-wrap text-fg-muted">{message}</p>
    </div>
  )
}

/** Resolve loading / error first; returns null when the inspector should render. */
export function statusScreen(status: InspectorStatus | undefined, what: string): ReactNode | null {
  if (status?.kind === "loading") return <InspectorLoading what={what} />
  if (status?.kind === "error") return <InspectorError what={what} message={status.message} />
  return null
}

/**
 * A hairline-bordered inspector frame. The container encodes a bounded artifact.
 * `overflow-clip`, not `hidden`: it clips the corners without becoming a
 * scroll container, so a sticky child (the ranked hit list) sticks to the panel.
 */
export function Frame({ children, ...rest }: { children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className="flex min-w-0 flex-col gap-px overflow-clip rounded-panel border border-hairline bg-hairline">
      {children}
    </div>
  )
}

export const fmt = (n: number) => n.toLocaleString("en-US")
