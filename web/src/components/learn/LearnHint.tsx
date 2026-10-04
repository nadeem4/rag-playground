import type { Lesson } from "@/api/types"

/**
 * Under a field or a strategy in a lesson page: the plugin's one-sentence hint, and
 * a "Read more" that opens its longer paragraphs (plan I-22).
 */
export function LearnHint({ lesson }: { lesson: Lesson }) {
  return (
    <div data-learn="" className="flex min-w-0 flex-col gap-1">
      <p className="m-0 text-xs text-fg-muted">{lesson.hint}</p>
      {lesson.more.length ? (
        <details className="min-w-0 text-xs" onClick={(e) => e.stopPropagation()}>
          <summary className="w-fit cursor-pointer text-fg underline decoration-fg-muted underline-offset-2 select-none">Read more</summary>
          <div className="mt-1 flex max-w-[68ch] flex-col gap-1 border-l border-hairline pl-2 text-fg-muted">
            {lesson.more.map((p) => (
              <p key={p} className="m-0">
                {p}
              </p>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  )
}

