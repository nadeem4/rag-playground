import type { CSSProperties, ReactNode } from "react"

import chunkRecursive from "@/api/fixtures/chunk_set.recursive_character.json"
import chunkToken from "@/api/fixtures/chunk_set.token_based.json"
import cleanedDoc from "@/api/fixtures/parsed_doc_cleaned.json"
import registry from "@/api/fixtures/registry.json"
import type { ChunkSet, CleanReportEntry, ParsedDoc } from "@/api/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { CHUNK_CLASSES, SCORE_CLASSES } from "@/styles/dataClasses"
import {
  CHUNK_SLOTS,
  contrast,
  darkTokens,
  lightTokens,
  resolve,
  SCORE_STEPS,
  type TokenMap,
} from "@/styles/tokenSource"

/**
 * The token specimen: how a human checks the design contract was honoured.
 * Every sample is real engine output from the generated fixtures. Swatch
 * columns read both themes out of tokens.css; everything else is live in the
 * current theme, so flip the header control to check the other one.
 */

const recursive = chunkRecursive as unknown as ChunkSet
const tokenBased = chunkToken as unknown as ChunkSet
const cleaned = cleanedDoc as unknown as ParsedDoc
const report = (cleaned.parser_meta.clean_report ?? []) as CleanReportEntry[]
const chunkConfig = registry.chunk.recursive_character.config_schema.properties
const dedupeConfig = registry.clean.dedupe_blocks.config_schema.properties

const THEMES: [string, TokenMap][] = [
  ["Light", lightTokens],
  ["Dark", darkTokens],
]

