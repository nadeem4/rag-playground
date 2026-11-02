/**
 * Which index collection a result searched: a short form of its name
 * (`<recipe>-<index id>`), the whole name in the title. Nothing without a name,
 * as for a run that did not reach its index or an older server.
 */
export function IndexTag({ name }: { name?: string | null }) {
  if (!name) return null
  const short = name
    .split("-")
    .map((part) => part.slice(0, 6))
    .join("-")
  return (
    <span data-testid="index-tag" title={`Searched index ${name}`} className="font-mono text-xs text-fg-muted">
      Index {short}
    </span>
  )
}
