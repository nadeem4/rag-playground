import { useEffect, useId, useRef, useState } from "react"
import { X } from "lucide-react"

import { CONTROL } from "@/components/fields/types"
import { LINK_BUTTON } from "@/components/inspectors/EvidenceSlip"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { SavedExperiment } from "@/state/experiments"

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]
const word = (n: number) => WORDS[n] ?? String(n)

/** `today at 9:41`, or the day and month for an older save. */
function when(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toDateString() === new Date().toDateString()
    ? `today at ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : d.toLocaleDateString([], { day: "numeric", month: "short" })
}

const stepName = (stage: string) => stage.charAt(0).toUpperCase() + stage.slice(1)

/**
 * Two buttons in Compare's tools row, each with a floating sheet: the
 * experiments saved in this browser, to open or delete, and Save experiment,
 * which names the step, the recipes and the document. Escape, or a press
 * outside, closes a sheet and gives its button focus back.
 */
export function ExperimentMenu({
  experiments,
  usable,
  current,
  edited,
  suggestedName,
  recipeCount,
  onOpen,
  onDelete,
  onSave,
  onSaveAsNew,
  onSaveChanges,
}: {
  experiments: SavedExperiment[]
  /** Whether this server has every strategy the experiment names. */
  usable: (e: SavedExperiment) => boolean
  /** The experiment open on the page. */
  current: { id: string; name: string } | null
  /** The page differs from the open experiment as saved. */
  edited: boolean
  suggestedName: string
  recipeCount: number
  onOpen: (e: SavedExperiment) => void
  onDelete: (e: SavedExperiment) => void
  onSave: (name: string) => void
  onSaveAsNew: (name: string) => void
  onSaveChanges: () => void
}) {
  const [sheet, setSheet] = useState<"list" | "save" | null>(null)
  const [name, setName] = useState("")
  const listButton = useRef<HTMLButtonElement>(null)
  const saveButton = useRef<HTMLButtonElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const nameId = useId()

  const close = (focus: boolean) => {
    const back = sheet === "list" ? listButton.current : saveButton.current
    setSheet(null)
    if (focus) back?.focus({ preventScroll: true })
  }
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    if (!sheet) return
    sheetRef.current?.querySelector<HTMLElement>("input, button")?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        closeRef.current(true)
      }
    }
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (!t || sheetRef.current?.contains(t) || listButton.current?.contains(t) || saveButton.current?.contains(t)) return
      closeRef.current(false)
    }
    document.addEventListener("keydown", onKey)
    document.addEventListener("pointerdown", onDown)
    return () => {
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("pointerdown", onDown)
    }
  }, [sheet])

  const toggle = (which: "list" | "save") => {
    if (sheet === which) return close(false)
    if (which === "save") setName(current?.name ?? suggestedName)
    setSheet(which)
  }

  const SHEET = "absolute top-full right-0 z-30 mt-1 flex w-[min(360px,calc(100vw-32px))] flex-col gap-3 rounded-panel border border-hairline bg-surface-raised p-3 text-fg shadow-sheet"

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <Button ref={listButton} variant="ghost" size="sm" aria-expanded={sheet === "list"} onClick={() => toggle("list")} className="pointer-coarse:min-h-[44px]">
          {experiments.length ? `Your experiments (${experiments.length})` : "Your experiments"}
        </Button>
        {sheet === "list" ? (
          <div ref={sheetRef} role="dialog" aria-label="Your experiments" className={SHEET}>
            <h2 className="m-0 text-sm font-semibold">Your experiments</h2>
            {experiments.length ? (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {experiments.map((e) => (
                  <li key={e.id} aria-current={current?.id === e.id ? "true" : undefined} className="flex items-start gap-2">
                    <div className="flex min-w-0 flex-1 flex-col">
                      {usable(e) ? (
                        <button
                          type="button"
                          onClick={() => {
                            setSheet(null)
                            onOpen(e)
                          }}
                          className={cn(LINK_BUTTON, "self-start text-left text-sm underline pointer-coarse:inline-flex pointer-coarse:min-h-[44px] pointer-coarse:items-center")}
                        >
                          {e.name}
                        </button>
                      ) : (
                        <span className="text-sm font-medium text-fg-muted">{e.name}</span>
                      )}
                      <small className="text-xs text-fg-muted">
                        {stepName(e.stage)}, {word(e.recipes.length)} {e.recipes.length === 1 ? "recipe" : "recipes"}, saved {when(e.savedAt)}
                        {usable(e) ? "" : ". Made on another server"}
                      </small>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${e.name}`}
                      title="Delete"
                      onClick={() => {
                        onDelete(e)
                        listButton.current?.focus({ preventScroll: true })
                      }}
                      className="pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px]"
                    >
                      <X aria-hidden strokeWidth={1.75} />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-sm text-fg-muted">None yet. Set up some recipes, then press Save experiment.</p>
            )}
            <p className="m-0 text-xs text-fg-muted">Experiments stay in this browser, like saved pipelines.</p>
          </div>
        ) : null}
      </div>
      <div className="relative">
        <Button ref={saveButton} variant="outline" size="sm" aria-expanded={sheet === "save"} onClick={() => toggle("save")} className="pointer-coarse:min-h-[44px]">
          {current && !edited ? "Saved" : "Save experiment"}
        </Button>
        {sheet === "save" ? (
          <div ref={sheetRef} role="dialog" aria-label="Save experiment" className={SHEET}>
            <label htmlFor={nameId} className="text-sm font-medium">
              Name this experiment
            </label>
            <input id={nameId} type="text" className={CONTROL} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            <p className="m-0 text-xs text-fg-muted">
              Saves the step, all {word(recipeCount)} recipes and the document, in this browser. Results are not saved; running again is quick, because finished steps come
              from the cache.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              {current ? (
                <Button variant="ghost" size="sm" className="pointer-coarse:min-h-[44px]" onClick={() => (close(true), onSaveAsNew(name.trim() || suggestedName))}>
                  Save as new
                </Button>
              ) : null}
              <Button variant="outline" size="sm" className="pointer-coarse:min-h-[44px]" onClick={() => close(true)}>
                Cancel
              </Button>
              <Button
                size="sm"
                className="pointer-coarse:min-h-[44px]"
                onClick={() => {
                  close(true)
                  if (current) onSaveChanges()
                  else onSave(name.trim() || suggestedName)
                }}
              >
                {current ? "Save changes" : "Save experiment"}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
