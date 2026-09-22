import { ApiKeyProvider } from "@/api/apiKey"
import { AppHeader } from "@/components/AppHeader"
import { Compare } from "@/routes/Compare"
import { Inspect } from "@/routes/Inspect"
import { Shell } from "@/routes/Shell"
import { Specimen } from "@/routes/Specimen"

// A handful of routes does not justify a router. FastAPI's SPA fallback serves
// index.html for any path, so a plain pathname switch is enough.
//
// "/" is Build (the pipeline column, Shell) and /compare is the sweep view.
// They share the pipeline graph through per-viewer storage (state/graph.ts).
//
// /inspect and /design are development pages, reached from the header's Dev
// menu. /specimen is the design page's old path, kept so no old link breaks.
// Any other path, including the removed /forms, falls through to Build.
const ROUTES: Record<string, () => React.JSX.Element> = {
  "/compare": Compare,
  "/design": Specimen,
  "/specimen": Specimen,
  "/inspect": Inspect,
}

export function pageFor(path: string): () => React.JSX.Element {
  return ROUTES[path] ?? Shell
}

export default function App() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/"
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
