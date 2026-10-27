/**
 * Build's results for this browser tab. Every page is its own load, so leaving
 * Build for Read or Compare used to drop the built steps, the last answer and
 * the questions asked. They are kept in sessionStorage: this tab only, gone
 * when it closes. Each result keeps the signature it was run with, so one whose
 * settings changed meanwhile comes back marked out of date, not shown as fresh.
 */
import { ApiError } from "@/api/client"
import { v2 } from "@/api/v2"
import type { AskSnapshot, TranscriptEntry } from "@/components/ask/Transcript"

import type { Found } from "./guideResult"
import type { Tracked } from "./pipeline"

export const BUILD_SESSION_KEY = "rag-playground:build-session:v2"

/** Where the guided run's Ask step found the answer, for the retrieval result it was read from. */
export interface GuideAsk {
  artifact: string
  found: Found
  /** How many pieces the answer step reads, and how many Search returned. */
  shown: number
  candidates: number
}

export interface BuildSession {
  tracked: Tracked
  /** Each result's signature when it ran. */
  sigs: Record<string, string>
  /** The questions asked in this tab, newest first. */
  transcript: TranscriptEntry[]
  asked: AskSnapshot | null
  comparisonHidden: string | null
  /** The guided run's Ask step result; the Fix step reads it as the rank before the fix. */
  guideAsk?: GuideAsk | null
  /** The Fix step's "Ask again" result, kept apart so the Ask step's rank stays as it was. */
  guideAfter?: GuideAsk | null
}

function readGuideAsk(v: unknown): GuideAsk | null {
  if (!isRecord(v) || typeof v.artifact !== "string" || typeof v.shown !== "number" || typeof v.candidates !== "number") return null
  if (v.found === null) return { artifact: v.artifact, found: null, shown: v.shown, candidates: v.candidates }
  if (!isRecord(v.found) || typeof v.found.rank !== "number") return null
  return { artifact: v.artifact, found: { rank: v.found.rank }, shown: v.shown, candidates: v.candidates }
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
    guideAsk: readGuideAsk(v.guideAsk),
    guideAfter: readGuideAsk(v.guideAfter),
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
export async function goneResults(results: Tracked["results"], check: (id: string) => Promise<unknown> = v2.result): Promise<string[]> {
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
