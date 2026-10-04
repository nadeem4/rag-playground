import { act, cleanup, render } from "@testing-library/react"
import { useRef } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { SlopeKind, SlopePath } from "@/lib/slope"

import { useSlope } from "./useSlope"

/** The swatch tops, by id, per column: a test moves them and fires the observer. */
let tops: { search: Record<string, number>; reranked: Record<string, number> }
let observers: { cb: ResizeObserverCallback; el?: Element }[]

class FakeObserver {
  cb: ResizeObserverCallback
  el?: Element
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb
    observers.push(this)
  }
  observe(el: Element) {
    this.el = el
  }
  disconnect() {}
  unobserve() {}
}

const fire = () => act(() => observers.forEach((o) => o.cb([], o as unknown as ResizeObserver)))

function rect(left: number, top: number): DOMRect {
  return { left, top, width: 30, height: 30, right: left + 30, bottom: top + 30, x: left, y: top, toJSON: () => ({}) } as DOMRect
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
      <div data-column="reranked">{Object.keys(tops.reranked).map((id) => swatch("reranked", id))}</div>
    </div>
  )
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
})

const moves = new Map<string, SlopeKind>([
  ["b", "up"],
  ["a", "down"],
])

describe("useSlope", () => {
  it("measures both columns on mount", () => {
    render(<Harness open rerankId="rr1" moves={moves} />)
    expect(seen.map((p) => [p.id, p.kind])).toEqual([
      ["b", "up"],
      ["a", "down"],
    ])
  })

  it("measures again when the container's observer fires (Review Focus 1)", () => {
    render(<Harness open rerankId="rr1" moves={moves} />)
    const before = seen.find((p) => p.id === "a")!.d
    expect(observers.length).toBeGreaterThan(0)
    tops.reranked.a = 140
    fire()
    const after = seen.find((p) => p.id === "a")!.d
    expect(after).not.toBe(before)
    expect(after.endsWith("300,155")).toBe(true)
  })

  it("measures again when the rerank result changes", () => {
    const { rerender } = render(<Harness open rerankId="rr1" moves={moves} />)
    tops.reranked.a = 200
    rerender(<Harness open rerankId="rr2" moves={moves} />)
    expect(seen.find((p) => p.id === "a")!.d.endsWith("300,215")).toBe(true)
  })

  it("draws nothing and watches nothing while the comparison is closed", () => {
    render(<Harness open={false} rerankId="rr1" moves={moves} />)
    expect(seen).toEqual([])
    expect(observers).toHaveLength(0)
  })
})
