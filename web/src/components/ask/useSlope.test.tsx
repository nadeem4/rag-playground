import { act, cleanup, render } from "@testing-library/react"
import { useRef } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { SlopeKind, SlopePath } from "@/lib/slope"

import { useSlope } from "./useSlope"

/** The swatch tops, by id, per column: a test moves them and fires the observer. */
let tops: { search: Record<string, number>; reranked: Record<string, number> }
let observers: FakeObserver[]

class FakeObserver {
  cb: ResizeObserverCallback
  observed: Element[] = []
  disconnect = vi.fn()
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb
    observers.push(this)
  }
  observe(el: Element) {
    this.observed.push(el)
  }
  unobserve() {}
}

const fire = () => act(() => observers.forEach((o) => o.cb([], o as unknown as ResizeObserver)))

function rect(left: number, top: number, width = 30): DOMRect {
  return { left, top, width, height: 30, right: left + width, bottom: top + 30, x: left, y: top, toJSON: () => ({}) } as DOMRect
}

let seen: SlopePath[] = []

function Harness({ open, rerankId, moves }: { open: boolean; rerankId: string; moves: Map<string, SlopeKind> }) {
  const ref = useRef<HTMLDivElement>(null)
  seen = useSlope(ref, open, rerankId, moves)
  const swatch = (column: "search" | "reranked", id: string) => (
    <div key={id}>
      <span
        data-id={id}
        ref={(el) => {
          if (el) el.getBoundingClientRect = () => rect(column === "search" ? 0 : 300, tops[column][id])
        }}
      />
    </div>
  )
  return (
    <div ref={ref}>
      <div data-column="search">{Object.keys(tops.search).map((id) => swatch("search", id))}</div>
      {/* The gutter: x 100 to 164, so every line runs from x 102 to x 162. */}
      <div
        data-gutter=""
        ref={(el) => {
          if (el) el.getBoundingClientRect = () => rect(100, 0, 64)
        }}
      />
      <div data-column="reranked">{Object.keys(tops.reranked).map((id) => swatch("reranked", id))}</div>
    </div>
  )
}

/** A promise and the function that settles it. */
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

beforeEach(() => {
  tops = { search: { a: 0, b: 40 }, reranked: { b: 0, a: 40 } }
  observers = []
  seen = []
  vi.stubGlobal("ResizeObserver", FakeObserver)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations
  delete (document as { fonts?: unknown }).fonts
})

const moves = new Map<string, SlopeKind>([
  ["b", "up"],
  ["a", "down"],
])

const end = (id: string) => seen.find((p) => p.id === id)?.d.split(" ").pop()

describe("useSlope", () => {
  it("measures both columns on mount, inside the gutter", () => {
    render(<Harness open rerankId="rr1" moves={moves} />)
    expect(seen.map((p) => [p.id, p.kind])).toEqual([
      ["b", "up"],
      ["a", "down"],
    ])
    expect(seen[0].d).toBe("M 102,55 C 142,55 122,15 162,15")
  })

  it("measures again when an observer fires, and watches the grid and both lists (Review Focus 1)", () => {
    const { container } = render(<Harness open rerankId="rr1" moves={moves} />)
    const root = container.firstElementChild!
    const observed = observers.flatMap((o) => o.observed)
    expect(observed).toContain(root)
    expect(observed).toContain(root.querySelector('[data-column="search"]'))
    expect(observed).toContain(root.querySelector('[data-column="reranked"]'))
    tops.reranked.a = 140
    fire()
    expect(end("a")).toBe("162,155")
  })

  it("measures again when the rerank result changes", () => {
    const { rerender } = render(<Harness open rerankId="rr1" moves={moves} />)
    tops.reranked.a = 200
    rerender(<Harness open rerankId="rr2" moves={moves} />)
    expect(end("a")).toBe("162,215")
  })

  it("measures again once the fonts have landed", async () => {
    const fonts = deferred()
    Object.defineProperty(document, "fonts", { value: { ready: fonts.promise }, configurable: true })
    render(<Harness open rerankId="rr1" moves={moves} />)
    expect(end("a")).toBe("162,55")
    tops.reranked.a = 90
    await act(async () => fonts.resolve())
    expect(end("a")).toBe("162,105")
  })

  it("measures only after the lists' animations have finished, so the lines join the final places", async () => {
    const enter = deferred()
    const running = [{ finished: enter.promise }]
    ;(HTMLElement.prototype as { getAnimations?: unknown }).getAnimations = vi.fn(() => running)
    render(<Harness open rerankId="rr1" moves={moves} />)
    // Mid-rise: nothing is drawn yet.
    expect(seen).toEqual([])
    tops.reranked.a = 70
    running.length = 0
    await act(async () => enter.resolve())
    expect(end("a")).toBe("162,85")
  })

  it("does not wait for an endless animation, which never finishes", () => {
    const endless = { finished: new Promise(() => {}), effect: { getComputedTiming: () => ({ iterations: Infinity }) } }
    ;(HTMLElement.prototype as { getAnimations?: unknown }).getAnimations = vi.fn(() => [endless])
    render(<Harness open rerankId="rr1" moves={moves} />)
    expect(end("a")).toBe("162,55")
  })

  it("measures nothing when it unmounts while waiting for an animation", async () => {
    const enter = deferred()
    const running = [{ finished: enter.promise }]
    ;(HTMLElement.prototype as { getAnimations?: unknown }).getAnimations = vi.fn(() => running)
    let reads = 0
    const { unmount } = render(<Harness open rerankId="rr1" moves={moves} />)
    document.querySelectorAll<HTMLElement>("[data-id]").forEach((el) => {
      const read = el.getBoundingClientRect
      el.getBoundingClientRect = () => {
        reads++
        return read()
      }
    })
    unmount()
    running.length = 0
    await act(async () => enter.resolve())
    expect(reads).toBe(0)
    expect(seen).toEqual([])
  })

  it("stops watching when it unmounts", () => {
    const { unmount } = render(<Harness open rerankId="rr1" moves={moves} />)
    unmount()
    expect(observers.every((o) => o.disconnect.mock.calls.length === 1)).toBe(true)
  })

  it("draws nothing and watches nothing while the comparison is closed", () => {
    render(<Harness open={false} rerankId="rr1" moves={moves} />)
    expect(seen).toEqual([])
    expect(observers).toHaveLength(0)
  })
})
