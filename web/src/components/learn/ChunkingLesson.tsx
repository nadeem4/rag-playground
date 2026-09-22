import { useEffect, useId, useMemo, useState } from "react"

import { api } from "@/api/client"
import type { LearnChunking, Registry } from "@/api/types"
import { useStages } from "@/api/useExplain"
import { CONTROL } from "@/components/fields/types"
import { Button } from "@/components/ui/button"
import { challengePrompt, choicesFor, FIELDS, labLines, outcomeText, sizeAndOverlap, unitOf } from "@/learn/challenges"
import { analyzeChunks, type ChunkAnalysis } from "@/learn/chunks"
import { runChunksOnce } from "@/learn/runChunks"
import { cn } from "@/lib/utils"

import { ChunkCards } from "./ChunkCards"
import { LearnHint } from "./LearnHint"

/**
 * Learn > Chunking: predict, then see. Every answer runs the REAL chunker on
 * the sample (parsed as the backend says) through the run API, and the result
 * is read from those real chunks. The sliders explore the same way.
 */

export interface ChunkingLessonProps {
  registry: Registry
  /** The sample's sha, once registered. Runs wait for it. */
  sha: string | null
  pollMs?: number
  debounceMs?: number
}

interface Settings {
  strategy: string
  config: Record<string, unknown>
}

type Run =
  | { key: string; kind: "loading"; last?: Done }
  | { key: string; kind: "error"; message: string }
  | ({ key: string; kind: "ready" } & Done)

interface Done {
  settings: Settings
  analysis: ChunkAnalysis
}

interface Answer {
  index: number
  choice: 0 | 1
  key: string
  result?: { right: boolean; text: string }
}

const keyOf = (s: Settings) => JSON.stringify([s.strategy, s.config])

