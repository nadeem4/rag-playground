/**
 * Build's results for this browser tab. Every page is its own load, so leaving
 * Build for Read or Compare used to drop the built steps, the last answer and
 * the questions asked. They are kept in sessionStorage: this tab only, gone
 * when it closes. Each result keeps the signature it was run with, so one whose
 * settings changed meanwhile comes back marked out of date, not shown as fresh.
 */
import { api, ApiError } from "@/api/client"
import type { AskSnapshot, TranscriptEntry } from "@/components/ask/Transcript"

import type { Tracked } from "./pipeline"

export const BUILD_SESSION_KEY = "rag-playground:build-session:v1"

export interface BuildSession {
  tracked: Tracked
  /** Each result's signature when it ran. */
  sigs: Record<string, string>
  /** The questions asked in this tab, newest first. */
  transcript: TranscriptEntry[]
  asked: AskSnapshot | null
  comparisonHidden: string | null
}

/** Only a finished step comes back; one left running or waiting belongs to a run that is gone. */
const FINISHED = new Set(["done", "cached", "failed"])

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

export function readBuildSession(): BuildSession | null {
  let raw: string | null
  try {
    raw = window.sessionStorage.getItem(BUILD_SESSION_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(v) || !isRecord(v.tracked) || !isRecord(v.tracked.results) || !isRecord(v.sigs) || !Array.isArray(v.transcript)) return null
  const results = Object.fromEntries(
    Object.entries(v.tracked.results).filter(([, s]) => isRecord(s) && typeof s.status === "string" && FINISHED.has(s.status)),
  ) as Tracked["results"]
  const sigs = Object.fromEntries(Object.entries(v.sigs).filter(([id, s]) => id in results && typeof s === "string")) as Record<string, string>
  return {
    tracked: { results, history: (isRecord(v.tracked.history) ? v.tracked.history : {}) as Tracked["history"] },
    sigs,
    transcript: v.transcript as TranscriptEntry[],
    asked: isRecord(v.asked) ? (v.asked as unknown as AskSnapshot) : null,
    comparisonHidden: typeof v.comparisonHidden === "string" ? v.comparisonHidden : null,
  }
}

export function writeBuildSession(session: BuildSession): void {
  try {
    window.sessionStorage.setItem(BUILD_SESSION_KEY, JSON.stringify(session))
  } catch {
    // A browser that refuses storage just starts Build fresh next time.
  }
}

/**
 * The steps whose saved result the server no longer has: it answers 404, as
 * after a restart wipes its store. Those are dropped, so Build shows them as not
 * run rather than as done with nothing behind them. A network failure proves
 * nothing, so it keeps the step.
 */
export async function goneResults(results: Tracked["results"], check: (id: string) => Promise<unknown> = api.artifact): Promise<string[]> {
  const withResult = Object.values(results).filter((s) => typeof s.artifact_id === "string")
  const gone = await Promise.all(
    withResult.map((s) =>
      check(s.artifact_id!).then(
        () => false,
        (e: unknown) => e instanceof ApiError && e.status === 404,
      ),
    ),
  )
  return withResult.filter((_, i) => gone[i]).map((s) => s.id)
}
