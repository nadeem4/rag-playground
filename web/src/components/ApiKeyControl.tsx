import { useEffect, useId, useState } from "react"
import { Popover } from "radix-ui"

import { api } from "@/api/client"
import { checkMessage, keyShortLabel, keySourceLabel, useApiKey } from "@/api/apiKey"
import type { LlmCheck, LlmServerSource } from "@/api/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/**
 * The header's "API key" control (plan I-8). A small panel: where the key for
 * the next run comes from, a password field that holds a key in this tab's
 * memory, and a check that costs no tokens.
 *
 * The field has no `name`, and the form never submits natively, so the key
 * cannot end up in a URL even if a handler failed. Password managers are told
 * to leave it alone.
 */
type Check = { state: "idle" } | { state: "checking" } | { state: "done"; result: LlmCheck } | { state: "error"; message: string }

export function ApiKeyControl() {
  const { key, setKey, panelOpen, setPanelOpen } = useApiKey()
  const [server, setServer] = useState<LlmServerSource | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [check, setCheck] = useState<Check>({ state: "idle" })
  const id = useId()

  // What the server can supply. Re-read on every open: someone may edit .env.
  useEffect(() => {
    let live = true
    api.llmSettings().then(
      (s) => {
        if (!live) return
        setServer(s.source)
        setServerError(null)
      },
      (err: unknown) => live && setServerError(err instanceof Error ? err.message : String(err)),
    )
    return () => {
      live = false
    }
  }, [panelOpen])

  const apply = () => {
    const k = draft.trim()
    if (!k) return
    setKey(k)
    setDraft("")
    setCheck({ state: "idle" })
  }
  const clear = () => {
    setKey(null)
    setDraft("")
    setCheck({ state: "idle" })
  }
  const runCheck = async () => {
    setCheck({ state: "checking" })
    try {
      setCheck({ state: "done", result: await api.checkLlm({ apiKey: key }) })
    } catch (err) {
      setCheck({ state: "error", message: err instanceof Error ? err.message : String(err) })
    }
  }

  const short = keyShortLabel(server, key !== null)
  const shown = check.state === "done" ? checkMessage(check.result) : null

  return (
    <Popover.Root open={panelOpen} onOpenChange={setPanelOpen}>
      <Popover.Trigger asChild>
        <Button variant="outline" size="sm" data-testid="api-key-button">
          API key
          {short ? <span className={cn("font-mono text-2xs", short === "not set" ? "text-fg-muted" : "text-fg")}>{short}</span> : null}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          aria-label="API key"
          className="z-10 flex w-[340px] flex-col gap-3 rounded-panel border border-hairline bg-surface-elevated p-3 text-fg"
        >
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium" data-testid="key-source">
              {keySourceLabel(server, key !== null)}
            </p>
            {serverError && key === null ? (
              <p className="font-mono text-2xs break-words text-fg-muted">Could not ask the server which key it has: {serverError}</p>
            ) : null}
          </div>

          <form
            className="flex flex-col gap-2"
            autoComplete="off"
            onSubmit={(e) => {
              e.preventDefault()
              apply()
            }}
          >
            <div className="flex flex-col gap-1">
              <label htmlFor={`${id}-key`} className="text-sm font-medium">
                Anthropic API key
              </label>
              <Input
                id={`${id}-key`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                data-1p-ignore=""
                data-lpignore="true"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <p className="text-xs text-fg-muted">Held in this tab's memory and sent only to this app's server. Never saved.</p>
            </div>
            <div className="flex items-center gap-2">
              <Button type="submit" variant="outline" size="sm" disabled={!draft.trim()}>
                Apply
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={key === null && !draft} onClick={clear}>
                Clear
              </Button>
            </div>
          </form>

          <div className="flex flex-col gap-1 border-t border-hairline pt-3">
            <Button type="button" variant="outline" size="sm" className="self-start" disabled={check.state === "checking"} onClick={() => void runCheck()}>
              {check.state === "checking" ? "Checking" : "Check key"}
            </Button>
            <div aria-live="polite" data-testid="key-check">
              {shown ? (
                <>
                  <p className={cn("text-xs", shown.ok ? "text-fg" : "text-danger")}>{shown.text}</p>
                  {!shown.ok && check.state === "done" && check.result.error ? (
                    <p className="font-mono text-2xs break-words text-fg-muted">{check.result.error}</p>
                  ) : null}
                </>
              ) : check.state === "error" ? (
                <>
                  <p className="text-xs text-danger">Could not check the key</p>
                  <p className="font-mono text-2xs break-words text-fg-muted">{check.message}</p>
                </>
              ) : null}
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** Under a chat failure that is about the key: one click to the control. */
export function KeyHint() {
  const { setPanelOpen } = useApiKey()
  return (
    <p className="text-xs text-fg-muted" data-testid="key-hint">
      Chat needs an Anthropic API key.{" "}
      <button
        type="button"
        className="text-fg underline underline-offset-2"
        onClick={(e) => {
          e.stopPropagation()
          setPanelOpen(true)
        }}
      >
        Open API key
      </button>
    </p>
  )
}
