import type { GoldQuestionCheck, QuestionSetAcross, QuestionSetUpload, SampleCard, SampleQuestion, StoredQuestionSet } from "@/api/types"

/**
 * Your own gold set (plan I-30, I-31, I-33), kept pure so the arithmetic and
 * the wording are testable without a browser.
 *
 * A set is stored against the document's fingerprint, so "does this set belong
 * to the document on Build?" is a comparison of two shas. Each bundled sample
 * carries its own question set and belongs only to its own document, which is
 * the case this whole phase exists for: uploading a PDF and pressing Evaluate
 * used to score the wrong sample's questions against it.
 */

/** One question, however it reached the page. */
export interface Question {
  id: string
  question: string
  gold_answers: string[]
  tags: string[]
  /** The expected answer in words: shown beside the evidence, never scored. Empty when none was given. */
  answer: string
  /**
   * The document its evidence is in. With one document, by filename (the
   * question's own, else the set's) and never sent. With several, its sha,
   * empty when it names none: Evaluate sends it, so a named question is found
   * only in its own document and an unnamed one in any.
   */
  document?: string
}

/**
 * Every question gets an id of its own, since the last run is compared row by
 * row through it: a missing id becomes `q` and its place, and a repeated one
 * gets the first free number after it (`same-2`, `same-3`).
 */
export function uniqueIds(questions: Question[]): Question[] {
  const taken = new Set(questions.map((q) => q.id).filter(Boolean))
  const seen = new Set<string>()
  return questions.map((q, i) => {
    let id = q.id || `q${i + 1}`
    if (seen.has(id)) {
      let n = 2
      while (taken.has(`${id}-${n}`) || seen.has(`${id}-${n}`)) n++
      id = `${id}-${n}`
    }
    seen.add(id)
    return { ...q, id }
  })
}

export function questionsFromSample(sample: readonly SampleQuestion[]): Question[] {
  return uniqueIds(
    sample.map((q) => ({
      id: q.id,
      question: q.question,
      gold_answers: [q.gold_answer, ...(q.gold_answers ?? [])],
      tags: q.tags ?? [],
      answer: q.answer ?? "",
    })),
  )
}

export function questionsFromSet(stored: StoredQuestionSet): Question[] {
  return uniqueIds(
    (stored.set?.questions ?? []).map((q) => ({
      id: q.id,
      question: q.question,
      gold_answers: q.gold_answers ?? [],
      tags: q.tags ?? [],
      answer: q.answer ?? "",
      document: q.document || stored.set?.document || "",
    })),
  )
}

// ------------------------------------------------ one set, several documents --

/** The set kept against several documents (`GET /api/v2/questions`): each question's document is a sha, or empty. */
export function questionsFromAcross(set: QuestionSetAcross): Question[] {
  return uniqueIds(
    set.questions.map((q) => ({
      id: q.id,
      question: q.question,
      gold_answers: q.gold_answers ?? [],
      tags: q.tags ?? [],
      answer: q.answer ?? "",
      document: q.document ?? "",
    })),
  )
}

/** The bundled samples' own sets, for a pipeline with several documents: each question names its sample. */
export function questionsFromSamples(sets: readonly { sha: string; questions: readonly SampleQuestion[] }[]): Question[] {
  return uniqueIds(sets.flatMap(({ sha, questions }) => questionsFromSample(questions).map((q) => ({ ...q, document: sha }))))
}

/** An upload's check rows as questions, for a set the server would not keep: the rows carry no answer or tags. */
export function questionsFromChecks(rows: readonly GoldQuestionCheck[]): Question[] {
  return uniqueIds(
    rows.map((r) => ({
      id: r.id,
      question: r.question,
      gold_answers: (r.golds ?? []).map((g) => g.gold),
      tags: [],
      answer: "",
      document: r.document ?? "",
    })),
  )
}

/** How many questions name each of these documents (by sha), and how many name none. */
export function documentCounts(
  questions: readonly Pick<Question, "document">[],
  shas: readonly string[],
): { byDocument: Record<string, number>; unnamed: number } {
  const byDocument: Record<string, number> = Object.fromEntries(shas.map((s) => [s, 0]))
  let unnamed = 0
  for (const q of questions) {
    if (!q.document) unnamed += 1
    else if (q.document in byDocument) byDocument[q.document] += 1
  }
  return { byDocument, unnamed }
}

