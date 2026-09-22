import { useEffect, useId, useState } from "react"
import { Popover } from "radix-ui"

import { api } from "@/api/client"
import { checkMessage, keyShortLabel, keySourceLabel, PROVIDER_INFO, PROVIDERS, useApiKey } from "@/api/apiKey"
import type { LlmCheck, LlmProvider, LlmServerSource, LlmSettings } from "@/api/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/**
 * The header's "API key" control (plan I-8, I-18). A small panel with one row
 * per provider: where its key for the next run comes from, a password field
 * that holds a key in this tab's memory, and a check that costs no tokens.
 * The custom endpoint has no check: it needs a base URL, which is set on the
 * chat node, so that key is checked when chat runs.
 *
 * The fields have no `name`, and the forms never submit natively, so a key
 * cannot end up in a URL even if a handler failed. Password managers are told
 * to leave them alone.
 */
type Check = { state: "idle" } | { state: "checking" } | { state: "done"; result: LlmCheck } | { state: "error"; message: string }

export function ApiKeyControl() {
  const { keys, panelOpen, setPanelOpen } = useApiKey()
  const [server, setServer] = useState<LlmSettings | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)

  // What the server can supply. Re-read on every open: someone may edit .env.
  useEffect(() => {
    let live = true
    api.llmSettings().then(
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
          aria-label="API keys"
          className="z-10 flex w-[360px] flex-col rounded-panel border border-hairline bg-surface-elevated text-fg"
        >
          {serverError ? (
            <p className="px-3 pt-3 font-mono text-2xs break-words text-fg-muted">Could not ask the server which keys it has: {serverError}</p>
          ) : null}
          {PROVIDERS.map((p) => (
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
  const [check, setCheck] = useState<Check>({ state: "idle" })
  const id = useId()
  const name = PROVIDER_INFO[provider].name

  const apply = () => {
    const k = draft.trim()
    if (!k) return
    setKey(provider, k)
    setDraft("")
    setCheck({ state: "idle" })
  }
  const clear = () => {
    setKey(provider, null)
    setDraft("")
    setCheck({ state: "idle" })
  }
  const runCheck = async () => {
    setCheck({ state: "checking" })
    try {
      setCheck({ state: "done", result: await api.checkLlm(provider, { keys }) })
    } catch (err) {
      setCheck({ state: "error", message: err instanceof Error ? err.message : String(err) })
    }
  }
  const shown = check.state === "done" ? checkMessage(provider, check.result) : null

  return (
    <section role="group" aria-label={name} className="flex flex-col gap-2 border-b border-hairline p-3 last-of-type:border-b-0">
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor={`${id}-key`} className="text-sm font-medium">
            {name} API key
          </label>
          {provider === "custom" ? <span className="meta">optional</span> : null}
        </div>
        <p className="text-xs text-fg-muted" data-testid="key-source">
          {keySourceLabel(provider, server, key !== null)}
        </p>
      </div>
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
          type="password"
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore=""
          data-lpignore="true"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit" variant="outline" size="sm" disabled={!draft.trim()}>
          Apply
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={key === null && !draft} onClick={clear}>
          Clear
        </Button>
      </form>
      {provider === "custom" ? (
        // The server's check needs the endpoint's URL, which lives on a chat
        // node, not here. The run itself is the check.
        <p className="text-xs text-fg-muted">Checked when chat runs against your endpoint.</p>
      ) : (
        <div className="flex flex-col gap-1">
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
      )}
    </section>
  )
}

/** Under a chat failure that is about the key: one click to the control. */
export function KeyHint() {
  const { setPanelOpen } = useApiKey()
  return (
    <p className="text-xs text-fg-muted" data-testid="key-hint">
      Chat needs an API key for its model.{" "}
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
