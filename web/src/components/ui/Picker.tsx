import { Fragment, useRef, useState, type KeyboardEvent } from "react"
import { Check, ChevronDown } from "lucide-react"
import { Popover } from "radix-ui"

import { cn } from "@/lib/utils"
import type { Compat } from "@/state/compat"

/**
 * A dropdown where each option says what it does: a custom listbox for
 * choosing between ideas (a step's strategy, a pipeline). Closed, it shows the
 * plain name with the code name or the steps under it. Open, each option has
 * a tick when picked, the plain name beside the code name, any tags, and one
 * line of help. Short lists of plain values stay native selects.
 *
 * The list sits in a popover that stays on screen and is full width on a
 * phone. Focus moves to the list, which names its active option through
 * aria-activedescendant: arrow keys move and skip disabled options, Home and
 * End go to the ends, Enter and Space pick, a letter jumps to a name, and
 * Escape closes and gives the trigger focus back.
 */

export type PickerTone = "soft" | "hard" | "plain"

export interface PickerTag {
  label: string
  tone: PickerTone
}

export interface PickerOption {
  value: string
  /** The plain name. */
  name: string
  /** The code name, small and mono beside the name, and under it when closed. */
  code?: string
  /** One line saying what it does. Under the closed name when there is no code name. */
  help?: string
  /** Soft: tagged Falls back. Hard: tagged Cannot run, and disabled. */
  lock?: Compat
  /** Needs an API key and none is present: tagged Needs a key. */
  needsKey?: boolean
  /** Any other tag, such as Edited since saved. */
  tags?: PickerTag[]
  /** Options with a group are listed under its name, in the order given. */
  group?: string
}

export interface PickerProps {
  /** The trigger's id. */
  id: string
  /** The id of the field's label. */
  labelledBy: string
  options: PickerOption[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
}

const TAG: Record<PickerTone, string> = {
  soft: "bg-stale-wash text-stale",
  hard: "bg-danger/15 text-danger",
  plain: "bg-surface-elevated text-fg-muted",
}

export const KEY_NOTE = "Needs an API key. Add one under Key."

const isDisabled = (o: PickerOption) => o.lock?.kind === "hard"

function tagsOf(o: PickerOption): PickerTag[] {
  const out: PickerTag[] = []
  if (o.lock?.kind === "soft") out.push({ label: "Falls back", tone: "soft" })
  if (o.lock?.kind === "hard") out.push({ label: "Cannot run", tone: "hard" })
  if (o.needsKey) out.push({ label: "Needs a key", tone: "plain" })
  return [...out, ...(o.tags ?? [])]
}

/** The note under the closed picker: a lock's reason, or that a key is needed. */
export function PickerNote({ option }: { option?: PickerOption }) {
  const lock = option?.lock
  if (lock?.kind === "soft")
    return (
      <p role="status" data-testid="lock-reason" className="text-xs leading-[1.5] break-words text-stale">
        {lock.reason}
      </p>
    )
  if (lock?.kind === "hard")
    return (
      <p role="alert" data-testid="lock-reason" className="text-xs leading-[1.5] break-words text-danger">
        {lock.reason}
      </p>
    )
  if (option?.needsKey)
    return (
      <p role="status" data-testid="key-note" className="text-xs leading-[1.5] break-words text-fg-muted">
        {KEY_NOTE}
      </p>
    )
  return null
}

/** One option's face: tick, name, code name and tags on one line, help under. Shared with Compare's strategy list. */
export function OptionFace({ option, selected }: { option: PickerOption; selected: boolean }) {
  const tags = tagsOf(option)
  return (
    <>
      <span data-tick aria-hidden className="flex h-[1.25rem] items-center text-primary">
        {selected ? <Check className="size-[14px]" strokeWidth={2.5} /> : null}
      </span>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-px">
        <span data-name className={cn("text-sm font-semibold", isDisabled(option) ? "text-fg-muted" : "text-fg")}>
          {option.name}
        </span>
        {/* The spaces keep the words apart in the option's accessible name; flex ignores them. */}
        {option.code ? (
          <>
            {" "}
            <span className="font-mono text-xs break-all text-fg-muted">{option.code}</span>
          </>
        ) : null}
        {tags.map((t) => (
          <Fragment key={t.label}>
            {" "}
            <span className={cn("rounded-swatch px-[7px] py-px text-2xs font-bold whitespace-nowrap", TAG[t.tone])}>{t.label}</span>
          </Fragment>
        ))}
      </span>
      {option.help ? (
        <>
          {" "}
          <span className="col-start-2 text-xs leading-[1.4] text-fg-muted">{option.help}</span>
        </>
      ) : null}
    </>
  )
}

/** The grid every option face sits in: the tick column, then the words. */
export const OPTION_GRID = "grid min-h-[44px] w-full grid-cols-[18px_minmax(0,1fr)] gap-x-2 gap-y-px rounded-control p-2 text-left pointer-coarse:min-h-[52px]"

export function Picker({ id, labelledBy, options, value, onChange, disabled, className }: PickerProps) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const current = options.find((o) => o.value === value)
  const optId = (i: number) => `${id}-opt-${i}`

