import { ApiKeyProvider } from "@/api/apiKey"
import { AppHeader } from "@/components/AppHeader"
import { Compare } from "@/routes/Compare"
import { Home } from "@/routes/Home"
import { Inspect } from "@/routes/Inspect"
import { Learn } from "@/routes/Learn"
import { Shell } from "@/routes/Shell"
import { Specimen } from "@/routes/Specimen"

// A handful of routes does not justify a router. FastAPI's SPA fallback serves
// index.html for any path, so a plain pathname switch is enough.
//
// "/" is Home (the lessons as an ordered path), "/build" is Build (the
// pipeline column, Shell) and /compare is the sweep view. Each lesson has its
// own page under /learn; /learn itself redirects to Home. Build and Compare
// share the pipeline graph through per-viewer storage (state/graph.ts).
//
// /inspect and /design are development pages, reached from the header's Dev
// menu. /specimen is the design page's old path, kept so no old link breaks.
// Any other path, including the removed /forms, falls through to Home.
const ROUTES: Record<string, () => React.JSX.Element> = {
  "/": Home,
  "/build": Shell,
  "/compare": Compare,
  "/design": Specimen,
  "/specimen": Specimen,
  "/inspect": Inspect,
}

/** Paths that are another path's old name. */
const REDIRECTS: Record<string, string> = { "/learn": "/" }

export function canonicalPath(path: string): string {
  return REDIRECTS[path] ?? path
}

export function pageFor(path: string): () => React.JSX.Element {
  // Each lesson has its own page: /learn/end-to-end, /learn/chunking, /learn/citations.
  if (path.startsWith("/learn/")) return Learn
  return ROUTES[path] ?? Home
}

export default function App() {
  const asked = window.location.pathname.replace(/\/+$/, "") || "/"
  const path = canonicalPath(asked)
  if (path !== asked) window.history.replaceState(null, "", path + window.location.search)
  const Page = pageFor(path)
  return (
    // The typed API key lives in this provider's memory only (plan I-8).
    <ApiKeyProvider>
      <div className="flex h-[100dvh] flex-col">
        <AppHeader path={path} />
        <Page />
      </div>
    </ApiKeyProvider>
  )
}
