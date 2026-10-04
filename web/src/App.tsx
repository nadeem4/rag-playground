import { ApiKeyProvider } from "@/api/apiKey"
import { AppHeader } from "@/components/AppHeader"
import { Compare } from "@/routes/Compare"
import { Evaluate } from "@/routes/Evaluate"
import { Home } from "@/routes/Home"
import { Inspect } from "@/routes/Inspect"
import { Learn } from "@/routes/Learn"
import { Lessons } from "@/routes/Lessons"
import { Read } from "@/routes/Read"
import { Shell } from "@/routes/Shell"
import { Specimen } from "@/routes/Specimen"
import { LESSONS_ENABLED } from "@/state/lessons"

// A handful of routes does not justify a router. FastAPI's SPA fallback serves
// index.html for any path, so a plain pathname switch is enough.
//
// "/" is Home, the front page: what the playground shows and a way into each
// page with a sample already loaded. "/build" is Build (the pipeline column,
// Shell), /compare is the sweep view and /evaluate scores the pipeline against
// the sample question set. /read lists the deep-dive posts in pipeline order,
// each stage with a link that opens Build. Navigation is a full page load, so
// Build, Compare and Evaluate share the pipeline graph through per-viewer
// storage (state/graph.ts). Within a page the graph is a store: the header's
// Document control and the page both read it, so a document chosen in the bar
// shows on the page at once (state/document.ts).
//
// The lessons list is at /learn and each lesson has its own page under it.
// While LESSONS_ENABLED is false, /learn and every lesson redirect to Home.
//
// /inspect and /design are development pages, reached from the header's Dev
// menu. /specimen is the design page's old path, kept so no old link breaks.
// Any other path, including the removed /forms, falls through to Home.
const ROUTES: Record<string, () => React.JSX.Element> = {
  "/": Home,
  "/build": Shell,
  "/compare": Compare,
  "/evaluate": Evaluate,
  "/read": Read,
  "/design": Specimen,
  "/specimen": Specimen,
  "/inspect": Inspect,
}

const isLessonPath = (path: string) => path === "/learn" || path.startsWith("/learn/")

/** The path to show for `path`, given whether the lessons are on. */
export function routeFor(path: string, lessonsEnabled: boolean): string {
  if (!lessonsEnabled && isLessonPath(path)) return "/"
  return path
}

export function canonicalPath(path: string): string {
  return routeFor(path, LESSONS_ENABLED)
}

export function pageFor(path: string, lessonsEnabled: boolean = LESSONS_ENABLED): () => React.JSX.Element {
  if (lessonsEnabled && path === "/learn") return Lessons
  // Each lesson has its own page: /learn/end-to-end, /learn/chunking, /learn/citations.
  if (lessonsEnabled && path.startsWith("/learn/")) return Learn
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