const fmt = (n: number) => n.toLocaleString("en-US")
const ratio = (n: number) => `${n.toFixed(1)}:1`
const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`
}

// --------------------------------------------------------------- layout --

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 bg-surface p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        {note ? <p className="max-w-[80ch] text-sm text-fg-muted">{note}</p> : null}
      </div>
      {children}
    </section>
  )
}

/** Hairline table: `grid gap-px` over a hairline parent, so no double seams. */
function Grid({ columns, head, children }: { columns: string; head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-panel border border-hairline">
      <div className="grid min-w-max gap-px bg-hairline" style={{ gridTemplateColumns: columns }}>
        {head.map((h, i) => (
          <div key={i} className="meta flex h-row-compact items-center bg-surface-elevated px-2">
            {h}
          </div>
        ))}
        {children}
      </div>
    </div>
  )
}

function Cell({ children, mono, style, className }: { children: ReactNode; mono?: boolean; style?: CSSProperties; className?: string }) {
  return (
    <div
      style={style}
      className={cn("flex h-row items-center overflow-hidden bg-surface px-2 whitespace-nowrap", mono ? "font-mono text-xs" : "text-sm", className)}
    >
      {children}
    </div>
  )
}

function Swatch({ value }: { value: string }) {
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className="block size-[16px] shrink-0 rounded-control border border-hairline" style={{ background: value }} />
      <span className="font-mono text-xs text-fg-muted">{value}</span>
    </span>
  )
}

// ------------------------------------------------------------- sections --

function TypeScale() {
  const total = recursive.chunks.reduce((n, c) => n + c.token_count, 0)
  const first = recursive.chunks[0]
  // One paragraph of the real source, from a sentence start to a full stop.
  const src = recursive.source_text.replace(/\s+/g, " ")
  const from = Math.max(0, src.indexOf("Recursive splitting tries"))
  const paragraph = src.slice(from, src.indexOf(".", from + 300) + 1)
  const rows: [string, number, ReactNode][] = [
    ["2xs", 11, <span className="meta">chunk 1 chars {first.start_char}-{first.end_char}</span>],
    ["xs", 12, <span className="text-xs text-fg-muted">recursive_character v1, chunk_size 400, chunk_overlap 80</span>],
    ["sm", 13, <span className="text-sm">{clip(first.text, 90)} <span className="font-mono">{fmt(total)} tokens</span></span>],
    ["base", 14, <span className="block max-w-reading text-base whitespace-normal">{paragraph}</span>],
    ["lg", 16, <span className="text-lg font-medium">Recursive character splitting</span>],
    ["xl", 20, <span className="text-xl font-semibold">Inspector</span>],
  ]
  return (
    <Section title="Type" note="Geist Sans for labels and prose, Geist Mono for every number. Six sizes; hierarchy comes from weight and tint.">
      <div className="flex flex-col gap-px overflow-hidden rounded-panel border border-hairline bg-hairline">
        {rows.map(([name, px, sample]) => (
          <div key={name} className="grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-3 bg-surface px-3 py-2">
            <span className="font-mono text-xs text-fg-muted">
              text-{name} {px}px
            </span>
            <div className="min-w-0 truncate">{sample}</div>
          </div>
        ))}
      </div>
    </Section>
  )
}

function SpacingScale() {
  const steps: [string, number][] = [["1", 4], ["2", 8], ["3", 12], ["4", 16], ["6", 24]]
  return (
    <Section title="Spacing" note="4px base, capped at 24px. Nothing larger compiles: the Tailwind theme declares only these five steps.">
      <div className="flex flex-col gap-2">
        {steps.map(([k, px]) => (
          <div key={k} className="grid grid-cols-[96px_24px_minmax(0,1fr)] items-center gap-3">
            <span className="font-mono text-xs text-fg-muted">p-{k} {px}px</span>
            <span aria-hidden className="block h-[8px] bg-fg-muted" style={{ width: px }} />
            <span className="text-xs text-fg-muted">
              {px === 4 && "label to input"}
              {px === 8 && "field gap"}
              {px === 12 && "panel padding"}
              {px === 16 && "group separation"}
              {px === 24 && "the cap"}
            </span>
          </div>
        ))}
      </div>
    </Section>
  )
}

function Shape() {
  return (
    <Section title="Shape" note="One hairline, two radii, no shadows. Elevation is a border plus a background step.">
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex flex-col gap-1">
          <Button variant="outline">Control 4px</Button>
          <span className="font-mono text-xs text-fg-muted">rounded-control</span>
        </div>
        <div className="flex flex-col gap-1">
          <div className="rounded-panel border border-hairline bg-surface-elevated p-3 text-sm">Panel 6px</div>
          <span className="font-mono text-xs text-fg-muted">rounded-panel bg-surface-elevated</span>
        </div>
      </div>
    </Section>
  )
}

const CHROME: [string, string][] = [
  ["--surface", "page"],
  ["--surface-elevated", "panel, one step up"],
  ["--hairline", "every border"],
  ["--text-primary", "body text"],
  ["--text-secondary", "secondary text"],
  ["--accent", "focus, selection, Run"],
  ["--selection", "selected row"],
  ["--danger", "error text"],
  ["--field-border", "input border"],
]

function ChromeChannel() {
  return (
    <Section title="Chrome" note="Channel A. Zinc neutrals and exactly one accent. The accent appears only on focus rings, selection and the Run action.">
      <Grid columns="160px 190px 190px minmax(160px,1fr)" head={["token", "light", "dark", "role"]}>
        {CHROME.map(([name, role]) => (
          <Row key={name}>
            <Cell mono>{name}</Cell>
            {THEMES.map(([theme, tokens]) => (
              <Cell key={theme}>
                <Swatch value={resolve(tokens, name)} />
              </Cell>
            ))}
            <Cell className="text-fg-muted">{role}</Cell>
          </Row>
        ))}
      </Grid>
    </Section>
  )
}

/** A fragment, so its cells land directly in the parent grid. */
function Row({ children }: { children: ReactNode }) {
  return <>{children}</>
}

function ChunkChannel() {
  const samples = [...recursive.chunks, ...tokenBased.chunks]
  const total = recursive.source_text.length
  return (
    <Section
      title="Chunk identity"
      note="Channel B, categorical. OKLCH with fixed lightness and chroma, only hue varies, so no chunk reads as heavier than another. Dark is one lightness step down. Every fill carries its paired text color."
    >
      <Grid columns="72px 48px minmax(300px,1fr) 64px minmax(300px,1fr) 64px" head={["slot", "hue", "light", "ratio", "dark", "ratio"]}>
        {CHUNK_SLOTS.map((i) => {
          const hue = /oklch\([\d.]+ [\d.]+ ([\d.]+)\)/.exec(lightTokens.get(`--chunk-${i}`) ?? "")?.[1]
          const text = clip(samples[i - 1]?.text ?? "", 44)
          return (
            <Row key={i}>
              <Cell mono>chunk-{i}</Cell>
              <Cell mono>{hue}</Cell>
              {THEMES.map(([theme, tokens]) => {
                const fill = tokens.get(`--chunk-${i}`)!
                const ink = tokens.get(`--chunk-${i}-text`)!
                return [
                  <Cell key={`${theme}-s`} style={{ background: fill, color: ink }}>
                    {text}
                  </Cell>,
                  <Cell key={`${theme}-r`} mono>
                    {ratio(contrast(fill, ink))}
                  </Cell>,
                ]
              })}
            </Row>
          )
        })}
      </Grid>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-fg-muted">
          Current theme: {recursive.chunks.length} recursive_character chunks, width proportional to characters, overlaps not drawn.
        </span>
        <div className="flex h-row gap-px overflow-hidden rounded-control">
          {recursive.chunks.map((c, n) => {
            return (
              <div
                key={c.id}
                title={`chunk ${c.ordinal + 1}: chars ${c.start_char}-${c.end_char}, ${c.token_count} tokens`}
                className={`flex min-w-0 items-center px-1 font-mono text-xs ${CHUNK_CLASSES[n % CHUNK_CLASSES.length]}`}
                style={{ flex: `${c.end_char - c.start_char} 1 0` }}
              >
                {c.ordinal + 1}
              </div>
            )
          })}
        </div>
        <span className="font-mono text-xs text-fg-muted">{fmt(total)} chars in source_text</span>
      </div>
    </Section>
  )
}

function ScoreRamp() {
  return (
    <Section title="Score" note="Channel B, sequential. One hue, lightness only. Step 1 is the lowest score; in dark mode the low end recedes toward the surface.">
      <Grid columns="96px repeat(5, minmax(96px,1fr))" head={["theme", "1 lowest", "2", "3", "4", "5 highest"]}>
        {[...THEMES, ["Current", null] as const].map(([theme, tokens]) => (
          <Row key={theme}>
            <Cell mono>{theme}</Cell>
            {SCORE_STEPS.map((s) => (
              <Cell
                key={s}
                style={tokens ? { background: tokens.get(`--score-${s}`) } : undefined}
                className={tokens ? "" : SCORE_CLASSES[s - 1]}
              >
                {null}
              </Cell>
            ))}
          </Row>
        ))}
      </Grid>
    </Section>
  )
}

function KeptRemoved() {
  const removed = report.flatMap((r) => r.removed.map((row) => ({ ...row, cleaner: r.cleaner })))
  const kept = cleaned.elements.slice(0, 3)
  return (
    <Section
      title="Kept and removed"
      note="Channel B, divergent. Removal is a tinted fill plus strikethrough, never color alone. Rows below are the real clean_report from header_footer_strip then dedupe_blocks."
    >
      <div className="flex flex-wrap gap-4">
        {THEMES.map(([theme, tokens]) => (
          <div key={theme} className="flex items-center gap-2 text-xs">
            <span className="w-[40px] font-mono text-fg-muted">{theme}</span>
            {(["kept", "removed"] as const).map((k) => (
              <span
                key={k}
                className={`rounded-control px-2 font-mono ${k === "removed" ? "line-through" : ""}`}
                style={{ background: tokens.get(`--${k}`), color: tokens.get(`--${k}-text`) }}
              >
                {k} {ratio(contrast(tokens.get(`--${k}`)!, tokens.get(`--${k}-text`)!))}
              </span>
            ))}
          </div>
        ))}
      </div>
      <Grid columns="152px 72px 44px minmax(260px,1fr) minmax(260px,1fr)" head={["cleaner", "id", "page", "text", "reason"]}>
        {removed.map((r) => (
          <Row key={`${r.cleaner}-${r.id}`}>
            <Cell mono>{r.cleaner}</Cell>
            <Cell mono>{r.id}</Cell>
            <Cell mono>{r.page}</Cell>
            <Cell className="bg-removed text-removed-text line-through">{r.preview}</Cell>
            <Cell className="text-fg-muted">{r.reason}</Cell>
          </Row>
        ))}
        {kept.map((el) => (
          <Row key={el.id}>
            <Cell mono>kept</Cell>
            <Cell mono>{el.id}</Cell>
            <Cell mono>{el.page}</Cell>
            <Cell className="bg-kept text-kept-text">{clip(el.text, 60)}</Cell>
            <Cell className="text-fg-muted">{el.type}</Cell>
          </Row>
        ))}
      </Grid>
    </Section>
  )
}

function FormSample() {
  const size = chunkConfig.chunk_size
  const similarity = dedupeConfig.similarity
  return (
    <Section title="Form field" note="Label above, help and error below. Colors come from the --field-* tokens only.">
      <div className="grid max-w-[360px] gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="spec-chunk-size">{size.title}</Label>
          <Input id="spec-chunk-size" type="number" defaultValue={size.default} min={size.minimum} aria-describedby="spec-chunk-size-help" />
          <p id="spec-chunk-size-help" className="text-xs text-fg-muted">
            Characters per chunk. Minimum {size.minimum}, default {fmt(size.default)}.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="spec-similarity">{similarity.title}</Label>
          <Input
            id="spec-similarity"
            type="number"
            step="0.01"
            defaultValue="1.4"
            aria-invalid
            aria-describedby="spec-similarity-help spec-similarity-error"
          />
          <p id="spec-similarity-help" className="text-xs text-fg-muted">
            {similarity.description}
          </p>
          <p id="spec-similarity-error" className="text-xs text-danger">
            Must be between {similarity.minimum} and {similarity.maximum}.
          </p>
        </div>
        <div className="flex gap-2">
          <Button>Run</Button>
          <Button variant="outline">Reset</Button>
        </div>
      </div>
    </Section>
  )
}

function ChunkTable() {
  return (
    <Section title="Table" note="Hairline gap-grid, 28px rows, mono numbers. recursive_character output on the cleaned fixture document.">
      <Grid columns="40px 64px 64px 64px 56px minmax(320px,1fr)" head={["#", "start", "end", "tokens", "pages", "text"]}>
        {recursive.chunks.map((c) => (
          <Row key={c.id}>
            <Cell mono>{c.ordinal + 1}</Cell>
            <Cell mono className="justify-end">{fmt(c.start_char)}</Cell>
            <Cell mono className="justify-end">{fmt(c.end_char)}</Cell>
            <Cell mono className="justify-end">{c.token_count}</Cell>
            <Cell mono>{c.page_span ? `${c.page_span[0]}-${c.page_span[1]}` : "none"}</Cell>
            <Cell>{clip(c.text, 80)}</Cell>
          </Row>
        ))}
      </Grid>
    </Section>
  )
}

export function Specimen() {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-hairline">
      <div className="flex flex-col gap-px">
        <section className="flex flex-col gap-1 bg-surface p-4">
          <h1 className="text-xl font-semibold">Design tokens</h1>
          <p className="max-w-[80ch] text-sm text-fg-muted">
            Swatch columns show both themes, read from tokens.css. Everything else follows the current theme. Switch it in the header to check the other.
          </p>
        </section>
        <TypeScale />
        <SpacingScale />
        <Shape />
        <ChromeChannel />
        <ChunkChannel />
        <ScoreRamp />
        <KeptRemoved />
        <FormSample />
        <ChunkTable />
      </div>
    </main>
  )
}
