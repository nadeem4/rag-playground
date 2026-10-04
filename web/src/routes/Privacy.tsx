import { useId, useState, type ReactNode } from "react"

import { api, ApiError } from "@/api/client"
import { useAppSettings } from "@/api/useDemo"
import { SiteFooter } from "@/components/SiteFooter"
import { Button } from "@/components/ui/button"
import { refreshUploads, useDocument } from "@/state/document"
import { LESSONS_ENABLED } from "@/state/lessons"
import { listWords } from "@/state/library"
import { clearExperiments, useExperiments } from "@/state/libraryExperiments"
import { clearPipelines, usePipelines } from "@/state/pipelines"

import "@/components/learn/learn.css"

/**
 * Your data and privacy: what RAG Playground keeps, where and for how long.
 * Every line is true of the code, and names nothing it cannot show:
 *
 * - Uploads: api/demo.py (24 hours, 3 files, 10 MB, 20 pages), deleted by
 *   api/expiry.py, which runs in demo mode only.
 * - The `rag_visitor` cookie: api/visitor.py, one year.
 * - API keys: api/apiKey.tsx keeps them in memory only.
 * - The question set (state/goldSet.ts) and the last evaluation
 *   (state/evaluate.ts) are in sessionStorage; on the demo the server checks a
 *   set and keeps nothing (api/routes/questions.py).
 * - Saved items and the working pipeline: localStorage (state/pipelines.ts,
 *   state/libraryExperiments.ts, state/graph.ts). The Ask panel's side, width
 *   and open or closed: localStorage (components/ask/AskDock.tsx).
 * - Run results: core/storage.py never expires an entry, api/expiry.py deletes
 *   only uploads, and DELETE /api/cache (api/routes/artifacts.py) clears them.
 *   The demo runs without persistent storage: scripts/publish_space.py asks
 *   for none, and the Dockerfile writes them under /data inside the
 *   container, so a restart starts them over. Turning on persistent storage
 *   for the Space would make that line false (see the note in publish_space.py).
 * - Page images: api/routes/pages.py sends an upload's renders as private
 *   and immutable, so the browser may keep them after the upload is deleted.
 */

type Row = [what: string, where: ReactNode, howLong: ReactNode]

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
const mono = (s: string) => <span className="font-mono text-xs">{s}</span>

