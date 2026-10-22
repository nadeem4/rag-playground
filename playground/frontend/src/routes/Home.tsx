import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"

import { api } from "@/api/client"
import { useAppSettings } from "@/api/useDemo"
import { Clip } from "@/components/Clip"
import { Button } from "@/components/ui/button"
import { useUpload } from "@/components/useUpload"
import { cn } from "@/lib/utils"
import { useDocument } from "@/state/document"
import { defaultSample } from "@/state/starter"

/**
 * Home: the front page, for developers building search over their own
 * knowledge. The hero says what they leave with (a Pandion project) beside a
 * real finding from the scanned notes sample. Then the loop as four tabs
 * (Build, Evaluate and Compare each play a clip of the real site, Take it home
 * shows what the zip holds), three ways to start, three lessons, and Pandion
 * itself with a real run's output.
 *
 * The figures on this page are real: the slip's are from
 * docs/lessons-learned.md ("A scanned PDF has no text to read"), and the
 * Pandion terminal is a real `pandion init` project (Text documents and
 * Balanced templates) run on the chunking primer sample.
 */

const REPO = "https://github.com/nadeem4/rag-playground"
const PYPI = "https://pypi.org/project/pandion/"
const PANDION_SOURCE = `${REPO}/tree/main/packages/pandion`
const LESSONS_DOC = `${REPO}/blob/main/docs/lessons-learned.md`

const goTo = (href: string) => window.location.assign(href)

const LINK = "inline-flex min-h-[44px] items-center font-semibold text-primary underline underline-offset-4 hover:text-fg"
const EYEBROW = "text-2xs font-[700] tracking-[0.1em] text-primary uppercase"
const CTA = "min-h-[44px] px-4 text-base font-semibold"

interface Step {
  id: string
  name: string
  what: string
  clip?: { src: string; srcDark: string; poster: string; posterDark: string; label: string; caption: string }
  lead?: string
  note: string
}

const STEPS: Step[] = [
  {
    id: "build",
    name: "Build",
    what: "Parse, clean, chunk and index. Every step card shows its output.",
    clip: {
      src: "/clips/build.webm",
      srcDark: "/clips/build-dark.webm",
      poster: "/clips/build.jpg",
      posterDark: "/clips/build-dark.jpg",
      label: "Clip: building the index and asking a question on Build",
      caption: "Build the index, ask, and watch the rerank",
    },
    lead: "On the sample:",
    // No block count: Docling's count differs between machines (Linux is the source of truth).
    note: "the Parse card shows every block Docling found; the Chunk card shows every piece and where it was cut.",
  },
  {
    id: "evaluate",
    name: "Evaluate",
    what: "Questions you know the answers to. Bring your own, or have a model write them.",
    clip: {
      src: "/clips/evaluate.webm",
      srcDark: "/clips/evaluate-dark.webm",
      poster: "/clips/evaluate.jpg",
      posterDark: "/clips/evaluate-dark.jpg",
      label: "Clip: scoring the pipeline and opening a miss on Evaluate",
      caption: "Run the questions, change Parse, open a miss",
    },
    lead: "New:",
    note: "Write questions for me reads the document and writes questions with their evidence, on your key. You keep, edit or drop each one.",
  },
  {
    id: "compare",
    name: "Compare",
    what: "Recipes side by side: found, time, tokens and cost.",
    clip: {
      src: "/clips/compare.webm",
      srcDark: "/clips/compare-dark.webm",
      poster: "/clips/compare.jpg",
      posterDark: "/clips/compare-dark.jpg",
      label: "Clip: running three recipes on Compare and reading what changed",
      caption: "Run three recipes and read what changed",
    },
    lead: "Fair numbers:",
    note: "time, tokens and cost count only the step you changed and the steps after it, so the run order never decides the winner.",
  },
  {
    id: "home",
    name: "Take it home",
    what: "The winning pipeline as a small Python project.",
    note: "The same settings you used here, your questions and the scores to beat. Never your key or your documents.",
  },
]

const ZIP_FILES = ["pipeline.yaml", "run.py", "questions.json", "requirements.txt", "README.md", "docs/"]

const LESSONS = [
  // `anchor` is GitHub's heading anchor for the entry in docs/lessons-learned.md.
  {
    stage: "Parsing",
    title: "pdfium gave us lines, not paragraphs",
    anchor: "pdfium-gave-us-lines-not-paragraphs",
    line: "The chunker can only cut at breaks the parser gives it.",
  },
  {
    stage: "Retrieval",
    title: "The question used words the document never uses",
    anchor: "the-question-used-words-the-document-never-uses",
    line: "Why a rewrite step finds what plain search misses.",
  },
  {
    stage: "Caching",
    title: "A new rewrite was searched with the old results",
    anchor: "a-new-rewrite-was-searched-with-the-old-results",
    line: "A cache key that forgets one input serves yesterday's answer.",
  },
]

