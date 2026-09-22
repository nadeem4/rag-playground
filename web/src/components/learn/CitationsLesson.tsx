import { useState, type CSSProperties, type ReactNode } from "react"

import { useFind } from "@/api/usePdf"
import { PdfPageView } from "@/components/pdf/PdfPageView"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import "@/components/inspectors/inspectors.css"

import { LessonEnd } from "./LessonEnd"

/**
 * Learn > How citations work: one worked example, stepped through. The source
 * sentences are real sentences from the sample document, so the last visual
 * step finds them on its real page. The support scores are made up for the
 * example, and the page says so.
 */

export interface CitationsLessonProps {
  /** The sample's sha, for the page with the boxes. */
  sha: string | null
  /** "Try it yourself": open Build with the sample and a chat step. */
  onTry: () => void
}

const SOURCES = [
  {
    chunk: "Chunk 1",
    lines: [
      ["1.1", "A retriever scores each chunk as a whole."],
      ["1.2", "When a boundary falls in the middle of an explanation, the question lands on one half and the answer on the other, and neither half scores well on its own."],
    ],
  },
  {
    chunk: "Chunk 2",
    lines: [
      ["2.1", "Boundaries also decide what travels together."],
      ["2.2", "A definition separated from the term it defines, or a table separated from its caption, loses the context that made it useful."],
    ],
  },
] as const

const SENTENCE: Record<string, string> = Object.fromEntries(SOURCES.flatMap((c) => c.lines.map(([id, t]) => [id, t])))

const QUESTION = "Why do chunk boundaries matter?"
/** The chat step's default `support_threshold`. */
const PASS = 0.55

type Label = "cited" | "weak" | "similarity" | "none"
const LABEL: Record<Label, string> = { cited: "Cited", weak: "Weak support", similarity: "Similarity match", none: "Not grounded" }

const CLAIMS: { text: string; points: string; label: Label; score: number | null; id: string | null }[] = [
  { text: "If a cut splits an explanation, neither half scores well", points: "[1.2]", label: "cited", score: 0.86, id: "1.2" },
  { text: "A table can lose its caption", points: "[2.2]", label: "cited", score: 0.79, id: "2.2" },
  { text: "Smaller chunks are also cheaper", points: "[9.9], which does not exist", label: "none", score: null, id: null },
  { text: "Most teams use 500 tokens", points: "nothing", label: "none", score: 0.31, id: null },
]

const TONE = { "--tone": "var(--chunk-2)", "--tone-text": "var(--chunk-2-text)" } as CSSProperties

function Chip({ label }: { label: Label }) {
  return (
    <span className="chat-claim text-xs font-medium whitespace-nowrap" data-grounding={label} style={label === "cited" || label === "similarity" ? TONE : undefined}>
      {LABEL[label]}
    </span>
  )
}

function Marker({ id, bad }: { id: string; bad?: boolean }) {
  return (
    <span className={cn("rounded-control px-1 font-mono text-xs", bad ? "text-danger line-through" : "text-fg")} style={bad ? undefined : { background: "var(--surface-hover)" }}>
      [{id}]
    </span>
  )
}

/** The score, and a small mark against the pass line on a hairline. No filled track. */
function ScoreMark({ score }: { score: number }) {
  const above = score >= PASS
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
      <span className="font-mono text-fg">{score.toFixed(2)}</span>
      <span aria-hidden className="relative inline-block h-[12px] w-[72px] border-b border-fg-muted">
        <span className="absolute bottom-0 h-[12px] w-px bg-danger" style={{ left: `${PASS * 100}%` }} />
        <span className="absolute bottom-0 h-[8px] w-[3px] bg-fg" style={{ left: `calc(${score * 100}% - 1px)` }} />
      </span>
      <span>{above ? `above the pass line of ${PASS}` : `below the pass line of ${PASS}`}</span>
    </span>
  )
}

function Sources() {
  return (
    <div className="flex flex-col gap-3">
      {SOURCES.map((c) => (
        <div key={c.chunk} className="flex flex-col gap-1">
          <p className="m-0 text-xs font-medium text-fg-muted">{c.chunk}</p>
          {c.lines.map(([id, t]) => (
            <p key={id} className="m-0 grid grid-cols-[44px_minmax(0,1fr)] gap-2 font-mono text-sm leading-[1.7]">
              <span className="text-fg-muted">[{id}]</span>
              <span>{t}</span>
            </p>
          ))}
        </div>
      ))}
    </div>
  )
}

