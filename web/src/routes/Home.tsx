import { useState } from "react"

import { api } from "@/api/client"
import { Clip } from "@/components/Clip"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { loadSampleDocument, useDocument } from "@/state/document"

/**
 * Home: the front page. A plain promise, the six steps the site lets you look
 * inside, then one section per page (Build, Compare, Evaluate), each with a
 * short clip of the real site and a button that opens the page with a sample
 * already loaded, so the first click runs something real. A visitor who
 * already has a document keeps it.
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
  clip: { src?: string; poster: string; label: string; caption: string }
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
      poster: "/clips/build.jpg",
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
    points: ["Steps the recipes share run once.", "Save the set as an experiment and come back to it."],
    clip: {
      poster: "/clips/compare.jpg",
      label: "A still of the Compare page",
      caption: "Clip coming soon",
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
      poster: "/clips/evaluate.jpg",
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

export function Home({ navigate = goTo }: { navigate?: (href: string) => void } = {}) {
  const { open, busy } = useOpenWithSample(navigate)
  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-surface">
      <div className="mx-auto grid max-w-[1080px] gap-[56px] px-4 pt-8 pb-[64px] md:gap-[72px] md:pt-[48px]">
        <section aria-labelledby="home-title" className="grid max-w-[760px] gap-4">
          <span className="text-xs font-semibold tracking-[0.06em] text-primary uppercase">Retrieval, made visible</span>
          <h1 id="home-title" className="m-0 text-[clamp(2rem,4.2vw,3.1rem)] leading-[1.08] font-semibold tracking-[-0.02em] text-balance">
            See why a RAG pipeline finds the answer, or misses it.
          </h1>
          <p className="m-0 max-w-[58ch] text-[1.1875rem] leading-[1.55] text-fg-muted">
            Load a PDF, cut it into pieces, search it and ask it a question. Every step shows what it did to your document, so you can change one
            setting and watch the answer move.
          </p>
          <div className="mt-1 flex flex-wrap gap-3">
            <Button size={null} className="h-[44px] px-4 text-base font-semibold" busy={busy === "/build"} onClick={() => void open("/build")}>
              Try it on a sample
            </Button>
            <Button asChild variant="outline" size={null} className="h-[44px] px-4 text-base font-semibold">
              <a href="#build">See how it works</a>
            </Button>
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
            <li key={s.name} className="grid min-w-0 gap-[2px] rounded-panel border border-hairline bg-surface-raised px-3 py-2">
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
                "grid scroll-mt-4 grid-cols-1 items-center gap-4 md:gap-8",
                flip ? "md:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]" : "md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]",
              )}
            >
              <div data-copy className={cn("grid content-start gap-3", flip && "md:order-2")}>
                <span className="font-mono text-xs font-semibold text-fg-muted">{i + 1} of 3</span>
                <h2 id={`home-${p.id}`} className="m-0 text-xl font-semibold tracking-[-0.01em]">
                  {p.heading}
                </h2>
                <p className="m-0 max-w-[46ch] text-base">{p.what}</p>
                <ul className="m-0 grid gap-1 pl-[18px] text-sm text-fg-muted">
                  {p.points.map((pt) => (
                    <li key={pt}>{pt}</li>
                  ))}
                </ul>
                <Button
                  size={null}
                  className="mt-1 h-[44px] justify-self-start px-4 text-base font-semibold"
                  busy={busy === p.href}
                  onClick={() => void open(p.href)}
                >
                  Try it yourself on {p.page}
                </Button>
              </div>
              <Clip {...p.clip} />
            </section>
          )
        })}

        <section aria-label="More" className="grid grid-cols-1 gap-4 border-t border-hairline pt-8 md:grid-cols-3">
          {MORE.map((m) => (
            <div key={m.label}>
              <a href={m.href} className="text-base font-semibold text-primary">
                {m.label}
              </a>
              <p className="m-0 mt-1 text-sm text-fg-muted">{m.what}</p>
            </div>
          ))}
        </section>
      </div>
      <footer className="mx-auto flex max-w-[1080px] flex-wrap gap-x-4 gap-y-1 border-t border-hairline p-4 text-sm text-fg-muted">
        <span>RAG Playground</span>
        <a href={`${REPO}#where-your-data-goes`} className="text-fg-muted hover:text-fg">
          Your data and privacy
        </a>
        <a href={REPO} className="text-fg-muted hover:text-fg">
          GitHub
        </a>
      </footer>
    </main>
  )
}
