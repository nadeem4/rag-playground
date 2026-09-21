import { AppHeader } from "@/components/AppHeader"
import { Shell } from "@/routes/Shell"
import { Specimen } from "@/routes/Specimen"

// Two routes do not justify a router. FastAPI's SPA fallback serves index.html
// for any path, so a plain pathname switch is enough.
export default function App() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/"
  return (
    <div className="flex h-[100dvh] flex-col">
      <AppHeader path={path} />
      {path === "/specimen" ? <Specimen /> : <Shell />}
    </div>
  )
}
