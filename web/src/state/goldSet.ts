import type { GoldQuestionCheck, QuestionSetUpload, SampleQuestion, StoredQuestionSet } from "@/api/types"

/**
 * Your own gold set (plan I-30, I-31, I-33), kept pure so the arithmetic and
 * the wording are testable without a browser.
 *
 * A set is stored against the document's fingerprint, so "does this set belong
 * to the document on Build?" is a comparison of two shas. The built-in sample
 * set belongs to the bundled sample document and to nothing else, which is the
 * case this whole phase exists for: uploading a PDF and pressing Evaluate used
 * to score the sample's questions against it.
 */

/** One question, however it reached the page. */
export interface Question {
  id: string
  question: string
  gold_answers: string[]
  tags: string[]
}

export function questionsFromSample(sample: readonly SampleQuestion[]): Question[] {
  return sample.map((q) => ({ id: q.id, question: q.question, gold_answers: [q.gold_answer], tags: [] }))
}

export function questionsFromSet(stored: StoredQuestionSet): Question[] {
  return (stored.set?.questions ?? []).map((q, i) => ({
    id: q.id || `q${i + 1}`,
    question: q.question,
    gold_answers: q.gold_answers ?? [],
    tags: q.tags ?? [],
  }))
}

// ------------------------------------------------- which set, whose document --

/** `belongs` is null while the sample document's fingerprint is still unknown. */
export type InUse = { kind: "sample"; belongs: boolean | null } | { kind: "uploaded"; belongs: boolean }

export function inUse(sourceSha: string, sampleSha: string | null, set: StoredQuestionSet | null): InUse {
  if (set) return { kind: "uploaded", belongs: set.sha === sourceSha }
  return { kind: "sample", belongs: sampleSha === null ? null : sampleSha === sourceSha }
}

/** The warning, and the one action that fixes it. */
export interface Mismatch {
  text: string
  fix: "upload" | "remove"
}

export function mismatch(u: InUse, filename: string): Mismatch | null {
  if (u.belongs !== false) return null
  if (u.kind === "sample") {
    return {
      text: `These questions were written for the sample document, not for ${filename}. Scoring them against it measures nothing. Upload a question set written for this document.`,
      fix: "upload",
    }
  }
  return {
    text: `This question set was uploaded for a different document, so it does not describe ${filename}. Remove it, or upload a set written for this document.`,
    fix: "remove",
  }
}

// ------------------------------------------------------------- the report --

/** One gold passage that is not in the document, with the closest text there is. */
export interface Problem {
  question: string
  gold_answer: string
  closest: string | null
}

export interface Report {
  /** The file the questions were read from. */
  filename: string
  /** Questions read from the file. */
  read: number
  /** Gold passages checked. */
  passages: number
  /** Passages that matched only after normalising. */
  normalized: number
  problems: Problem[]
  /** What the server says about the parser it checked with. */
  note: string
}

function checks(upload: QuestionSetUpload): GoldQuestionCheck[] {
  return Array.isArray(upload.questions) ? upload.questions : []
}

export function report(upload: QuestionSetUpload): Report {
  const problems: Problem[] = []
  let passages = 0
  let normalized = 0
  for (const c of checks(upload)) {
    for (const g of c.golds ?? []) {
      passages += 1
      if (g.status === "found_normalized") normalized += 1
      if (g.status === "not_found") problems.push({ question: c.question, gold_answer: g.gold, closest: g.closest || null })
    }
  }
  const note = upload.parser_note || `The check read the document with ${upload.parser}. A different parser can change the text.`
  return { filename: upload.filename, read: upload.count, passages, normalized, problems, note }
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** What the upload found, as sentences. The parser is named because it changes the text. */
export function reportLines(r: Report): string[] {
  const lines = [`Read ${count(r.read, "question", "questions")} from ${r.filename}.`]
  lines.push(
    r.problems.length === 0
      ? `All ${r.passages} gold passages are in the document.`
      : `${r.problems.length} of ${r.passages} gold passages ${r.problems.length === 1 ? "was" : "were"} not found in the document.`,
  )
  if (r.normalized > 0) {
    lines.push(
      `${r.normalized} of them matched only after whitespace, quotes and line-end hyphens were normalised, so the file and the document word ${r.normalized === 1 ? "it" : "them"} differently.`,
    )
  }
  lines.push(r.note)
  return lines
}

// ------------------------------------------------------- the browser's copy --

const TAB_KEY = "rag-playground:gold-set"

/**
 * A set the server would not keep lives in this tab and nowhere else. Session
 * storage is per tab and goes when the tab closes, so a hosted demo never
 * carries one person's questions to the next visitor.
 */
export function readTabSet(sourceSha: string): StoredQuestionSet | null {
  try {
    const raw = window.sessionStorage.getItem(TAB_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as StoredQuestionSet
    const ok = typeof s?.sha === "string" && Array.isArray(s?.set?.questions) && s.sha === sourceSha
    return ok ? s : null
  } catch {
    // Blocked storage, or something else wrote the key: there is no set.
    return null
  }
}

export function storeTabSet(set: StoredQuestionSet): void {
  try {
    window.sessionStorage.setItem(TAB_KEY, JSON.stringify(set))
  } catch {
    // Private window or blocked storage: the set lasts for the page instead.
  }
}

export function clearTabSet(): void {
  try {
    window.sessionStorage.removeItem(TAB_KEY)
  } catch {
    // Nothing to clear if it could never be written.
  }
}