/** A terminal block: `#` lines are comments, `$` lines are commands, the rest is output. */
function Terminal({ label, lines }: { label: string; lines: string[] }) {
  return (
    // Focusable, so a keyboard can scroll it sideways on a phone.
    <pre
      aria-label={label}
      tabIndex={0}
      className="m-0 min-w-0 overflow-x-auto rounded-panel border border-hairline bg-surface-elevated p-4 font-mono text-xs leading-[1.75] text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)"
    >
      {lines.map((l, i) => (
        <span key={i} className="block">
          {l.startsWith("#") ? (
            <span className="text-fg-muted">{l}</span>
          ) : l.startsWith("$ ") ? (
            <>
              <span className="text-primary">$</span>
              {l.slice(1)}
            </>
          ) : (
            l
          )}
        </span>
      ))}
    </pre>
  )
}

function Section({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn("scroll-mt-4 border-t border-hairline py-8", className)}>
      {children}
    </section>
  )
}

function SectionTitle({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={`${id}-title`} className="m-0 text-xl font-semibold tracking-[-0.01em] text-balance">
      {children}
    </h2>
  )
}

/** Eight questions, as eight marks: filled when found. */
function Dots({ found }: { found: boolean }) {
  return (
    <span aria-hidden className="flex gap-1">
      {Array.from({ length: 8 }, (_, i) => (
        <span
          key={i}
          className={cn("size-[14px] rounded-[4px] border", found ? "border-primary bg-primary" : "border-removed-mark bg-removed")}
        />
      ))}
    </span>
  )
}

function FindingSlip() {
  return (
    <figure
      aria-label="A real finding from the scanned notes sample"
      className="m-0 grid min-w-0 gap-4 rounded-panel border border-hairline bg-surface-raised p-6 shadow-raised"
    >
      <span className="text-2xs font-[700] tracking-[0.1em] text-fg-muted uppercase">A real finding</span>
      <p className="m-0 font-serif text-lg">Eight questions about a scanned page of notes. Same pieces, same search. One setting changed.</p>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 text-sm md:grid-cols-[auto_minmax(0,1fr)_auto]">
        <span className="col-span-2 text-fg-muted md:col-span-1">Docling, OCR off</span>
        <Dots found={false} />
        <span className="font-semibold whitespace-nowrap text-removed-text tabular-nums">0 of 8</span>
        <span className="col-span-2 text-fg-muted md:col-span-1">Docling, OCR on</span>
        <Dots found />
        <span className="font-semibold whitespace-nowrap tabular-nums">8 of 8</span>
      </div>
      <p className="m-0 border-t border-hairline pt-3 text-sm">
        A scan is pictures of pages, so there was no text to search. Nothing failed loudly: the parse was just empty. The Parse card shows it in one
        look.
      </p>
      <a href={`${LESSONS_DOC}#a-scanned-pdf-has-no-text-to-read`} className="text-xs text-fg-muted underline underline-offset-4 hover:text-fg">
        From the scanned notes sample. Lessons learned, Parsing.
      </a>
    </figure>
  )
}

