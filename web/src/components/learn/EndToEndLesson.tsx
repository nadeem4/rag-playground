import { useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import {
  barHeight,
  chunkById,
  chunkStep,
  cleanStep,
  hitMeta,
  parseStep,
  quoteSource,
  rerankRows,
  rerankStep,
  retrieveStep,
  RUN,
  searchHits,
  snippet,
  topBy,
  type PoolEntry,
  type StepWords,
} from "@/learn/e2e"
import { cn } from "@/lib/utils"

import { LessonEnd } from "./LessonEnd"
import "./learn.css"

/**
 * Learn > How RAG works, end to end: one question traced from what came back
 * to the PDF, drawn from a recorded real run. Every number is computed from
 * that run (`learn/e2e.ts`). The written answer is an example, and says so.
 */

export interface EndToEndLessonProps {
  /** "Run it yourself": open Build with the recorded run's graph. */
  onRun: () => void
  /** Open Build with the sample and a chat step. */
  onChat: () => void
}

/** The example answer: each claim and the real sentence its number points to. */
const ANSWER: { claim: string; quote: string }[] = [
  { claim: "Chunk boundaries matter because a search scores each chunk as a whole.", quote: "A retriever scores each chunk as a whole." },
  {
    claim: "When a boundary cuts an explanation in half, neither half scores well, and the model receives a passage that never answers the question.",
    quote:
      "When a boundary falls in the middle of an explanation, the question lands on one half and the answer on the other, and neither half scores well on its own.",
  },
  {
    claim: "Boundaries also decide what stays together, so a table cut off from its caption loses the context that made it useful.",
    quote: "A definition separated from the term it defines, or a table separated from its caption, loses the context that made it useful.",
  },
]

function Note({ children }: { children: ReactNode }) {
  return <p className="m-0 text-sm text-fg-muted">{children}</p>
}

function SearchFound() {
  return (
    <div className="flex flex-col gap-3">
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {searchHits(RUN).map((h, i) => (
          <li key={h.id} className="grid grid-cols-[28px_minmax(0,1fr)] items-start gap-2">
            <span className="pt-px font-mono text-sm text-fg-muted">{i + 1}</span>
            <div className="flex min-w-0 flex-col gap-1">
              <p className="m-0 text-base">{snippet(h.text, 320)}</p>
              <span className="font-mono text-xs text-fg-muted">{hitMeta(h, RUN)}</span>
            </div>
          </li>
        ))}
      </ol>
      <Note>This is what you get without an API key: the passages a model would read. No model runs, so it costs nothing.</Note>
    </div>
  )
}

function WithModel({ onChat }: { onChat: () => void }) {
  const [picked, setPicked] = useState<number | null>(null)
  const quote = picked === null ? null : ANSWER[picked].quote
  const src = quote ? quoteSource(RUN, quote) : null
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-xs font-medium text-fg-muted">An example answer</p>
      <p className="m-0 text-lg leading-[1.75]">
        {ANSWER.map((a, i) => (
          <span key={a.claim}>
            {a.claim}
            <button
              type="button"
              aria-label={`Source ${i + 1}`}
              aria-pressed={picked === i}
              onClick={() => setPicked(i)}
              className="mx-1 rounded-control border border-kept-mark px-1 font-mono text-xs text-fg hover:bg-kept aria-pressed:bg-kept"
            >
              {i + 1}
            </button>{" "}
          </span>
        ))}
      </p>
      <div className="rounded-panel border-l-2 border-kept-mark bg-kept px-3 py-2 text-base text-kept-text">
        {quote === null ? (
          "Click a number to see the exact sentence it points to."
        ) : (
          <>
            <span>"{quote}"</span>
            <br />
            <span className="text-sm">{src ? `Chunk ${src.chunk}, page ${src.page} of the PDF.` : "This sentence is not in the recorded run."}</span>
          </>
        )}
      </div>
      <Note>
        This answer is an example written for this page. In the playground, add an API key or a local model, and a real model writes the answer. Every
        number points to a real sentence in the PDF.
      </Note>
      <div>
        <Button variant="outline" onClick={onChat}>
          Open Build with a chat step
        </Button>
      </div>
    </div>
  )
}

