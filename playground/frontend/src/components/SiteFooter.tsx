const REPO = "https://github.com/nadeem4/rag-playground"

const LINK = "inline-flex h-row-compact items-center underline underline-offset-4 hover:text-fg"

/**
 * The site footer, at the end of the pages a person reads (Read, Library and
 * the privacy page). The workbench pages fill the screen, so they carry none;
 * the header links the privacy page from every page.
 */
export function SiteFooter() {
  return (
    <footer className="learn-page mt-8 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-hairline pt-3 pb-6 text-sm text-fg-muted">
      <span>RAG Playground</span>
      <a href="/privacy" className={LINK}>
        Privacy
      </a>
      <a href={REPO} className={LINK}>
        Source on GitHub
      </a>
    </footer>
  )
}
