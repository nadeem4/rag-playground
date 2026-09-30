import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetAppSettingsForTests, useAppSettings } from "./useDemo"

let calls = 0
let fail = false

beforeEach(() => {
  resetAppSettingsForTests()
  calls = 0
  fail = false
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/settings/app") {
        calls += 1
        if (fail) return new Response(JSON.stringify({ detail: "down" }), { status: 500 })
        return new Response(JSON.stringify({ demo: true }), { status: 200 })
      }
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function Probe({ id }: { id: string }) {
  const settings = useAppSettings()
  return <p data-testid={id}>{settings === null ? "none" : settings.demo ? "demo" : "local"}</p>
}

describe("useAppSettings", () => {
  it("two hooks mounted together fetch the settings once", async () => {
    render(
      <>
        <Probe id="a" />
        <Probe id="b" />
      </>,
    )
    await waitFor(() => expect(screen.getByTestId("a").textContent).toBe("demo"))
    expect(screen.getByTestId("b").textContent).toBe("demo")
    expect(calls).toBe(1)
  })

  it("a failed fetch leaves null, and a later mount tries again", async () => {
    fail = true
    render(<Probe id="a" />)
    await waitFor(() => expect(calls).toBe(1))
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByTestId("a").textContent).toBe("none")
    fail = false
    cleanup()
    render(<Probe id="b" />)
    await waitFor(() => expect(screen.getByTestId("b").textContent).toBe("demo"))
    expect(calls).toBe(2)
  })
})
