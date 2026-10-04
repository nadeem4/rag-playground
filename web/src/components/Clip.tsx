import { Pause, Play } from "lucide-react"
import { useRef, useState, useSyncExternalStore } from "react"

import { reducedMotion } from "@/lib/slope"

/**
 * A short recording of the real site: a muted, looping, inline video over its
 * poster, with a caption line and a 44 px Pause and Play button. Under
 * reduced motion it holds the poster and waits for Play. Without a `src` it is
 * the poster still alone, with its caption and no button.
 *
 * With a dark file as well, it follows the theme. When the site's theme is
 * pinned (`data-theme` on the root), it picks the matching file in code. On
 * System it serves the dark file by media query, with the light file as the
 * fallback, and picks the poster by the same query.
 */

const DARK = "(prefers-color-scheme: dark)"

/** The site's pinned theme, or "system" when none is set. */
function readTheme(): string {
  const t = document.documentElement.dataset.theme
  return t === "light" || t === "dark" ? t : "system"
}

function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
  return () => observer.disconnect()
}

const systemDark = () => typeof matchMedia === "function" && matchMedia(DARK).matches

export function Clip({
  src,
  srcDark,
  poster,
  posterDark,
  label,
  caption,
}: {
  src?: string
  srcDark?: string
  poster: string
  posterDark?: string
  label: string
  caption: string
}) {
  const video = useRef<HTMLVideoElement>(null)
  const [reduce] = useState(reducedMotion)
  const [playing, setPlaying] = useState(Boolean(src) && !reduce)
  const theme = useSyncExternalStore(subscribeTheme, readTheme)
  const dark = theme === "dark" || (theme === "system" && systemDark())
  const still = dark && posterDark ? posterDark : poster
  // System with a dark file: let the browser pick by media query.
  const byMedia = theme === "system" && Boolean(srcDark)
  const file = dark && srcDark ? srcDark : src

  const toggle = () => {
    const v = video.current
    if (!v) return
    if (playing) {
      v.pause()
      setPlaying(false)
    } else {
      void v.play()?.catch(() => setPlaying(false))
      setPlaying(true)
    }
  }

  return (
    <figure
      aria-label={label}
      className="relative m-0 aspect-[16/10] overflow-hidden rounded-panel border border-hairline bg-surface-raised shadow-(--shadow-raised)"
    >
      {src ? (
        <video
          // A new element when the file changes, so the new one loads and plays.
          key={byMedia ? "system" : file}
          ref={video}
          src={byMedia ? undefined : file}
          poster={still}
          muted
          loop
          playsInline
          autoPlay={!reduce && playing}
          preload={reduce ? "none" : "auto"}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          className="block size-full object-cover object-top-left"
        >
          {byMedia ? (
            <>
              <source media={DARK} src={srcDark} type="video/webm" />
              <source src={src} type="video/webm" />
            </>
          ) : null}
        </video>
      ) : (
        <img src={still} alt="" className="block size-full object-cover object-top-left" />
      )}
      <figcaption className="absolute bottom-3 left-3 right-[68px] w-fit max-w-full rounded-control border border-hairline bg-surface-raised/90 px-3 py-1 text-sm font-semibold">
        {caption}
      </figcaption>
      {src ? (
        <button
          type="button"
          aria-label={playing ? "Pause clip" : "Play clip"}
          onClick={toggle}
          className="absolute right-3 bottom-3 grid size-[44px] place-items-center rounded-full border border-hairline bg-surface-raised text-fg hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)"
        >
          {playing ? <Pause aria-hidden className="size-4" /> : <Play aria-hidden className="size-4" />}
        </button>
      ) : null}
    </figure>
  )
}
