import { useState, type ReactNode } from "react"

import registryJson from "@/api/fixtures/registry.json"
import type { JsonSchema, Registry } from "@/api/types"
import { errorsFromPydantic, type FieldErrors, type PydanticError } from "@/components/fields/schema"
import { SchemaForm } from "@/components/SchemaForm"

/**
 * The form gallery: every registered transform's config form, rendered from
 * the real `export_schema()` output, with the config each one emits. Adding a
 * plugin in Python adds a panel here with no frontend change.
 */

const registry = registryJson as unknown as Registry

const stageName = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())

type Config = Record<string, unknown>

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <StageRow title={title}>
      <div className="flex min-w-0 flex-col gap-3">
        {note ? <p className="max-w-[80ch] text-sm text-fg-muted">{note}</p> : null}
        {children}
      </div>
    </StageRow>
  )
}

/** One row per stage: its name in a narrow left column, its panels to the right. */
function StageRow({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid grid-cols-1 gap-3 bg-surface p-4 md:grid-cols-[120px_minmax(0,1fr)]">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  )
}

function Panels({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,380px))] items-start gap-3">{children}</div>
}

function Panel({
  name,
  meta,
  schema,
  initial,
  errors,
}: {
  name: string
  meta: string
  schema: JsonSchema
  initial?: Config
  errors?: FieldErrors
}) {
  const [value, setValue] = useState<Config | undefined>(initial)
  return (
    <article className="flex min-w-0 flex-col overflow-hidden rounded-panel border border-hairline bg-surface">
      <header className="flex h-row items-center justify-between gap-2 border-b border-hairline bg-surface-elevated px-3">
        <h3 className="truncate font-mono text-sm font-medium">{name}</h3>
        <span className="meta shrink-0 normal-case">{meta}</span>
      </header>
      <div className="p-3">
        <SchemaForm schema={schema} value={value} onChange={setValue} errors={errors} />
      </div>
      <div className="flex flex-col gap-1 border-t border-hairline bg-surface-elevated p-3">
        <span className="meta">config</span>
        <pre className="m-0 overflow-x-auto font-mono text-xs text-fg">{JSON.stringify(value ?? {}, null, 2)}</pre>
      </div>
    </article>
  )
}

/** Shapes Pydantic emits that no registered plugin uses yet. */
const CASES: JsonSchema = {
  type: "object",
  title: "RendererCases",
  $defs: {
    Metric: { enum: ["cosine", "l2", "dot"], title: "Metric", type: "string" },
    Window: {
      type: "object",
      title: "Window",
      properties: {
        size: { type: "integer", minimum: 1, default: 3, title: "Size" },
        stride: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }], default: null, title: "Stride" },
      },
    },
  },
  properties: {
    metric: { $ref: "#/$defs/Metric", default: "cosine", description: "An enum reached through `$defs`." },
    temperature: {
      anyOf: [{ type: "number", exclusiveMinimum: 0, exclusiveMaximum: 2 }, { type: "null" }],
      default: 0.7,
      title: "Temperature",
      description: "Optional float with exclusive bounds.",
    },
    context: {
      type: "object",
      title: "Context",
      properties: {
        neighbours: { type: "integer", minimum: 0, default: 1, title: "Neighbours" },
        window: { $ref: "#/$defs/Window" },
      },
    },
    stop: { type: "array", items: { type: "string" }, default: ["\n\n"], title: "Stop" },
  },
}

// Captured from the engine: RecursiveCharacterConfig(chunk_size=0, chunk_overlap=-5).
const CAPTURED_422: PydanticError[] = [
  { type: "greater_than_equal", loc: ["chunk_size"], msg: "Input should be greater than or equal to 1", input: 0, ctx: { ge: 1 } },
  { type: "greater_than_equal", loc: ["chunk_overlap"], msg: "Input should be greater than or equal to 0", input: -5, ctx: { ge: 0 } },
]

export function Forms() {
  const stages = Object.entries(registry).filter(([, byName]) => byName && Object.keys(byName).length > 0)
  const recursive = registry.chunk?.recursive_character
  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-hairline">
      <div className="flex flex-col gap-px">
        <section className="flex flex-col gap-1 bg-surface p-4">
          <h1 className="text-xl font-semibold">Config forms</h1>
          <p className="max-w-[80ch] text-sm text-fg-muted">
            Every registered transform, its form rendered from the config schema in registry.json. Edit a field to see
            the config it emits.
          </p>
        </section>
        {stages.map(([stage, byName]) => (
          <StageRow key={stage} title={stageName(stage)}>
            <Panels>
              {Object.values(byName!).map((info) => (
                <Panel key={info.name} name={info.name} meta={`v${info.version}`} schema={info.config_schema} />
              ))}
            </Panels>
          </StageRow>
        ))}
        {recursive ? (
          <Section
            title="Server errors"
            note="A 422 from the engine for chunk_size 0 and chunk_overlap -5, keyed by each error's loc and shown under its field."
          >
            <Panels>
              <Panel
                name={recursive.name}
                meta="422"
                schema={recursive.config_schema}
                initial={{ chunk_size: 0, chunk_overlap: -5 }}
                errors={errorsFromPydantic(CAPTURED_422)}
              />
            </Panels>
          </Section>
        ) : null}
        <Section
          title="Other shapes"
          note="A hand-written schema covering what no plugin uses yet: a $ref enum, an Optional with exclusive bounds, a nested model with a third level behind a disclosure, and an array, which falls back to raw JSON."
        >
          <Panels>
            <Panel name="renderer_cases" meta="sample" schema={CASES} />
          </Panels>
        </Section>
      </div>
    </main>
  )
}
