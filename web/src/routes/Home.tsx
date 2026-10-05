import { useEffect, useRef, useState } from "react"

import { api } from "@/api/client"
import { useAppSettings } from "@/api/useDemo"
import { Clip } from "@/components/Clip"
import { Button } from "@/components/ui/button"
import { useUpload } from "@/components/useUpload"
import { cn } from "@/lib/utils"
import { loadSampleDocument, openDocumentMenu, useDocument, type DocumentState } from "@/state/document"

/**
 * Home: the front page. A plain promise, the six steps the site lets you look
 * inside, then one section per page (Build, Compare, Evaluate), each with a
 * short clip of the real site and a button that opens the page with a sample
 * already loaded, so the first click runs something real. A visitor who
 * already has a document keeps it. The hero also takes the visitor's own PDF,
 * and each section says which document its page will use.
 */

const REPO = "https://github.com/nadeem4/rag-playground"

const STEPS = [
  { name: "Document", what: "a sample or your PDF" },
  { name: "Parse", what: "text, tables, headings" },
  { name: "Clean", what: "headers and footers out" },
  { name: "Chunk", what: "the pieces you search" },
  { name: "Index", what: "meaning and keywords" },
  { name: "Ask", what: "search, rerank, answer" },
]

interface PageSection {
  id: string
  page: string
  href: string
  heading: string
  what: string
  points: [string, string]
  clip: { src: string; srcDark: string; poster: string; posterDark: string; label: string; caption: string }
}

const PAGES: PageSection[] = [
  {
    id: "build",
    page: "Build",
    href: "/build",
    heading: "Build a pipeline and ask it",
    what: "Pick how each step works, build the index, then ask a question. You see the pieces it found and how the reranker reordered them.",
    points: ["Every step names the real library and setting it uses.", "The rerank is drawn as lines from search order to final order."],
    clip: {
      src: "/clips/build.webm",
      srcDark: "/clips/build-dark.webm",
      poster: "/clips/build.jpg",
      posterDark: "/clips/build-dark.jpg",
      label: "Clip: building the index and asking a question on Build",
      caption: "Build the index, ask, and watch the rerank",
    },
  },
  {
    id: "compare",
    page: "Compare",
    href: "/compare",
    heading: "Compare recipes on the same document",
    what: "Run one step several ways at once, such as three chunk sizes or three searches, and read what changed in one sentence.",
    points: ["Save the set as an experiment and come back to it.", "Up to ten recipes; open any three side by side."],
    clip: {
      src: "/clips/compare.webm",
      srcDark: "/clips/compare-dark.webm",
      poster: "/clips/compare.jpg",
      posterDark: "/clips/compare-dark.jpg",
      label: "Clip: running three recipes on Compare and reading what changed",
      caption: "Run three recipes and read what changed",
    },
  },
  {
    id: "evaluate",
    page: "Evaluate",
    href: "/evaluate",
    heading: "Evaluate it on real questions",
    what: "Score the pipeline on the sample's questions, or your own, and open any miss to see the sentence it should have found.",
    points: ["Change one step and it says which questions moved.", "Every miss gives its reason in a sentence."],
    clip: {
      src: "/clips/evaluate.webm",
      srcDark: "/clips/evaluate-dark.webm",
      poster: "/clips/evaluate.jpg",
      posterDark: "/clips/evaluate-dark.jpg",
      label: "Clip: scoring the pipeline and opening a miss on Evaluate",
      caption: "Run the questions, change Parse, open a miss",
    },
  },
]

const MORE = [
  { label: "Read", href: "/read", what: "Twenty posts on each step, in pipeline order, for when you want the why." },
  { label: "Run it on your machine", href: `${REPO}#quick-start`, what: "One command, your own files, nothing expires." },
  { label: "Source on GitHub", href: REPO, what: "Every step is a plugin you can read and change." },
]

const goTo = (href: string) => window.location.assign(href)

/**
 * Open `href` with a document ready: when the visitor has none, load the
 * first sample first. A sample that cannot be loaded still opens the page,
 * which then says how to pick a document.
 */
