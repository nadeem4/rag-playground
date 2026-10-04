import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import type { JsonSchema } from "@/api/types"
import { SchemaForm } from "@/components/SchemaForm"
import { OPTION_GRID, OptionFace } from "@/components/ui/Picker"
import type { Compat } from "@/state/compat"
import { RECIPE_TITLES } from "@/state/compare"
import { fieldTitle } from "@/state/recipeSentence"
import { cn } from "@/lib/utils"

/** A strategy the editor offers: its plain name, a one-line gloss, its code name, and how it sits behind its upstream. */
export interface StrategyChoice {
  name: string
  plain: string
  gloss: string
  /** Soft: tagged Falls back. Hard: tagged Cannot run, and disabled. */
  lock?: Compat
}

/**
 * The one floating editor on the recipe cards. It sits under the value that
 * opened it, laid over the card, so no card changes size. A setting is a
 * SchemaForm over that one field, plus a range when the schema gives both
 * bounds; the strategy is a list of the stage's strategies, each laid out as
 * the Picker's options are: a tick, the name and code name, any tags, and one
 * line of help. Escape, or a
 * press outside the editor and outside a value, closes it; Escape gives focus
 * back to the value.
 */
export function ValueEditor({
  field,
  schema,
  config,
  onChange,
  transform,
  strategies,
  onPick,
  onClose,
}: {
  /** The setting edited, or `transform` for the strategy. */
  field: string
  schema: JsonSchema
  config: Record<string, unknown>
  onChange: (config: Record<string, unknown>) => void
  transform: string
  strategies: StrategyChoice[]
  onPick: (name: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState<number | null>(null)
  const title = field === "transform" ? "Strategy" : fieldTitle(field, schema)
  const prop = schema.properties?.[field]
  // One field of the strategy's schema, so the form shows only it, with its own help and bounds.
  const one = useMemo(() => (prop ? { ...schema, properties: { [field]: prop } } : null), [schema, field, prop])

  // The value that opened the editor, in the same card: the editor sits under it, and Escape gives it focus back.
  const anchor = () => ref.current?.closest("article")?.querySelector<HTMLElement>(`[data-value="${field}"]`) ?? null
  useLayoutEffect(() => {
    const a = anchor()
    if (a) setTop(a.offsetTop + a.offsetHeight + 8)
  }, [field])

  // Focus the editor's control as it opens, so the keyboard is where the change is.
  useEffect(() => {
    const el = ref.current
    const target = el?.querySelector<HTMLElement>("input, select, textarea") ?? el?.querySelector<HTMLElement>('button[aria-pressed="true"]') ?? el?.querySelector<HTMLElement>("button")
    target?.focus({ preventScroll: true })
  }, [field])

  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault()
      anchor()?.focus({ preventScroll: true })
      close.current()
    }
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null
      if (!t || ref.current?.contains(t) || t.closest("[data-value]")) return
      close.current()
    }
    document.addEventListener("keydown", onKey)
    document.addEventListener("pointerdown", onDown)
    return () => {
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("pointerdown", onDown)
    }
  }, [field])

  const bounded = prop && typeof prop.minimum === "number" && typeof prop.maximum === "number"
  return (
    <div
      ref={ref}
      role="dialog"
      // Named by title, not aria-label: the field inside is labelled with the same words.
      title={title}
      className="absolute right-[20px] left-[20px] z-20 flex flex-col gap-3 rounded-panel border border-hairline bg-surface-raised p-3 text-base shadow-sheet"
      style={{ top: top ?? undefined }}
    >
      {field === "transform" ? (
        <>
          <span className="text-sm font-medium">Strategy</span>
          <div className="flex flex-col gap-1">
            {strategies.map((s) => (
              <button
                key={s.name}
                type="button"
                aria-pressed={s.name === transform}
                disabled={s.lock?.kind === "hard"}
                onClick={() => onPick(s.name)}
                className={cn(OPTION_GRID, "hover:bg-surface-elevated disabled:cursor-not-allowed disabled:hover:bg-transparent", s.name === transform && "bg-accent-wash")}
              >
                <OptionFace option={{ value: s.name, name: s.plain, code: s.name, help: s.gloss || undefined, lock: s.lock }} selected={s.name === transform} />
              </button>
            ))}
          </div>
        </>
      ) : one ? (
        <>
          <SchemaForm schema={one} value={config} titles={RECIPE_TITLES} onChange={onChange} />
          {bounded ? (
            <input
              type="range"
              aria-label={`${title} slider`}
              min={prop.minimum}
              max={prop.maximum}
              step={prop.type === "integer" ? 1 : "any"}
              value={typeof config[field] === "number" ? (config[field] as number) : Number(prop.default ?? prop.minimum)}
              onChange={(e) => onChange({ ...config, [field]: Number(e.target.value) })}
              className="w-full accent-(--accent) pointer-coarse:min-h-[44px]"
            />
          ) : null}
          <span className="font-mono text-2xs text-fg-muted">{field}</span>
        </>
      ) : null}
    </div>
  )
}
