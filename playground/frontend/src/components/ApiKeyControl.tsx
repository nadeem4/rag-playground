import { useEffect, useId, useRef, useState } from "react"
import { Popover } from "radix-ui"

import { v2 } from "@/api/v2"
import { checkMessage, keyShortLabel, keySourceLabel, PROVIDER_INFO, PROVIDERS, useApiKey, withArticle } from "@/api/apiKey"
import { useDemo } from "@/api/useDemo"
import type { LlmCheck, LlmProvider, LlmServerSource, LlmSettings } from "@/api/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/**
 * The header's "API key" control (plan I-8, I-18). A small panel with one row
 * per provider: where its key for the next run comes from, a Set mark with the
 * key's last 4 characters once one is entered, a password field while none is,
 * and a check that costs no tokens.
 * The custom endpoint has no check: it needs a base URL, which is set on the
 * chat node, so that key is checked when chat runs.
 *
 * The fields have no `name`, and the forms never submit natively, so a key
 * cannot end up in a URL even if a handler failed. Password managers are told
 * to leave them alone.
 */
type Check = { state: "idle" } | { state: "checking" } | { state: "done"; result: LlmCheck } | { state: "error"; message: string }

const NO_KEY = "Add a key for chat answers and the LLM reranker (optional)"

export function ApiKeyControl() {
  const { keys, panelOpen, setPanelOpen } = useApiKey()
  const [server, setServer] = useState<LlmSettings | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)

  // What the server can supply. Re-read on every open: someone may edit .env.
  useEffect(() => {
    let live = true
    v2.modelSources().then(
      (s) => {
        if (!live) return
        setServer(s)
        setServerError(null)
      },
      (err: unknown) => live && setServerError(err instanceof Error ? err.message : String(err)),
    )
    return () => {
      live = false
    }
  }, [panelOpen])

  const short = keyShortLabel(server, keys)
  // On the demo a custom endpoint is refused with a 403, so its key has no use there.
  const demo = useDemo()
  const rows = demo ? PROVIDERS.filter((p) => p !== "custom") : PROVIDERS
  const keysSet = short !== "" && short !== "not set"

  return (
    <Popover.Root open={panelOpen} onOpenChange={setPanelOpen}>
      <Popover.Trigger asChild>
        <Button
          variant="outline"
          size="sm"
          // Wraps rather than pushing the header sideways on a phone with a large root font.
          className="h-auto min-h-(--row-compact) max-w-full py-1 whitespace-normal"
          data-testid="api-key-button"
          title={keysSet ? undefined : NO_KEY}
          aria-label={keysSet ? undefined : NO_KEY}
        >
          {keysSet ? (
            <>
              API key
              <span className="font-mono text-2xs text-fg">{short}</span>
            </>
          ) : (
            // A key is only needed for a written answer, so no key is not a problem.
            // The words are just Key at every width, so the header stays one row from md
            // up; the title and the accessible name keep the whole sentence.
            "Key"
          )}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          aria-label="API keys"
          className="z-10 flex w-[360px] flex-col rounded-panel border border-hairline bg-surface-elevated text-fg"
        >
          {serverError ? (
            <p className="px-3 pt-3 font-mono text-2xs break-words text-fg-muted">Could not ask the server which keys it has: {serverError}</p>
          ) : null}
          {rows.map((p) => (
            <KeyRow key={p} provider={p} server={server?.[p] ?? null} />
          ))}
          <p className="border-t border-hairline px-3 py-2 text-xs text-fg-muted" data-testid="key-privacy">
            The key stays in this tab's memory. It is never saved, and a reload clears it. It is sent only to this app's server.
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function KeyRow({ provider, server }: { provider: LlmProvider; server: LlmServerSource | null }) {
  const { keys, setKey } = useApiKey()
  const key = keys[provider]
  const [draft, setDraft] = useState("")
  const [editing, setEditing] = useState(false)
  const [check, setCheck] = useState<Check>({ state: "idle" })
  const id = useId()
  const name = PROVIDER_INFO[provider].name
  const boxRef = useRef<HTMLInputElement>(null)
  const replaceRef = useRef<HTMLButtonElement>(null)
  const moveFocus = useRef(false)
  // Counts key changes and checks, so a check that finishes late is ignored.
  const checkId = useRef(0)

  // A key counts as set when this tab has one or the server does. Until the
  // server answers, a row without a tab key is treated as having none.
  const isSet = key !== null || (server !== null && server !== "none")
  const showBox = !isSet || editing

  // A draft does not outlive its box. After a click here, focus follows the
  // change: into the box when it opens, onto the button that took its place.
  useEffect(() => {
    if (!showBox) setDraft("")
    if (!moveFocus.current) return
    moveFocus.current = false
    if (showBox) boxRef.current?.focus()
    else replaceRef.current?.focus()
  }, [showBox, key])

  const close = () => {
    moveFocus.current = true
    setEditing(false)
  }
  const apply = () => {
    const k = draft.trim()
    if (!k) return
    setKey(provider, k)
    checkId.current++
    setCheck({ state: "idle" })
    close()
  }
  const remove = () => {
    setKey(provider, null)
    moveFocus.current = true
    checkId.current++
    setEditing(false)
    setCheck({ state: "idle" })
  }
  const runCheck = async () => {
    const mine = ++checkId.current
    setCheck({ state: "checking" })
    try {
      const result = await v2.checkModel(provider, { keys })
      if (mine === checkId.current) setCheck({ state: "done", result })
    } catch (err) {
      if (mine === checkId.current) setCheck({ state: "error", message: err instanceof Error ? err.message : String(err) })
    }
  }
  const shown = check.state === "done" ? checkMessage(provider, check.result) : null

  return (
    <section role="group" aria-label={name} className="flex flex-col gap-2 border-b border-hairline p-3 last-of-type:border-b-0">
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2">
          {showBox ? (
            <label htmlFor={`${id}-key`} className="text-sm font-medium">
              {name} API key
            </label>
          ) : (
            <span className="text-sm font-medium">{name} API key</span>
          )}
          {isSet ? <span className="meta">Set</span> : provider === "custom" ? <span className="meta">optional</span> : null}
        </div>
        <p className="text-xs text-fg-muted" data-testid="key-source">
          {keySourceLabel(provider, server, key)}
        </p>
      </div>
      {showBox ? (
        <form
          className="flex items-center gap-2"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault()
            apply()
          }}
        >
          <Input
            id={`${id}-key`}
            ref={boxRef}
            type="password"
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore=""
            data-lpignore="true"
            className="font-mono"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button type="submit" variant="outline" size="sm" disabled={!draft.trim()}>
            Apply
          </Button>
          {editing ? (
            <Button type="button" variant="ghost" size="sm" onClick={close}>
              Cancel
            </Button>
          ) : null}
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {provider === "custom" ? null : (
            <Button type="button" variant="outline" size="sm" disabled={check.state === "checking"} onClick={() => void runCheck()}>
              {check.state === "checking" ? "Checking" : "Check key"}
            </Button>
          )}
          <Button ref={replaceRef} type="button" variant="ghost" size="sm" onClick={() => {
              moveFocus.current = true
              setEditing(true)
            }}>
            {key !== null ? "Replace" : "Use another key for this tab"}
          </Button>
          {key !== null ? (
            <Button type="button" variant="ghost" size="sm" onClick={remove}>
              Remove
            </Button>
          ) : null}
        </div>
      )}
      {provider === "custom" ? (
        // The server's check needs the endpoint's URL, which lives on a chat
        // node, not here. The run itself is the check.
        <p className="text-xs text-fg-muted">Checked when chat runs against your endpoint.</p>
      ) : (
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
      )}
    </section>
  )
}

/** Under a chat failure that is about the key: one click to the control. Names the provider when it is known. */
export function KeyHint({ provider }: { provider?: LlmProvider | null }) {
  const { setPanelOpen } = useApiKey()
  return (
    <p className="text-xs text-fg-muted" data-testid="key-hint">
      {provider ? `This model needs ${withArticle(provider)} API key.` : "This step needs an API key."}{" "}
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