function FactTable({ title, rows, children }: { title: string; rows: Row[]; children?: ReactNode }) {
  const id = useId()
  return (
    <section className="flex flex-col gap-2">
      <h2 id={id} className="learn-h2">
        {title}
      </h2>
      {children}
      <table aria-labelledby={id} className="w-full border-collapse text-sm">
        <thead className="hidden md:table-header-group">
          <tr className="border-b border-flat text-left text-xs font-semibold text-fg-muted">
            <th className="pr-3 pb-2 font-semibold">What</th>
            <th className="pr-3 pb-2 font-semibold">Where</th>
            <th className="pb-2 font-semibold">How long</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([what, where, howLong]) => (
            <tr key={what} className="grid gap-1 border-b border-hairline py-3 align-top md:table-row md:py-0">
              <td className="font-semibold md:w-[30%] md:py-3 md:pr-3 md:align-top">{what}</td>
              <td className="text-fg-muted md:w-[28%] md:py-3 md:pr-3 md:align-top">{where}</td>
              <td className="md:py-3 md:align-top">{howLong}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function Confirm({ label, children, onYes, onNo, busy }: { label: string; children: ReactNode; onYes: () => void; onNo: () => void; busy?: boolean }) {
  return (
    <div role="group" aria-label={label} className="flex max-w-[560px] flex-col gap-3 rounded-panel border border-hairline bg-surface-raised p-4 shadow-sheet">
      <p className="m-0">{children}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onNo}>
          Cancel
        </Button>
        <Button variant="outline" className="border-danger text-danger" busy={busy} onClick={onYes}>
          Delete them
        </Button>
      </div>
    </div>
  )
}

export function Privacy() {
  const settings = useAppSettings()
  const demo = settings?.demo === true
  const limits = settings?.limits
  const ttl = limits?.ttl_hours ?? 24
  const files = limits?.max_files ?? 3
  const mb = Math.round((limits?.max_bytes ?? 10 * 1024 * 1024) / (1024 * 1024))
  const pages = limits?.max_pages ?? 20
  const { pipelines } = usePipelines()
  const experiments = useExperiments()
  const { uploads, samples } = useDocument()
  // This browser's own uploads: never a sample, so wait for the samples list,
  // and only what has an upload time (a sample never has one).
  const mine = uploads && samples ? uploads.filter((u) => u.uploaded_at && !samples.some((x) => x.sha === u.sha)) : null
  const [asking, setAsking] = useState<"saved" | "uploads" | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  const browserRows: Row[] = [
    ["Saved pipelines and experiments", "In this browser's storage", "Until you delete them here or clear this site's data. They never leave this browser unless you export them or share a link."],
    ["The pipeline you are working on", "In this browser's storage", "Until you change it. It is how Build, Compare and Evaluate share one pipeline."],
    ["Theme and contrast", "In this browser's storage", "Until you change them."],
    ["Where the Ask panel sits on Build", "In this browser's storage", "Its side, its width and whether it is open, until you change them."],
    [
      "Page images you viewed",
      "In this browser's cache",
      "They may stay in this browser's cache until it is cleared, even after the upload they show is deleted.",
    ],
    ...(LESSONS_ENABLED ? [["Which lessons you finished", "In this browser's storage", "Until you clear this site's data."] as Row] : []),
    [
      "A question set you upload for Evaluate",
      demo ? "In this tab only" : "On this machine, beside the document",
      demo ? "Until you close the tab. The demo checks the set and keeps nothing." : "Until you delete it.",
    ],
    ["Your last evaluation, for the before and after", "In this tab only", "Until you close the tab."],
    ["API keys you add", "In this tab's memory only", "Until you close or reload the tab. A key is sent with each request that needs it and is never written to storage, a cookie, a link or a saved file."],
  ]

  const serverRows: Row[] = demo
    ? [
        ["PDFs you upload", "On the demo server, private to this browser", `${ttl} hours, then deleted. At most ${files} files at a time, ${mb} MB and ${pages} pages each.`],
        ["An anonymous browser id", <>A cookie named {mono("rag_visitor")}</>, "One year. It only links your uploads to this browser. It holds no name, email or account."],
        [
          "Run results (pieces, indexes, answers)",
          "On the demo server, as a cache shared by recipe",
          "So a repeat run is quick. Nothing deletes them on a timer, not even when the upload they came from is deleted. They stay until the demo restarts or the cache is cleared, since the demo runs without persistent storage.",
        ],
      ]
    : [
        ["PDFs you upload", <>In the project's {mono("sources")} folder</>, "Until you delete them. Nothing expires on your machine."],
        ["An anonymous browser id", <>A cookie named {mono("rag_visitor")}</>, "One year. On your machine it only marks which browser uploaded a file."],
        ["Run results", <>In the project's {mono("artifacts")} folder, as a cache</>, "Until you clear the cache."],
      ]

  function askSaved() {
    setDone(null)
    if (!pipelines.length && !experiments.length) setDone("There is nothing saved in this browser.")
    else setAsking("saved")
  }

  function deleteSaved() {
    clearPipelines()
    clearExperiments()
    setAsking(null)
    setDone("Deleted every saved pipeline and experiment in this browser.")
  }

  function askUploads() {
    setDone(null)
    if (!mine?.length) setDone("You have no uploads on the demo.")
    else setAsking("uploads")
  }

  async function deleteUploads() {
    setBusy(true)
    const gone: string[] = []
    const failed: string[] = []
    for (const u of mine ?? []) {
      try {
        await api.deleteSource(u.sha)
        gone.push(u.filename)
      } catch (err) {
        const why = err instanceof ApiError && typeof err.detail === "string" ? err.detail : "the server did not answer."
        failed.push(`${u.filename} could not be deleted: ${why}`)
      }
    }
    refreshUploads()
    setBusy(false)
    setAsking(null)
    setDone([gone.length ? `Deleted ${plural(gone.length, "upload")} from the demo.` : "", ...failed].filter(Boolean).join(" "))
  }

  const savedWords = [pipelines.length ? plural(pipelines.length, "saved pipeline") : "", experiments.length ? plural(experiments.length, "experiment") : ""].filter(Boolean)

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-surface">
      <div className="learn-page flex flex-col gap-6">
        <section className="learn-top flex max-w-[680px] flex-col gap-2">
          <h1 className="learn-display">Your data and privacy</h1>
          <p className="learn-lead">
            What RAG Playground keeps, where it keeps it and for how long. There are no accounts and no sign in.{" "}
            {demo ? "This is the hosted demo." : "This copy runs on your machine, so what you add stays on it, except calls to a model provider when you add a key."}
          </p>
        </section>

        {done ? (
          <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-panel bg-accent-wash px-3 py-2">
            <p className="m-0 min-w-0 flex-[1_1_280px]">{done}</p>
            <Button variant="ghost" onClick={() => setDone(null)}>
              Done
            </Button>
          </div>
        ) : null}

        <FactTable title="In this browser" rows={browserRows}>
          <p className="m-0 max-w-[68ch] text-fg-muted">
            Kept on your device.{" "}
            {demo ? "The demo server sees only what a request needs: the pipeline settings with a run, and a question set while it is checked." : null}
          </p>
        </FactTable>

        {settings ? <FactTable title={demo ? "On the demo server" : "On this machine"} rows={serverRows} /> : null}

        <section className="flex flex-col gap-2">
          <h2 className="learn-h2">What is never kept</h2>
          <ul className="m-0 flex flex-col gap-1 pl-4">
            <li>Your API keys, anywhere.</li>
            <li>Your name or email. There is nothing to sign in to.</li>
            <li>{demo ? "Another visitor's uploads in your view, or yours in theirs." : "Anything on a server of ours."}</li>
          </ul>
          {demo ? (
            <p className="m-0 max-w-[68ch] text-fg-muted">
              The demo runs on Hugging Face Spaces, so their{" "}
              <a href="https://huggingface.co/privacy" className="text-primary underline underline-offset-4">
                privacy policy
              </a>{" "}
              and{" "}
              <a href="https://huggingface.co/terms-of-service" className="text-primary underline underline-offset-4">
                terms
              </a>{" "}
              cover the hosting itself.
            </p>
          ) : null}
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="learn-h2">Clean up now</h2>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={askSaved}>
              Delete saved pipelines and experiments
            </Button>
            {demo ? (
              <Button variant="outline" disabled={mine === null} onClick={askUploads}>
                Delete my uploads from the demo
              </Button>
            ) : null}
            <Button variant="ghost" asChild>
              <a href="/library">Export first, in Library</a>
            </Button>
          </div>
          {asking === "saved" ? (
            <Confirm label="Confirm deleting saved items" onYes={deleteSaved} onNo={() => setAsking(null)}>
              This deletes {listWords(savedWords)} in this browser. It cannot be undone. Export them first in Library if you may want them later.
            </Confirm>
          ) : null}
          {asking === "uploads" ? (
            <Confirm label="Confirm deleting uploads" busy={busy} onYes={() => void deleteUploads()} onNo={() => setAsking(null)}>
              This deletes {listWords((mine ?? []).map((u) => u.filename))} from the demo now, instead of after {ttl} hours. Saved items that use{" "}
              {(mine ?? []).length === 1 ? "it" : "them"} stay, and ask for the PDF again when opened.
            </Confirm>
          ) : null}
        </section>
      </div>
      <SiteFooter />
    </main>
  )
}