export function ChunkingLesson({ registry, sha, pollMs, debounceMs = 250 }: ChunkingLessonProps) {
  const [data, setData] = useState<{ kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: LearnChunking }>({
    kind: "loading",
  })
  useEffect(() => {
    let live = true
    api.learnChunking().then(
      (d) => live && setData({ kind: "ready", data: d }),
      (e: unknown) => live && setData({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
    )
    return () => {
      live = false
    }
  }, [])
  const stages = useStages()
  const lead = stages.chunk?.lesson ?? []

  return (
    <article className="flex min-w-0 flex-col gap-6">
      <header className="flex max-w-[68ch] flex-col gap-2">
        <h1 className="text-xl font-semibold">Chunking</h1>
        {lead.map((p) => (
          <p key={p} className="m-0 text-base leading-[1.65]">
            {p}
          </p>
        ))}
      </header>
      {data.kind === "loading" ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading the chunking lesson
        </p>
      ) : data.kind === "error" ? (
        <div role="alert" className="flex flex-col gap-1">
          <p className="text-sm font-medium text-danger">Could not load the chunking lesson</p>
          <p className="font-mono text-xs text-fg-muted">{data.message}</p>
        </div>
      ) : (
        <Lab registry={registry} sha={sha} data={data.data} pollMs={pollMs} debounceMs={debounceMs} />
      )}
    </article>
  )
}

function Lab({ registry, sha, data, pollMs, debounceMs }: { registry: Registry; sha: string | null; data: LearnChunking; pollMs?: number; debounceMs: number }) {
  const first = data.challenges[0]
  const [settings, setSettings] = useState<Settings & { delay: number }>(() => ({ strategy: first?.strategy ?? "", config: first?.config ?? {}, delay: 0 }))
  // Nothing runs until the first prediction or slider move: no spoilers.
  const [live, setLive] = useState(false)
  const [run, setRun] = useState<Run | null>(null)
  const [index, setIndex] = useState(0)
  const [answer, setAnswer] = useState<Answer | null>(null)

  const { size, overlap } = sizeAndOverlap(settings.config)
  const invalid = size && overlap && Number(settings.config[overlap]) >= Number(settings.config[size]) ? { size, overlap } : null

  useEffect(() => {
    if (!live || !sha || invalid) return
    const key = keyOf(settings)
    const current = { strategy: settings.strategy, config: settings.config }
    let on = true
    const t = window.setTimeout(() => {
      setRun((r) => ({ key, kind: "loading", last: r?.kind === "ready" ? r : r?.kind === "loading" ? r.last : undefined }))
      runChunksOnce({ registry, sha, parse: data.parse, strategy: settings.strategy, config: settings.config, pollMs }).then(
        (set) => on && setRun({ key, kind: "ready", settings: current, analysis: analyzeChunks(set, data.answer_sentence) }),
        (e: unknown) => on && setRun({ key, kind: "error", message: e instanceof Error ? e.message : String(e) }),
      )
    }, settings.delay)
    return () => {
      on = false
      window.clearTimeout(t)
    }
    // `settings` changes identity on every edit; the key is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, sha, keyOf(settings), Boolean(invalid)])

  // Freeze a challenge's result the moment its own run lands: later slider moves do not rewrite it.
  useEffect(() => {
    if (!answer || answer.result || !run || run.key !== answer.key || run.kind !== "ready") return
    const ch = data.challenges[answer.index]
    const whole = run.analysis.whole !== null
    const right = (answer.choice === 0) === whole
    setAnswer({ ...answer, result: { right, text: outcomeText(ch.strategy, ch.config, run.analysis, data) } })
  }, [answer, run, data])

  const choose = (choice: 0 | 1) => {
    const ch = data.challenges[index]
    const next = { strategy: ch.strategy, config: ch.config }
    setAnswer({ index, choice, key: keyOf(next) })
    setSettings({ ...next, delay: 0 })
    setLive(true)
  }

  const explore = (next: Settings, delay: number) => {
    setSettings({ ...next, delay })
    setLive(true)
  }

  const strategies = [...new Set(data.challenges.map((c) => c.strategy))]
  const shown = run?.kind === "ready" ? run : run?.kind === "loading" ? run.last : undefined

  return (
    <div className="grid min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(260px,320px)_minmax(0,1fr)]">
      <Controls
        registry={registry}
        strategies={strategies}
        settings={settings}
        invalid={invalid}
        onStrategy={(s) => {
          const c = data.challenges.find((x) => x.strategy === s)
          explore({ strategy: s, config: c?.config ?? {} }, 0)
        }}
        onField={(k, v) => explore({ strategy: settings.strategy, config: { ...settings.config, [k]: v } }, debounceMs)}
      />
      <div className="flex min-w-0 flex-col gap-6">
        <Challenge
          data={data}
          index={index}
          answer={answer}
          disabled={!sha}
          running={Boolean(answer && !answer.result && run?.kind === "loading")}
          onChoose={choose}
          onNext={() => {
            setIndex((i) => (i + 1) % data.challenges.length)
            setAnswer(null)
          }}
        />
        {run?.kind === "error" ? (
          <div role="alert" className="flex flex-col gap-1">
            <p className="m-0 text-sm font-medium text-danger">The chunker could not run</p>
            <p className="m-0 font-mono text-xs break-words text-fg-muted">{run.message}</p>
          </div>
        ) : null}
        {shown ? (
          <Result done={shown} data={data} loading={run?.kind === "loading"} />
        ) : !run ? (
          <p className="m-0 text-sm text-fg-muted">Make a prediction to run the chunker on the sample. Its real chunks appear here.</p>
        ) : run.kind === "loading" ? (
          <p role="status" className="m-0 text-sm text-fg-muted">
            Running the chunker on the sample
          </p>
        ) : null}
      </div>
    </div>
  )
}

function Controls({
  registry,
  strategies,
  settings,
  invalid,
  onStrategy,
  onField,
}: {
  registry: Registry
  strategies: string[]
  settings: Settings
  invalid: { size: string; overlap: string } | null
  onStrategy: (s: string) => void
  onField: (key: string, value: number) => void
}) {
  const id = useId()
  const learn = registry.chunk?.[settings.strategy]?.learn
  const fields = Object.keys(settings.config).filter((k) => FIELDS[k])
  return (
    <section aria-label="Settings" className="flex min-w-0 flex-col gap-4 rounded-panel border border-hairline bg-surface-elevated p-4">
      <h2 className="m-0 text-lg font-semibold">Settings</h2>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-strategy`} className="text-sm font-medium">
          Strategy
        </label>
        <select id={`${id}-strategy`} className={CONTROL} value={settings.strategy} onChange={(e) => onStrategy(e.target.value)}>
          {strategies.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {learn?._strategy ? <LearnHint lesson={learn._strategy} /> : null}
      </div>
      {fields.map((k) => {
        const f = FIELDS[k]
        const v = Number(settings.config[k])
        return (
          <div key={k} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor={`${id}-${k}`} className="text-sm font-medium">
                {f.label}
              </label>
              <span className="font-mono text-xs text-fg">
                {v} {f.unit}
              </span>
            </div>
            <input
              id={`${id}-${k}`}
              type="range"
              min={f.min}
              max={f.max}
              step={f.step}
              value={v}
              onChange={(e) => onField(k, Number(e.target.value))}
              className="w-full [accent-color:var(--text-primary)]"
            />
            {invalid?.overlap === k ? (
              <p role="status" className="m-0 text-xs text-danger">
                The overlap must be smaller than the {FIELDS[invalid.size].label.toLowerCase()}, or the chunks would never move forward through the
                text. Lower the overlap or raise the {FIELDS[invalid.size].label.toLowerCase()}.
              </p>
            ) : null}
            {learn?.[k] ? <LearnHint lesson={learn[k]} /> : null}
          </div>
        )
      })}
    </section>
  )
}

function Challenge({
  data,
  index,
  answer,
  disabled,
  running,
  onChoose,
  onNext,
}: {
  data: LearnChunking
  index: number
  answer: Answer | null
  disabled: boolean
  running: boolean
  onChoose: (c: 0 | 1) => void
  onNext: () => void
}) {
  const ch = data.challenges[index]
  if (!ch) return null
  const choices = choicesFor(ch)
  const last = index === data.challenges.length - 1
  return (
    <section aria-label="Challenge" aria-live="polite" className="flex min-w-0 flex-col gap-3 rounded-panel border border-hairline bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 text-lg font-semibold">{ch.title}</h2>
        <span className="text-xs text-fg-muted">
          Challenge {index + 1} of {data.challenges.length}
        </span>
      </div>
      <p className="m-0 max-w-[68ch] text-base leading-[1.65]">{challengePrompt(ch, data)}</p>
      <div className="flex flex-wrap gap-2">
        {choices.map((c, i) => (
          <Button
            key={c}
            variant="outline"
            disabled={disabled || answer !== null}
            aria-pressed={answer?.choice === i}
            className={cn(answer?.choice === i && "border-fg-muted bg-surface-elevated")}
            onClick={() => onChoose(i as 0 | 1)}
          >
            {c}
          </Button>
        ))}
      </div>
      {running ? (
        <p role="status" className="m-0 text-sm text-fg-muted">
          Running the chunker on the sample
        </p>
      ) : null}
      {answer?.result ? (
        <div className={cn("flex flex-col gap-1 rounded-panel p-3 text-sm", answer.result.right ? "bg-kept text-kept-text" : "bg-removed text-removed-text")}>
          <p className="m-0 font-semibold">{answer.result.right ? "You were right." : "Not quite."}</p>
          <p className="m-0">{answer.result.text}</p>
          <p className="m-0">The settings have changed to match. Move them yourself to explore.</p>
        </div>
      ) : null}
      {answer?.result ? (
        <div>
          <Button variant="outline" onClick={onNext}>
            {last ? "Start again" : "Next challenge"}
          </Button>
        </div>
      ) : null}
    </section>
  )
}

function Result({ done, data, loading }: { done: Done; data: LearnChunking; loading: boolean }) {
  const lines = useMemo(() => labLines(done.settings.config, done.analysis, data), [done, data])
  return (
    <div className={cn("flex min-w-0 flex-col gap-4", loading && "opacity-60")} aria-busy={loading || undefined}>
      <section aria-label="What you are seeing" className="flex flex-col gap-2">
        <h2 className="m-0 text-lg font-semibold">What you are seeing</h2>
        <ul className="m-0 flex max-w-[68ch] flex-col gap-1 pl-4 text-sm">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </section>
      <p className="m-0 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
        <span>
          <span className="underline decoration-fg decoration-2 underline-offset-[3px]">Underlined</span> text is the sentence that answers &ldquo;
          {data.question}&rdquo;.
        </span>
        <span className="flex items-center gap-1">
          <span
            aria-hidden
            className="inline-block h-[12px] w-[24px] border border-hairline"
            style={{
              background: "repeating-linear-gradient(135deg, color-mix(in oklch, var(--text-secondary) 24%, transparent) 0 2px, transparent 2px 6px)",
            }}
          />
          Hatched text is repeated from the chunk before.
        </span>
      </p>
      <ChunkCards key={keyOf(done.settings)} analysis={done.analysis} unit={unitOf(done.settings.config)} />
    </div>
  )
}