function useOpenWithSample(navigate: (href: string) => void) {
  const { doc, samples } = useDocument()
  const [busy, setBusy] = useState<string | null>(null)
  const open = async (href: string) => {
    if (busy) return
    setBusy(href)
    try {
      if (!doc) {
        const first = (samples ?? (await api.samples()))[0]
        if (first) await loadSampleDocument(first)
      }
    } catch {
      // The page itself offers the samples and an upload.
    }
    navigate(href)
  }
  return { open, busy }
}

/**
 * The line under each "Try it yourself": which document the page will use.
 * Nothing while the document is checked, so a slow list never flickers.
 */
function documentLine({ doc, status, samples }: Pick<DocumentState, "doc" | "status" | "samples">, demo: boolean) {
  if (status === "checking") return null
  if (status === "missing") return { text: `${doc?.filename} is no longer on ${demo ? "the demo" : "this machine"}.`, stale: true }
  if (!doc) {
    const first = samples?.[0]
    return first ? { text: `On the sample: ${first.filename}`, stale: false } : null
  }
  const sample = samples?.some((s) => s.sha === doc.sha) ?? false
  return { text: `${sample ? "On the sample" : "On your file"}: ${doc.filename}`, stale: false }
}

export function Home({ navigate = goTo }: { navigate?: (href: string) => void } = {}) {
  const { open, busy } = useOpenWithSample(navigate)
  const current = useDocument()
  const settings = useAppSettings()
  const demo = settings?.demo === true
  const limits = demo ? settings?.limits : undefined
  const { upload, busy: uploading, error: uploadError } = useUpload()
  const fileRef = useRef<HTMLInputElement>(null)
  const ownRef = useRef<HTMLButtonElement>(null)
  // After a refused upload, focus goes back to the button once it is enabled again.
  const [refocus, setRefocus] = useState(false)
  useEffect(() => {
    if (refocus && uploading === null) {
      setRefocus(false)
      ownRef.current?.focus()
    }
  }, [refocus, uploading])

  async function uploadOwn(file: File | undefined) {
    if (!file) return
    if (await upload(file)) navigate("/build")
    else setRefocus(true)
  }

  const limitsLine =
    settings === null
      ? null
      : limits
        ? `Up to ${limits.max_pages} pages and ${Math.round(limits.max_bytes / 1048576)} MB. Private to your browser and deleted after ${limits.ttl_hours} hours.`
        : demo
          ? null
          : "Your file stays on this machine."
  const line = documentLine(current, demo)
  const waiting = busy !== null || uploading !== null || current.sampleLoading !== null

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-surface">
      <main className="mx-auto grid max-w-[1080px] gap-8 px-4 pt-8 pb-8">
        <section aria-labelledby="home-title" className="grid max-w-[760px] gap-4">
          <span className="text-xs font-[700] tracking-[0.06em] text-primary uppercase">Retrieval, made visible</span>
          <h1 id="home-title" className="m-0 text-[clamp(2rem,4.2vw,3.1rem)] leading-[1.08] font-semibold tracking-[-0.02em] text-balance">
            See why a RAG pipeline finds the answer, or misses it.
          </h1>
          <p className="m-0 max-w-[58ch] text-[1.1875rem] leading-[1.55] text-fg-muted">
            Load a PDF, cut it into pieces, search it and ask it a question. Every step shows what it did to your document, so you can change one
            setting and watch the answer move.
          </p>
          <div className="mt-1 grid gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                size={null}
                className="h-[44px] px-4 text-base font-semibold"
                busy={busy === "/build"}
                disabled={waiting}
                onClick={() => void open("/build")}
              >
                Try a sample
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,application/pdf"
                className="sr-only"
                tabIndex={-1}
                aria-label="Choose your own PDF"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ""
                  void uploadOwn(file)
                }}
              />
              <Button
                ref={ownRef}
                variant="outline"
                size={null}
                className="h-[44px] px-4 text-base font-semibold"
                busy={uploading !== null}
                disabled={waiting}
                onClick={() => fileRef.current?.click()}
              >
                {uploading ? `Uploading ${uploading}` : "Use your own PDF"}
              </Button>
              <a href="#build" className="inline-flex min-h-[44px] items-center px-2 text-base text-fg-muted underline underline-offset-4 hover:text-fg">
                See how it works
              </a>
            </div>
            {uploadError ? (
              <p role="alert" className="m-0 text-sm break-words text-danger">
                {uploadError}
              </p>
            ) : null}
            {limitsLine ? <p className="m-0 text-sm text-fg-muted">{limitsLine}</p> : null}
          </div>
          <ul className="m-0 flex list-none flex-wrap gap-x-6 gap-y-1 p-0 text-sm text-fg-muted">
            {["No sign in", "Runs on samples or your own PDF", "A key is only needed for chat answers"].map((f) => (
              <li key={f} className="flex items-center gap-2">
                <span aria-hidden className="size-[6px] shrink-0 rounded-full bg-primary" />
                {f}
              </li>
            ))}
          </ul>
        </section>

        <ol aria-label="The steps you can look inside" className="m-0 grid list-none grid-cols-2 gap-2 p-0 md:grid-cols-3 lg:grid-cols-6">
          {STEPS.map((s) => (
            <li key={s.name} className="grid min-w-0 gap-1 rounded-panel border border-hairline bg-surface-raised px-3 py-2">
              <span className="text-sm font-semibold">{s.name}</span>
              <span className="text-xs text-fg-muted">{s.what}</span>
            </li>
          ))}
        </ol>

        {PAGES.map((p, i) => {
          const flip = i % 2 === 1
          return (
            <section
              key={p.id}
              id={p.id}
              aria-labelledby={`home-${p.id}`}
              className={cn(
                "grid scroll-mt-4 grid-cols-1 items-center gap-4 lg:gap-8",
                flip ? "lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]" : "lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]",
              )}
            >
              <div data-copy className={cn("grid content-start gap-3", flip && "lg:order-2")}>
                <span className="font-mono text-xs font-semibold text-fg-muted">{i + 1} of 3</span>
                <h2 id={`home-${p.id}`} className="m-0 text-xl font-semibold tracking-[-0.01em]">
                  {p.heading}
                </h2>
                <p className="m-0 max-w-[46ch] text-base">{p.what}</p>
                <ul className="m-0 grid list-disc gap-1 pl-4 text-[1rem] text-fg-muted">
                  {p.points.map((pt) => (
                    <li key={pt}>{pt}</li>
                  ))}
                </ul>
                <div className="mt-1 grid justify-items-start">
                  <Button size={null} className="h-[44px] px-4 text-base font-semibold" busy={busy === p.href} onClick={() => void open(p.href)}>
                    Try it yourself on {p.page}
                  </Button>
                  {line ? (
                    <p
                      data-testid="home-document"
                      className={cn("m-0 flex flex-wrap items-center gap-x-2 text-sm", line.stale ? "text-stale" : "text-fg-muted")}
                    >
                      <span className="min-w-0 [overflow-wrap:anywhere]">{line.text}</span>
                      <button
                        type="button"
                        aria-label={`Change the document for ${p.page}`}
                        className="inline-flex min-h-[44px] items-center font-semibold underline underline-offset-4 hover:text-fg"
                        onClick={openDocumentMenu}
                      >
                        Change
                      </button>
                    </p>
                  ) : null}
                </div>
              </div>
              <Clip {...p.clip} />
            </section>
          )
        })}

        <section aria-label="More" className="grid grid-cols-1 gap-4 border-t border-hairline pt-8 md:grid-cols-3">
          {MORE.map((m) => (
            <div key={m.label}>
              <a href={m.href} className="inline-flex min-h-[44px] items-center text-base font-semibold text-primary">
                {m.label}
              </a>
              <p className="m-0 text-sm text-fg-muted">{m.what}</p>
            </div>
          ))}
        </section>
      </main>
      <footer className="mx-auto flex max-w-[1080px] flex-wrap gap-x-4 gap-y-1 border-t border-hairline p-4 text-sm text-fg-muted">
        <span>RAG Playground</span>
        <a href="/privacy" className="text-fg-muted hover:text-fg">
          Your data and privacy
        </a>
        <a href={REPO} className="text-fg-muted hover:text-fg">
          GitHub
        </a>
      </footer>
    </div>
  )
}