/** The four steps as tabs: arrow keys move between them, Home and End jump to the ends. */
function Loop() {
  const [active, setActive] = useState(0)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const step = STEPS[active]

  const select = (i: number) => {
    const next = (i + STEPS.length) % STEPS.length
    setActive(next)
    tabs.current[next]?.focus()
  }
  const onKey = (e: KeyboardEvent, i: number) => {
    const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: STEPS.length - 1 }[e.key]
    if (to === undefined) return
    e.preventDefault()
    select(to)
  }

  return (
    <div className="mt-6 grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-8">
      <div
        role="tablist"
        aria-label="From your files to a project you own"
        className="flex min-w-0 gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0"
      >
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            ref={(el) => {
              tabs.current[i] = el
            }}
            id={`home-tab-${s.id}`}
            type="button"
            role="tab"
            aria-selected={i === active}
            aria-controls="home-step-panel"
            tabIndex={i === active ? 0 : -1}
            onClick={() => setActive(i)}
            onKeyDown={(e) => onKey(e, i)}
            className={cn(
              "grid w-[13rem] shrink-0 grid-cols-[2rem_minmax(0,1fr)] content-start gap-x-2 rounded-panel border px-4 py-3 text-left lg:w-auto",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)",
              i === active ? "border-hairline bg-surface-raised shadow-raised" : "border-transparent hover:bg-surface-hover",
            )}
          >
            <span aria-hidden className="row-span-2 pt-1 font-mono text-sm text-primary">
              {String(i + 1).padStart(2, "0")}
            </span>
            <strong className="text-base font-semibold">{s.name}</strong>
            <span className="text-sm text-fg-muted">{s.what}</span>
          </button>
        ))}
      </div>
      <div id="home-step-panel" role="tabpanel" aria-labelledby={`home-tab-${step.id}`} className="grid min-w-0 gap-3">
        {step.clip ? (
          <>
            <Clip key={step.id} {...step.clip} />
            <p className="m-0 text-sm">
              <b className="font-semibold">{step.lead}</b> {step.note}
            </p>
          </>
        ) : (
          <>
            <Terminal
              label="What the zip holds"
              lines={[
                "# starter.zip, from Build's Take it home",
                "$ unzip starter.zip && cd starter",
                "$ pip install -r requirements.txt",
                "$ cp ~/Documents/handbook.pdf docs/",
                "$ python run.py",
              ]}
            />
            <ul aria-label="The files in the zip" className="m-0 flex list-none flex-wrap gap-2 p-0">
              {ZIP_FILES.map((f) => (
                <li key={f} className="rounded-swatch border border-hairline bg-surface-raised px-2 py-1 font-mono text-xs">
                  {f}
                </li>
              ))}
            </ul>
            <p className="m-0 text-sm">{step.note}</p>
          </>
        )}
      </div>
    </div>
  )
}