const PROMPT = `Answer using only the sources below. After each claim, put the number of the sentence that supports it in brackets, like [2.2].

${SOURCES.map((c) => c.lines.map(([id, t]) => `[${id}] ${t}`).join("\n")).join("\n")}

Question: ${QUESTION}`

function Answer() {
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 rounded-panel bg-surface-elevated p-3 text-sm leading-[1.8]">
        If a cut splits an explanation, neither half scores well <Marker id="1.2" />. A table can lose its caption <Marker id="2.2" />. Smaller chunks are
        also cheaper <Marker id="9.9" bad />. Most teams use 500 tokens.
      </p>
      <p className="m-0 text-sm text-fg-muted">Four claims. Two point at real sentences, one points at a sentence that does not exist, and one points at nothing.</p>
    </div>
  )
}

function Scores() {
  return (
    <div className="flex flex-col gap-2">
      <ul className="m-0 flex list-none flex-col gap-px overflow-hidden rounded-panel border border-hairline bg-hairline p-0">
        {CLAIMS.map((c) => (
          <li key={c.text} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 bg-surface p-3">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-sm">{c.text}</span>
              <span className="text-xs text-fg-muted">
                Points at <span className="font-mono">{c.points}</span>
              </span>
              {c.score !== null ? <ScoreMark score={c.score} /> : null}
            </div>
            <Chip label={c.label} />
          </li>
        ))}
      </ul>
      <p className="m-0 text-xs text-fg-muted">
        The scores in this example are made up to show the idea. A claim that points at a made-up number is never rescued. It stays not grounded.
      </p>
    </div>
  )
}

function OnThePage({ sha }: { sha: string | null }) {
  const [picked, setPicked] = useState<number | null>(null)
  const claim = picked === null ? null : CLAIMS[picked]
  const sentence = claim?.id ? SENTENCE[claim.id] : null
  const found = useFind(sha ?? "", sha && sentence ? 1 : null, sentence)
  const rects = found.kind === "ready" ? found.data.rects : []
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {CLAIMS.filter((c) => c.label === "cited" || c.score !== null).map((c) => {
          const i = CLAIMS.indexOf(c)
          return (
            <Button
              key={c.text}
              variant="outline"
              aria-pressed={picked === i}
              className={cn("h-auto min-h-[28px] py-1 text-left whitespace-normal", picked === i && "border-fg-muted bg-surface-elevated")}
              onClick={() => setPicked(i)}
            >
              {c.text}
              {c.id ? ` [${c.id}]` : ""}
            </Button>
          )
        })}
      </div>
      {claim === null ? (
        <p className="m-0 text-sm text-fg-muted">Pick a claim.</p>
      ) : !claim.id ? (
        <p className="m-0 text-sm text-fg-muted">Nothing to show. This claim is not grounded, so there is no place in the document to point at.</p>
      ) : !sha ? (
        <p className="m-0 text-sm text-fg-muted">The sample document is not loaded, so the page cannot be shown.</p>
      ) : (
        <div className="min-w-0 overflow-hidden rounded-panel border border-hairline">
          <PdfPageView
            sha={sha}
            initialPage={1}
            scale={0.75}
            highlights={rects.map((r) => ({ page: 1, rect: r }))}
            slot={2}
            title={`Sentence ${claim.id}`}
            notice={found.kind === "ready" && rects.length === 0 ? "The sentence was not found on this page." : `Page 1 of the sample, with the lines of sentence ${claim.id} boxed.`}
          />
        </div>
      )}
    </div>
  )
}

