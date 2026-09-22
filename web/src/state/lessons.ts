import { useSyncExternalStore } from "react"

/**
 * The lessons, in order, and which ones this viewer has finished. Progress is
 * kept in per-viewer storage under `rag-lessons`; when storage is blocked it
 * lasts for this page only.
 */

export interface Lesson {
  slug: "end-to-end" | "chunking" | "citations"
  href: string
  title: string
  /** One sentence: what you do in the lesson. */
  what: string
  /** The pipeline steps the lesson covers. */
  steps: string[]
  /** How long it is, in its own units. */
  size: string
}

export const LESSONS: Lesson[] = [
  {
    slug: "end-to-end",
    href: "/learn/end-to-end",
    title: "How RAG works, end to end",
    what: "Follow one question from the answer back to the PDF, and see what every step of the pipeline did.",
    steps: ["Parse", "Clean", "Chunk", "Retrieve", "Rerank", "Answer"],
    size: "5 steps to scroll through",
  },
  {
    slug: "chunking",
    href: "/learn/chunking",
    title: "Chunking",
    what: "Predict whether a setting will cut the answer in half, then run the real chunker and see.",
    steps: ["Chunk"],
    size: "4 challenges",
  },
  {
    slug: "citations",
    href: "/learn/citations",
    title: "How citations work",
    what: "See how any model can point to the exact sentence it used, and how made-up claims get caught.",
    steps: ["Answer"],
    size: "6 short steps",
  },
]

export type Progress = Partial<Record<Lesson["slug"], boolean>>

const KEY = "rag-lessons"
let current: Progress | null = null
const listeners = new Set<() => void>()

export function readProgress(): Progress {
  if (current === null) {
    try {
      const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "{}")
      current = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Progress) : {}
    } catch {
      current = {}
    }
  }
  return current
}

export function markDone(slug: Lesson["slug"]): void {
  current = { ...readProgress(), [slug]: true }
  try {
    window.localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    // Private window or blocked storage: remembered in memory only.
  }
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useProgress(): Progress {
  return useSyncExternalStore(subscribe, readProgress, readProgress)
}

/** For tests: forget the in-memory value so the next read goes to storage. */
export function resetProgressForTests(): void {
  current = null
}

export function nextLesson(slug: Lesson["slug"]): Lesson | null {
  const i = LESSONS.findIndex((l) => l.slug === slug)
  return LESSONS[i + 1] ?? null
}

/** Home's main button: the first lesson not done yet. */
export function continueAction(done: Progress): { label: string; href: string } {
  const next = LESSONS.find((l) => !done[l.slug])
  if (!next) return { label: "Open the first lesson again", href: LESSONS[0].href }
  const started = LESSONS.some((l) => done[l.slug])
  return { label: started ? `Continue: ${next.title}` : "Start with the first lesson", href: next.href }
}