function Result({ onChat }: { onChat: () => void }) {
  const [tab, setTab] = useState<"search" | "model">("search")
  const tabs = [
    ["search", "What search found"],
    ["model", "With a model"],
  ] as const
  return (
    <section aria-label="What came back" className="overflow-hidden rounded-panel border border-hairline bg-surface-elevated">
      <div role="tablist" aria-label="What came back" className="flex border-b border-hairline">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`e2e-tab-${key}`}
            aria-selected={tab === key}
            aria-controls="e2e-panel"
            onClick={() => setTab(key)}
            className={cn(
              "-mb-px border-b-2 px-4 py-3 text-base font-medium",
              tab === key ? "border-fg text-fg" : "border-transparent text-fg-muted hover:text-fg",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="e2e-panel" aria-labelledby={`e2e-tab-${tab}`} className="p-4">
        {tab === "search" ? <SearchFound /> : <WithModel onChat={onChat} />}
      </div>
    </section>
  )
}

function RerankView() {
  const [all, setAll] = useState(false)
  return (
    <div className="flex flex-col gap-1">
      {rerankRows(RUN, all).map((r) => (
        <div
          key={r.rank}
          className={cn(
            "grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-2 rounded-control px-2 py-1 text-base",
            r.kind === "kept" && "bg-kept text-kept-text",
          )}
        >
          <span className="font-mono text-sm text-fg-muted">#{r.rank}</span>
          <span className={cn("truncate", r.kind === "skipped" && "text-fg-muted line-through decoration-removed-mark", r.kind === "rest" && "text-fg-muted")}>
            {r.text}
          </span>
          <span className={cn("text-xs whitespace-nowrap", r.kind === "kept" && "font-medium", r.kind === "skipped" && "text-removed-text")}>{r.why}</span>
        </div>
      ))}
      <Button variant="ghost" className="self-start" onClick={() => setAll(!all)}>
        {all ? "Show fewer" : `Show all ${RUN.pool.length} candidates`}
      </Button>
    </div>
  )
}

function Ranking({ title, list, score }: { title: string; list: PoolEntry[]; score: (p: PoolEntry) => string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h4 className="m-0 text-sm font-semibold">{title}</h4>
      <ol className="m-0 list-decimal pl-6 text-sm">
        {list.map((p, i) => (
          <li key={p.id} className={cn("mb-1", i === 0 && "font-medium")}>
            {snippet(chunkById(RUN, p.id).text, 46)}
            <span className="ml-2 font-mono text-xs font-normal text-fg-muted">{score(p)}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function RetrieveView() {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Ranking title="Meaning search" list={topBy(RUN, "dense", 4)} score={(p) => p.dense!.toFixed(2)} />
        <Ranking title="Keyword search" list={topBy(RUN, "bm25", 4)} score={(p) => p.bm25!.toFixed(1)} />
      </div>
      <Note>
        The numbers are each search's own score, and they are not comparable with each other. That is why hybrid search merges the two lists by rank
        instead of by score.
      </Note>
    </div>
  )
}

function ChunkView() {
  const top = RUN.mmr[0]
  const kept = new Set(RUN.mmr)
  const [sel, setSel] = useState(top)
  const c = chunkById(RUN, sel)
  const legend: [string, string][] = [
    ["top", "the top chunk"],
    ["kept", "in the final picks"],
    ["rest", "not used"],
  ]
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="chunk-map h-[84px]">
        {RUN.chunks.map((x) => (
          <button
            key={x.id}
            type="button"
            aria-label={`Chunk ${x.ordinal + 1}, ${x.end - x.start} characters`}
            aria-pressed={x.id === sel}
            data-chunk={x.id === top ? "top" : kept.has(x.id) ? "kept" : "rest"}
            style={{ height: barHeight(x, RUN, 30, 54) }}
            onClick={() => setSel(x.id)}
          />
        ))}
      </div>
      <div className="flex justify-between font-mono text-xs text-fg-muted">
        <span>start of the document</span>
        <span>end</span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
        {legend.map(([kind, label]) => (
          <span key={kind} className="flex items-center gap-2">
            <span data-chunk={kind} aria-hidden className="inline-block size-[12px]" />
            {label}
          </span>
        ))}
      </div>
      <Note>
        Chunk {c.ordinal + 1}, {c.end - c.start} characters, page {c.page_span[0]}. Click a bar to read another chunk.
      </Note>
      <div className="rounded-panel bg-surface p-3 font-mono text-sm leading-[1.7] whitespace-pre-wrap">{c.text}</div>
    </div>
  )
}

function CleanView() {
  const r = RUN.removed[0]
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-control border border-hairline bg-surface px-3 py-2 text-base">
        <span className="block font-mono text-xs text-fg-muted">page {r.duplicate_of_page}, kept</span>
        {r.text}
      </div>
      <div className="rounded-control border border-hairline bg-removed px-3 py-2 text-base text-removed-text">
        <span className="block font-mono text-xs">page {r.page}, removed as a duplicate</span>
        <span className="line-through decoration-removed-mark">{r.text}</span>
      </div>
    </div>
  )
}

function ParseView() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-panel border border-hairline bg-surface p-4">
        {RUN.elements
          .filter((e) => e.page === 1)
          .map((e, i) => (
            <div key={i} data-testid="block" className="grid grid-cols-[84px_minmax(0,1fr)] items-baseline gap-2 text-sm">
              <span className="justify-self-start rounded-control border border-hairline px-1 font-mono text-2xs text-fg-muted">{e.type}</span>
              <span className={cn("truncate", e.type === "heading" && "font-semibold")}>{e.text}</span>
            </div>
          ))}
      </div>
      <Note>
        Page 1 of {RUN.page_count}, as Docling saw it. Each block keeps its page and its position, which is how a citation can later point back to the exact
        place.
      </Note>
    </div>
  )
}

function Step({ id, step, links, children }: { id: string; step: StepWords; links?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={`e2e-${id}`} className="grid grid-cols-1 gap-4 border-t border-hairline py-6 lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-6">
      <div className="learn-sticky flex flex-col gap-2 self-start">
        <h3 id={`e2e-${id}`} className="m-0 text-xl font-semibold">
          {step.title}
        </h3>
        {step.words.map((w) => (
          <p key={w} className="m-0 text-base">
            {w}
          </p>
        ))}
        {links}
      </div>
      <div className="min-w-0 self-start rounded-panel border border-hairline bg-surface-elevated p-4">{children}</div>
    </section>
  )
}

export function EndToEndLesson({ onRun, onChat }: EndToEndLessonProps) {
  return (
    <article className="flex min-w-0 flex-col">
      <header className="flex max-w-[720px] flex-col gap-3 pb-6">
        <h1 className="learn-title">How RAG works, end to end</h1>
        <p className="learn-lead">
          We asked a short PDF about chunking one question. Start with what came back, then scroll down to see how each step produced it.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <p className="m-0 text-base text-fg-muted">This page shows a recorded run of this playground on its sample document.</p>
          <Button variant="outline" onClick={onRun}>
            Run it yourself
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-3 rounded-panel border border-hairline bg-surface-elevated px-4 py-3">
          <span className="text-lg font-medium">"{RUN.question}"</span>
          <span className="text-sm text-fg-muted">
            asked of {RUN.filename}, {RUN.page_count} pages
          </span>
        </div>
      </header>

      <Result onChat={onChat} />

      <header className="flex max-w-[720px] flex-col gap-2 pt-6 pb-4">
        <h2 className="learn-h2">How that answer was made</h2>
        <p className="m-0 text-lg text-fg-muted">
          Each step below is one part of the pipeline, from the last step back to the PDF. The views show what that step really produced.
        </p>
      </header>

      <Step id="rerank" step={rerankStep(RUN)}>
        <RerankView />
      </Step>
      <Step id="retrieve" step={retrieveStep(RUN)}>
        <RetrieveView />
      </Step>
      <Step
        id="chunk"
        step={chunkStep(RUN)}
        links={
          <a href="/learn/chunking" className="text-base font-medium text-fg underline decoration-fg-muted underline-offset-2">
            Learn how chunking works
          </a>
        }
      >
        <ChunkView />
      </Step>
      <Step id="clean" step={cleanStep(RUN)}>
        <CleanView />
      </Step>
      <Step id="parse" step={parseStep(RUN)}>
        <ParseView />
      </Step>

      <section className="learn-band flex max-w-[720px] flex-col gap-3">
        <h2 className="learn-h2">You have followed one question from start to finish.</h2>
        <p className="m-0 text-lg text-fg-muted">
          Next, look closer at one step. The chunking lesson lets you predict what a setting will do, then see it happen.
        </p>
        <LessonEnd slug="end-to-end" />
      </section>
    </article>
  )
}