function Labels({ onTry }: { onTry: () => void }) {
  const rows: [Label, string][] = [
    ["cited", "The model named a sentence, and that sentence supports the claim."],
    ["weak", "The model named a sentence, but it does not seem to support the claim. Read it yourself to decide."],
    ["similarity", "The model named no sentence, but we found one that clearly says the same thing."],
    ["none", "Nothing in the document supports the claim. The model may have made it up, or used knowledge from outside your document."],
  ]
  return (
    <div className="flex flex-col gap-4">
      <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-[140px_minmax(0,1fr)]">
        {rows.map(([l, t]) => (
          <div key={l} className="contents">
            <dt>
              <Chip label={l} />
            </dt>
            <dd className="m-0 text-sm">{t}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={onTry}>Try it yourself</Button>
        <span className="text-sm text-fg-muted">Opens Build with the sample and a chat step ready to run.</span>
      </div>
    </div>
  )
}

interface Step {
  title: string
  words: string[]
  visual: (p: CitationsLessonProps) => ReactNode
}

const STEPS: Step[] = [
  {
    title: "We number every sentence",
    words: [
      `The search found two chunks for the question "${QUESTION}".`,
      "We split each chunk into sentences and give each one a number. The number 2.2 means the second sentence of chunk 2.",
    ],
    visual: () => <Sources />,
  },
  {
    title: "We ask the model to cite numbers",
    words: [
      "We send the numbered sentences and the question to the model, with one rule.",
      "The model never has to copy a sentence. It only has to write a short number, which even small local models can do reliably.",
    ],
    visual: () => <pre className="m-0 rounded-panel bg-surface-elevated p-3 font-mono text-xs leading-[1.65] whitespace-pre-wrap">{PROMPT}</pre>,
  },
  {
    title: "We read the numbers in the answer",
    words: [
      "The model answers and writes a number after each claim.",
      "We look up every number. A number that does not exist, like 9.9 here, is thrown away and counted, because the model made it up.",
    ],
    visual: () => <Answer />,
  },
  {
    title: "We check that each sentence supports its claim",
    words: [
      "A number alone is not proof. We compare the meaning of each claim with the meaning of the sentence it points at, and get a score between 0 and 1.",
      "If the score is above the pass line, the claim is cited. If it is not, the citation is marked weak, and you should read it yourself.",
    ],
    visual: () => <Scores />,
  },
  {
    title: "We find it on the page",
    words: [
      "We know exactly where every sentence sits in the document, so we can find its page and draw a box around its lines.",
      "Click a claim to see where it lands in the sample document.",
    ],
    visual: (p) => <OnThePage sha={p.sha} />,
  },
  {
    title: "What the labels mean",
    words: [
      "Every claim in an answer gets one of four labels, so you can see at a glance how much of it comes from your document.",
      "We can make sure every citation points at real text. We cannot force a model to only say things that are in your document. What we can do is show you clearly when it did not.",
    ],
    visual: (p) => <Labels onTry={p.onTry} />,
  },
]

export function CitationsLesson(p: CitationsLessonProps) {
  const [i, setI] = useState(0)
  const step = STEPS[i]
  return (
    <article className="flex min-w-0 flex-col gap-6">
      <header className="flex max-w-[68ch] flex-col gap-2">
        <h1 className="text-xl font-semibold">How citations work</h1>
        <p className="m-0 text-base leading-[1.65]">
          A citation connects a claim in the answer to the place in your document it came from. You can click it and check the answer yourself, instead
          of trusting it.
        </p>
        <p className="m-0 text-base leading-[1.65]">
          Only Claude can return citations on its own. For every other model, we use one simple idea: the model points, and we quote. Step through it
          below.
        </p>
      </header>

      <div role="tablist" aria-label="Steps" className="flex flex-wrap gap-2">
        {STEPS.map((s, k) => (
          <button
            key={s.title}
            type="button"
            role="tab"
            id={`cite-tab-${k}`}
            aria-selected={k === i}
            aria-controls="cite-panel"
            onClick={() => setI(k)}
            className={cn(
              "h-control rounded-control border px-2 text-xs",
              k === i ? "border-fg bg-fg text-surface" : k < i ? "border-hairline bg-surface text-fg" : "border-hairline bg-surface text-fg-muted hover:text-fg",
            )}
          >
            {s.title}
          </button>
        ))}
      </div>

      <section
        role="tabpanel"
        id="cite-panel"
        aria-labelledby={`cite-tab-${i}`}
        className="grid min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(260px,340px)_minmax(0,1fr)]"
      >
        <div className="flex max-w-[68ch] flex-col gap-3">
          <h2 className="m-0 text-lg font-semibold">{step.title}</h2>
          {step.words.map((w) => (
            <p key={w} className="m-0 text-base leading-[1.65]">
              {w}
            </p>
          ))}
        </div>
        <div className="min-w-0 rounded-panel border border-hairline bg-surface p-4">{step.visual(p)}</div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="outline" disabled={i === 0} onClick={() => setI(i - 1)}>
          Back
        </Button>
        <Button variant="outline" disabled={i === STEPS.length - 1} onClick={() => setI(i + 1)}>
          Next step
        </Button>
      </div>

      <div className="border-t border-hairline pt-6">
        <LessonEnd slug="citations" />
      </div>
    </article>
  )
}