/** The set in one line: `24 questions from golden-set.csv, covering all 3 documents`. */
export function acrossLine(count: number, filenames: readonly string[], named: number, documents: number): string {
  const n = `${count} ${count === 1 ? "question" : "questions"}`
  // A joined name is believed only when its count fits the set: a file of the user's own can look like one, and removing a document drops questions.
  const read = filenames.length === 1 ? readJoinedName(filenames[0]) : null
  const joined = read && (read.source ? read.written > 0 && read.written < count : read.written === count) ? read : null
  const from = joined
    ? joined.source
      ? `: ${count - joined.written} from ${joined.source} and ${joined.written} written by ${joined.writer}`
      : ` written by ${joined.writer}`
    : filenames.length ? ` from ${filenames.length > 1 ? `${filenames.slice(0, -1).join(", ")} and ${filenames[filenames.length - 1]}` : filenames[0]}` : ""
  const covering =
    named === 0
      ? `found in any of the ${documents} documents`
      : named === documents
        ? `covering all ${documents} documents`
        : `covering ${named} of ${documents} documents`
  return `${n}${from}, ${covering}`
}

/** Where a set with questions written for you came from: the rest's source (a file, or "the samples"), how many were written, and by which model. */
export interface JoinedName {
  source: string | null
  written: number
  writer: string
}

const JOINED = /^(?:(.*) \+ )?(\d+) written by (.+)\.json$/
const SEVERAL_MODELS = "more than one model"

/**
 * The file name a set saved by Write questions for me goes up under, so the
 * card can say it after a reload: `golden-set.csv + 6 written by Claude Haiku 4.5.json`.
 * `before` is that name read back when the set was already one: its source is
 * kept and the counts add up, so writing again never makes the name grow.
 */
export function joinedName(before: JoinedName | null, filenames: readonly string[], written: number, writer: string): string {
  const source = before ? before.source : filenames.length ? filenames.join(" and ") : null
  const total = (before?.written ?? 0) + written
  const by = before && before.writer !== writer ? SEVERAL_MODELS : writer
  return `${source ? `${source} + ` : ""}${total} written by ${by}.json`
}

export function readJoinedName(filename: string): JoinedName | null {
  const m = JOINED.exec(filename)
  return m ? { source: m[1] ?? null, written: Number(m[2]), writer: m[3] } : null
}

const TAB_ACROSS_KEY = "rag-playground:gold-set:across"

/** A set for several documents the server would not keep, kept in this tab for exactly these documents. */
export function readTabAcross(shas: readonly string[]): { filename: string; questions: Question[] } | null {
  try {
    const s = JSON.parse(window.sessionStorage.getItem(TAB_ACROSS_KEY) ?? "null") as { shas?: unknown; filename?: unknown; questions?: unknown } | null
    const ok = Array.isArray(s?.shas) && s.shas.join(",") === shas.join(",") && typeof s.filename === "string" && Array.isArray(s.questions)
    return ok ? { filename: s.filename as string, questions: s.questions as Question[] } : null
  } catch {
    // Blocked storage, or something else wrote the key: there is no set.
    return null
  }
}

export function storeTabAcross(shas: readonly string[], filename: string, questions: readonly Question[]): void {
  try {
    window.sessionStorage.setItem(TAB_ACROSS_KEY, JSON.stringify({ shas, filename, questions }))
  } catch {
    // Private window or blocked storage: the set lasts for the page instead.
  }
}

// ------------------------------------------------- which set, whose document --

/** The bundled sample whose fingerprint matches the loaded document, if any. */
export function sampleFor(sourceSha: string, samples: SampleCard[] | null): SampleCard | undefined {
  return samples?.find((s) => s.sha === sourceSha)
}

/** `belongs` is null while the list of bundled samples has not arrived yet. */
export type InUse = { kind: "sample"; belongs: boolean | null } | { kind: "uploaded"; belongs: boolean }

export function inUse(sourceSha: string, samples: SampleCard[] | null, set: StoredQuestionSet | null): InUse {
  if (set) return { kind: "uploaded", belongs: set.sha === sourceSha }
  return { kind: "sample", belongs: samples === null ? null : sampleFor(sourceSha, samples) !== undefined }
}

/** The warning, and the one action that fixes it. */
export interface Mismatch {
  text: string
  fix: "upload" | "remove"
}

/**
 * The caller (`QuestionSetPanel`) only ever asks this about an uploaded set:
 * the "no bundled sample matches this document" case has its own plain
 * sentence elsewhere on the page, without alarm, so it is not a mismatch.
 */
export function mismatch(u: InUse, filename: string): Mismatch | null {
  if (u.belongs !== false) return null
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

/** What an upload's check says, for one document's set or one set across several. */
type Checked = Pick<QuestionSetUpload, "questions" | "parser" | "parser_note" | "filename" | "count">

function checks(upload: Checked): GoldQuestionCheck[] {
  return Array.isArray(upload.questions) ? upload.questions : []
}

export function report(upload: Checked): Report {
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