export function Home({ navigate = goTo }: { navigate?: (href: string) => void } = {}) {
  const current = useDocument()
  const settings = useAppSettings()
  const demo = settings?.demo === true
  const limits = demo ? settings?.limits : undefined
  const { upload, addLink, busy: uploading, error: uploadError, limitsLine, linkLine, accept } = useUpload()
  const [link, setLink] = useState("")
  // The upload error is shared with the link box: it shows beside whichever one was used last.
  const [errorAt, setErrorAt] = useState<"upload" | "link">("upload")
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
    setErrorAt("upload")
    if (await upload(file)) navigate("/build")
    else setRefocus(true)
  }

  /** Add a document from a link, the way the Document menu does, then open Build. */
  async function submitLink() {
    if (waiting || !link.trim()) return
    setErrorAt("link")
    if (await addLink(link)) navigate("/build")
  }

  /** Try a sample: Build opens the Starter pipeline on the default sample, whatever is loaded now. */
  async function tryStarter() {
    let card = defaultSample(current.samples)
    if (!card) {
      try {
        card = defaultSample(await api.samples())
      } catch {
        // Build then opens the Starter itself, or asks for a document.
      }
    }
    navigate(card ? `/build?starter=${encodeURIComponent(card.name)}` : "/build")
  }
  const waiting = uploading !== null || current.sampleLoading !== null

  // Private to the browser is true only on the demo; locally the files never leave the machine.
  const filesFact = settings === null ? null : demo ? "Your files stay private to your browser" : "Your files stay on this machine."
  const facts = ["No sign in", filesFact, "A key is needed only for model steps"].filter((f): f is string => f !== null)
  const whereFilesStay =
    settings === null
      ? null
      : limits
        ? `On this demo your files stay private to your browser and are deleted after ${limits.ttl_hours} hours.`
        : demo
          ? null
          : "Running on your own machine, your files never leave it."

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-surface">
      <main className="mx-auto max-w-[1160px] px-4">
        <section aria-labelledby="home-title" className="grid grid-cols-1 items-center gap-8 py-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
          <div className="grid min-w-0 content-start gap-4">
            <span className={EYEBROW}>For developers building search over their own knowledge</span>
            <h1 id="home-title" className="m-0 text-[clamp(2rem,4.4vw,3.25rem)] leading-[1.08] font-semibold tracking-[-0.02em] text-balance">
              Tune a RAG pipeline on your own knowledge, then take it home.
            </h1>
            <p className="m-0 max-w-[34rem] text-[1.1875rem] leading-[1.55] text-fg-muted">
              Bring your documents, web pages or photos of pages. See what every step does to them, score the search with questions you know the answers
              to, and compare recipes on what they find, how long they take and what they cost.
            </p>
            <p className="m-0 grid max-w-[34rem] gap-1 border-l-[3px] border-primary py-1 pl-4 text-base">
              <span className={EYEBROW}>You leave with</span>
              <span>
                a Python project that runs the winning pipeline on your computer, with your questions and the scores to beat. It is built on{" "}
                <strong className="font-semibold">Pandion</strong>, the open source engine behind this site.
              </span>
            </p>
            <div className="grid gap-2">
              <div className="flex flex-wrap items-center gap-3">
                <Button size={null} className={CTA} disabled={waiting} onClick={() => void tryStarter()}>
                  Try a sample
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept={accept}
                  className="sr-only"
                  tabIndex={-1}
                  aria-label="Choose your own files"
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
                  className={CTA}
                  busy={uploading !== null}
                  disabled={waiting}
                  onClick={() => fileRef.current?.click()}
                >
                  {/* The header names the file; a long name here would push the button past a phone's edge. */}
                  {uploading ? (uploading.startsWith("Fetching") ? "Fetching" : "Uploading") : "Use your own files"}
                </Button>
                <a href="#pandion" className={cn(LINK, "px-2")}>
                  See what you take home
                </a>
              </div>
              {uploadError && errorAt === "upload" ? (
                <p role="alert" className="m-0 text-sm break-words text-danger">
                  {uploadError}
                </p>
              ) : null}
              <p className="m-0 text-sm text-fg-muted">{limitsLine}</p>
            </div>
            <ul className="m-0 flex list-none flex-wrap gap-x-6 gap-y-1 p-0 text-sm text-fg-muted">
              {facts.map((f) => (
                <li key={f} className="flex items-center gap-2">
                  <span aria-hidden className="size-[6px] shrink-0 rounded-full bg-primary" />
                  {f}
                </li>
              ))}
            </ul>
          </div>
          <FindingSlip />
        </section>

        <Section id="loop">
          <SectionTitle id="loop">From your files to a project you own</SectionTitle>
          <p className="m-0 mt-3 max-w-[40rem] text-base text-fg-muted">
            Build it, score it, compare it, take it home. Each page hands its work to the next, so one changed setting can be followed all the way to the
            score, and the winner leaves as code.
          </p>
          <Loop />
        </Section>

        <Section id="start">
          <SectionTitle id="start">Start from what you have</SectionTitle>
          <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-3">
            <div className="grid content-start justify-items-start gap-2 border-t-[3px] border-primary pt-3">
              <h3 className="m-0 text-base font-semibold">A sample</h3>
              <p className="m-0 text-sm text-fg-muted">Documents made to show where pipelines go wrong, each with its own questions.</p>
              {current.samples?.length ? (
                <ul aria-label="The samples" className="m-0 flex list-none flex-wrap gap-1 p-0">
                  {current.samples.map((s) => (
                    <li key={s.name} className="rounded-swatch bg-surface-elevated px-2 text-xs">
                      {s.title}
                    </li>
                  ))}
                </ul>
              ) : null}
              <button type="button" disabled={waiting} className={cn(LINK, "disabled:opacity-50")} onClick={() => void tryStarter()}>
                Open a sample on Build
              </button>
            </div>
            <div className="grid content-start justify-items-start gap-2 border-t-[3px] border-primary pt-3">
              <h3 className="m-0 text-base font-semibold">Your own knowledge</h3>
              <p className="m-0 text-sm text-fg-muted">
                PDFs, Word and PowerPoint files, web pages, Markdown, text, or photos of pages read with OCR. Or paste a link.
                {whereFilesStay ? ` ${whereFilesStay}` : null}
              </p>
              <button type="button" disabled={waiting} className={cn(LINK, "disabled:opacity-50")} onClick={() => fileRef.current?.click()}>
                Upload your files
              </button>
              <form
                noValidate
                className="flex w-full gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  void submitLink()
                }}
              >
                <input
                  type="url"
                  value={link}
                  placeholder="https://example.com/guide.html"
                  aria-label="Link to a web page or PDF"
                  // Read-only, not disabled, while something is on its way: focus stays in the box.
                  readOnly={waiting}
                  aria-disabled={waiting || undefined}
                  className="min-h-[44px] min-w-0 flex-1 rounded-control border border-field-border bg-surface px-2 text-sm text-fg outline-none placeholder:text-fg-muted focus-visible:outline-2 focus-visible:outline-(--focus-ring) aria-disabled:opacity-50"
                  onChange={(e) => setLink(e.target.value)}
                />
                <Button type="submit" variant="outline" size={null} className="min-h-[44px] px-4 font-semibold" disabled={waiting || !link.trim()}>
                  Add
                </Button>
              </form>
              {uploadError && errorAt === "link" ? (
                <p role="alert" className="m-0 text-sm break-words text-danger">
                  {uploadError}
                </p>
              ) : null}
              <p className="m-0 text-xs text-fg-muted">{linkLine}</p>
            </div>
            <div className="grid content-start justify-items-start gap-2 border-t-[3px] border-primary pt-3">
              <h3 className="m-0 text-base font-semibold">A template</h3>
              <p className="m-0 text-sm text-fg-muted">
                Ready pipelines for manuals, reports, scans and tables. Pick the index half and the question half, then change one thing.
              </p>
              <a href="/build?templates=1" className={LINK}>
                Start from a template
              </a>
            </div>
          </div>
        </Section>

        <Section id="lessons">
          <SectionTitle id="lessons">What we learned building it</SectionTitle>
          <p className="m-0 mt-3 max-w-[40rem] text-base text-fg-muted">Every real pipeline problem we hit is written up: what broke, why, and what fixed it.</p>
          <ul className="m-0 mt-6 grid list-none grid-cols-1 gap-x-6 p-0 md:grid-cols-3">
            {LESSONS.map((l) => (
              <li key={l.title} className="grid content-start gap-2 border-t border-hairline py-4">
                <span className="text-2xs font-[700] tracking-[0.08em] text-fg-muted uppercase">{l.stage}</span>
                <h3 className="m-0 font-serif text-lg font-semibold">
                  <a href={`${LESSONS_DOC}#${l.anchor}`} className="text-fg underline-offset-4 hover:underline">
                    {l.title}
                  </a>
                </h3>
                <p className="m-0 text-sm text-fg-muted">{l.line}</p>
              </li>
            ))}
          </ul>
          <a href={LESSONS_DOC} className={LINK}>
            Read all the lessons
          </a>
        </Section>

        <Section id="pandion" className="grid grid-cols-1 items-center gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="grid min-w-0 content-start gap-3">
            <span className={EYEBROW}>Pandion</span>
            <SectionTitle id="pandion">The engine is a Python package</SectionTitle>
            <p className="m-0 max-w-[40rem] text-base text-fg-muted">
              Everything this site runs is Pandion, on PyPI. The pipeline you build here is the same YAML it reads.
            </p>
            <ul className="m-0 grid list-disc gap-1 pl-4 text-base text-fg-muted">
              <li>
                Start a project from a template with <code className="font-mono text-sm whitespace-nowrap text-fg">pandion init</code>.
              </li>
              <li>
                Have a model write test questions with <code className="font-mono text-sm whitespace-nowrap text-fg">pandion questions</code>.
              </li>
              <li>
                Fail a CI run when a change loses questions, with <code className="font-mono text-sm whitespace-nowrap text-fg">--baseline</code>.
              </li>
            </ul>
            <div className="flex flex-wrap gap-x-6">
              <a href={PYPI} className={LINK}>
                Pandion on PyPI
              </a>
              <a href={PANDION_SOURCE} className={LINK}>
                Pandion on GitHub
              </a>
            </div>
          </div>
          {/* A real run: `pandion init` with the Text documents and Balanced templates, on the chunking primer sample. */}
          <Terminal
            label="Terminal"
            lines={[
              "# a project from the Text documents and Balanced templates",
              "$ pip install pandion",
              "$ pandion init my-rag --index text --query balanced --questions questions.json",
              "$ cd my-rag && pip install -r requirements.txt",
              "$ cp chunking-primer.pdf docs/",
              "$ python run.py",
              "kept-whole missed. Lost at Rerank. cross_encoder dropped piece 19.",
              "Found 11 of 12 (92%). Mean reciprocal rank 0.92.",
            ]}
          />
        </Section>
      </main>
      <footer className="mx-auto flex max-w-[1160px] flex-wrap gap-x-6 gap-y-1 border-t border-hairline px-4 py-6 text-sm text-fg-muted">
        <span className="inline-flex min-h-[44px] items-center">RAG Playground</span>
        <a href={REPO} className="inline-flex min-h-[44px] items-center hover:text-fg">
          Source on GitHub
        </a>
        <a href={PYPI} className="inline-flex min-h-[44px] items-center hover:text-fg">
          Pandion on PyPI
        </a>
        <a href="/privacy" className="inline-flex min-h-[44px] items-center hover:text-fg">
          Your data and privacy
        </a>
      </footer>
    </div>
  )
}
