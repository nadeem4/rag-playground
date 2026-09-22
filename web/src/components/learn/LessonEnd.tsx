import { Button } from "@/components/ui/button"
import { markDone, nextLesson, type Lesson } from "@/state/lessons"

/**
 * The end of every lesson: "Mark as done" records it and goes back to the
 * lessons; the second link opens the next lesson, or goes back after the last.
 */
export function LessonEnd({ slug }: { slug: Lesson["slug"] }) {
  const next = nextLesson(slug)
  return (
    <div className="flex flex-wrap gap-3">
      <Button asChild>
        <a href="/" onClick={() => markDone(slug)}>
          Mark as done
        </a>
      </Button>
      <Button asChild variant="outline">
        {next ? <a href={next.href}>Next: {next.title}</a> : <a href="/">Back to lessons</a>}
      </Button>
    </div>
  )
}
