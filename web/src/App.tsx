import { AppHeader } from "@/components/AppHeader"
import { Forms } from "@/routes/Forms"
import { Inspect } from "@/routes/Inspect"
import { Shell } from "@/routes/Shell"
import { Specimen } from "@/routes/Specimen"

// A handful of routes does not justify a router. FastAPI's SPA fallback serves
// index.html for any path, so a plain pathname switch is enough.
//
// /forms and /inspect are development galleries that render components against
// real-engine fixtures, so each can be built and checked in both themes before
// the pipeline column wires them to live runs.
const ROUTES: Record<string, () => React.JSX.Element> = {
  "/specimen": Specimen,
  "/forms": Forms,
  "/inspect": Inspect,
}

export default function App() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/"
  const Page = ROUTES[path] ?? Shell
  return (
    <div className="flex h-[100dvh] flex-col">
      <AppHeader path={path} />
      <Page />
    </div>
  )
}
