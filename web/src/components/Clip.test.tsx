import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { Clip } from "./Clip"

const LABEL = "Clip: building the index and asking a question on Build"

function reduceMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({ matches: reduce && q === "(prefers-reduced-motion: reduce)", media: q, addEventListener() {}, removeEventListener() {} })),
  )
}

let play: ReturnType<typeof vi.fn>
let pause: ReturnType<typeof vi.fn>

beforeEach(() => {
  // jsdom has no media playback: record the calls and fire the events a browser would.
  play = vi.fn(function (this: HTMLVideoElement) {
    this.dispatchEvent(new Event("play"))
    return Promise.resolve()
  })
  pause = vi.fn(function (this: HTMLVideoElement) {
    this.dispatchEvent(new Event("pause"))
  })
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play as never)
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause as never)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Clip in light and dark", () => {
  function media({ dark }: { dark: boolean }) {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((q: string) => ({ matches: dark && q === "(prefers-color-scheme: dark)", media: q, addEventListener() {}, removeEventListener() {} })),
    )
  }
  const both = () =>
    render(
      <Clip
        src="/clips/build.webm"
        srcDark="/clips/build-dark.webm"
        poster="/clips/build.jpg"
        posterDark="/clips/build-dark.jpg"
        label={LABEL}
        caption="Build the index"
      />,
    )

  afterEach(() => {
    delete document.documentElement.dataset.theme
  })

  it("follows the system theme with a dark source by media query and the light file as the fallback", () => {
    media({ dark: false })
    both()
    const v = video()
    expect(v.hasAttribute("src")).toBe(false)
    const sources = [...v.querySelectorAll("source")].map((s) => [s.getAttribute("media"), s.getAttribute("src")])
    expect(sources).toEqual([
      ["(prefers-color-scheme: dark)", "/clips/build-dark.webm"],
      [null, "/clips/build.webm"],
    ])
    expect(v.getAttribute("poster")).toBe("/clips/build.jpg")
  })

  it("shows the dark poster when the system theme is dark", () => {
    media({ dark: true })
    both()
    expect(video().getAttribute("poster")).toBe("/clips/build-dark.jpg")
  })

  it("plays the dark file when the site's theme is set to Dark, whatever the system says", () => {
    media({ dark: false })
    document.documentElement.dataset.theme = "dark"
    both()
    const v = video()
    expect(v.getAttribute("src")).toBe("/clips/build-dark.webm")
    expect(v.querySelectorAll("source")).toHaveLength(0)
    expect(v.getAttribute("poster")).toBe("/clips/build-dark.jpg")
  })

  it("plays the light file when the site's theme is set to Light on a dark system", () => {
    media({ dark: true })
    document.documentElement.dataset.theme = "light"
    both()
    const v = video()
    expect(v.getAttribute("src")).toBe("/clips/build.webm")
    expect(v.getAttribute("poster")).toBe("/clips/build.jpg")
  })

  it("switches file when the theme is changed while the page is open", async () => {
    media({ dark: false })
    document.documentElement.dataset.theme = "light"
    both()
    document.documentElement.dataset.theme = "dark"
    await vi.waitFor(() => expect(video().getAttribute("src")).toBe("/clips/build-dark.webm"))
  })

  it("shows the dark still when the site's theme is Dark and there is no video", () => {
    media({ dark: false })
    document.documentElement.dataset.theme = "dark"
    render(<Clip poster="/clips/compare.jpg" posterDark="/clips/compare-dark.jpg" label="A still of the Compare page" caption="Clip coming soon" />)
    expect(document.querySelector("figure img")!.getAttribute("src")).toBe("/clips/compare-dark.jpg")
  })
})

const clip = () => render(<Clip src="/clips/build.webm" poster="/clips/build.jpg" label={LABEL} caption="Build the index" />)
const video = () => document.querySelector("video")!

describe("Clip", () => {
  it("autoplays muted, looping and inline, with its poster", () => {
    reduceMotion(false)
    clip()
    const v = video()
    expect(v.autoplay).toBe(true)
    expect(v.muted).toBe(true)
    expect(v.loop).toBe(true)
    expect(v.hasAttribute("playsinline")).toBe(true)
    expect(v.getAttribute("src")).toBe("/clips/build.webm")
    expect(v.getAttribute("poster")).toBe("/clips/build.jpg")
  })

  it("names what the clip shows and carries a caption", () => {
    reduceMotion(false)
    clip()
    expect(screen.getByRole("figure", { name: LABEL })).toBeTruthy()
    expect(screen.getByText("Build the index").tagName).toBe("FIGCAPTION")
  })

  it("shows a Pause button while it plays, and the button toggles", () => {
    reduceMotion(false)
    clip()
    const button = screen.getByRole("button", { name: "Pause clip" })
    fireEvent.click(button)
    expect(pause).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "Play clip" })).toBe(button)
    fireEvent.click(button)
    expect(play).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "Pause clip" })).toBe(button)
  })

  it("gives the button a 44 px box", () => {
    reduceMotion(false)
    clip()
    const c = screen.getByRole("button", { name: "Pause clip" }).className.split(/\s+/)
    expect(c).toContain("size-[44px]")
  })

  it("under reduced motion holds the poster, does not autoplay, and offers Play", () => {
    reduceMotion(true)
    clip()
    const v = video()
    expect(v.autoplay).toBe(false)
    expect(v.getAttribute("poster")).toBe("/clips/build.jpg")
    expect(play).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Play clip" }))
    expect(play).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "Pause clip" })).toBeTruthy()
  })

  it("without a video, shows the poster still with its caption and no button", () => {
    reduceMotion(false)
    render(<Clip poster="/clips/compare.jpg" label="A still of the Compare page" caption="Clip coming soon" />)
    expect(document.querySelector("video")).toBeNull()
    expect(screen.getByRole("figure", { name: "A still of the Compare page" })).toBeTruthy()
    expect(document.querySelector("figure img")!.getAttribute("src")).toBe("/clips/compare.jpg")
    expect(screen.getByText("Clip coming soon")).toBeTruthy()
    expect(screen.queryByRole("button")).toBeNull()
  })
})
