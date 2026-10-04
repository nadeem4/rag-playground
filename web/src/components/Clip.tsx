import { Pause, Play } from "lucide-react"
import { useRef, useState } from "react"

import { reducedMotion } from "@/lib/slope"

/**
 * A short recording of the real site: a muted, looping, inline video over its
 * poster, with a caption line and a 44 px Pause and Play button. Under
 * reduced motion it holds the poster and waits for Play. Without a `src` it is
 * the poster still alone, with its caption and no button.
 */
export function Clip({ src, poster, label, caption }: { src?: string; poster: string; label: string; caption: string }) {
  const video = useRef<HTMLVideoElement>(null)
  const [reduce] = useState(reducedMotion)
  const [playing, setPlaying] = useState(Boolean(src) && !reduce)

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
          ref={video}
          src={src}
          poster={poster}
          muted
          loop
          playsInline
          autoPlay={!reduce}
          preload={reduce ? "none" : "auto"}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          className="block size-full object-cover object-top-left"
        />
      ) : (
        <img src={poster} alt="" className="block size-full object-cover object-top-left" />
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