  const enabled = options.map((o, i) => (isDisabled(o) ? -1 : i)).filter((i) => i >= 0)

  function show(next: boolean) {
    if (next) {
      const at = options.findIndex((o) => o.value === value)
      setActive(at >= 0 && !isDisabled(options[at]) ? at : (enabled[0] ?? 0))
    }
    setOpen(next)
  }

  function moveTo(i: number) {
    setActive(i)
    document.getElementById(optId(i))?.scrollIntoView?.({ block: "nearest" })
  }

  function pick(i: number) {
    const o = options[i]
    if (!o || isDisabled(o)) return
    setOpen(false)
    triggerRef.current?.focus({ preventScroll: true })
    if (o.value !== value) onChange(o.value)
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!enabled.length) return
    const pos = enabled.indexOf(active)
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      const step = e.key === "ArrowDown" ? 1 : -1
      moveTo(enabled[(pos + step + enabled.length) % enabled.length])
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault()
      moveTo(e.key === "Home" ? enabled[0] : enabled[enabled.length - 1])
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      pick(active)
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const k = e.key.toLowerCase()
      const order = [...enabled.slice(pos + 1), ...enabled.slice(0, pos + 1)]
      const hit = order.find((i) => options[i].name.toLowerCase().startsWith(k))
      if (hit !== undefined) {
        e.preventDefault()
        moveTo(hit)
      }
    }
  }

  // Each group once, in the order its first option comes.
  const groups: { name: string | undefined; items: number[] }[] = []
  options.forEach((o, i) => {
    const last = groups[groups.length - 1]
    if (last && last.name === o.group) last.items.push(i)
    else groups.push({ name: o.group, items: [i] })
  })

  const row = (i: number) => {
    const o = options[i]
    const selected = o.value === value
    return (
      <div
        key={o.value}
        id={optId(i)}
        role="option"
        aria-selected={selected}
        aria-disabled={isDisabled(o)}
        data-active={i === active || undefined}
        onMouseMove={() => (isDisabled(o) || i === active ? undefined : setActive(i))}
        onClick={() => pick(i)}
        className={cn(
          OPTION_GRID,
          "cursor-pointer data-active:bg-muted",
          selected && "bg-accent-wash data-active:bg-accent-wash",
          isDisabled(o) && "cursor-not-allowed",
        )}
      >
        <OptionFace option={o} selected={selected} />
      </div>
    )
  }

  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <Popover.Root open={open} onOpenChange={show}>
        <Popover.Trigger asChild>
          <button
            ref={triggerRef}
            id={id}
            type="button"
            data-picked={value}
            disabled={disabled}
            aria-haspopup="listbox"
            aria-labelledby={`${labelledBy} ${id}`}
            onKeyDown={(e) => {
              if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault()
                show(true)
              }
            }}
            className="grid min-h-[44px] w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 rounded-control border border-field-border bg-field px-[10px] py-[6px] text-left text-sm text-fg hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="truncate font-semibold">{current?.name ?? value}</span>
            <ChevronDown aria-hidden className="row-span-2 size-[16px] text-fg-muted" strokeWidth={1.75} />
            {current?.code ?? current?.help ? (
              <>
                {" "}
                <span className="col-start-1 truncate font-mono text-xs text-fg-muted">{current?.code ?? current?.help}</span>
              </>
            ) : null}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            ref={listRef}
            role="listbox"
            aria-labelledby={labelledBy}
            aria-activedescendant={optId(active)}
            tabIndex={-1}
            align="start"
            sideOffset={6}
            collisionPadding={16}
            onOpenAutoFocus={(e) => {
              e.preventDefault()
              listRef.current?.focus({ preventScroll: true })
            }}
            // Escape belongs to the list: it must not also close a panel or sheet under it.
            onEscapeKeyDown={(e) => {
              e.stopPropagation()
              triggerRef.current?.focus({ preventScroll: true })
            }}
            onKeyDown={onKeyDown}
            className="z-40 flex max-h-[min(420px,var(--radix-popover-content-available-height))] w-[calc(100vw-32px)] flex-col gap-px overflow-y-auto rounded-panel border border-hairline bg-surface-raised p-[6px] text-fg shadow-sheet outline-none md:w-auto md:max-w-[min(480px,calc(100vw-32px))] md:min-w-(--radix-popover-trigger-width)"
          >
            {groups.map((g, gi) =>
              g.name ? (
                <div key={`${g.name}-${gi}`} role="group" aria-label={g.name} className="flex flex-col gap-px">
                  <div aria-hidden className="px-2 pt-2 pb-px text-2xs tracking-[0.05em] text-fg-muted uppercase">
                    {g.name}
                  </div>
                  {g.items.map(row)}
                </div>
              ) : (
                g.items.map(row)
              ),
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {open ? null : <PickerNote option={current} />}
    </div>
  )
}
