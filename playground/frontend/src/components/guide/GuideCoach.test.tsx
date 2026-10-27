import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { GUIDE_STEPS } from "@/state/guide"

import { GuideCoach } from "./GuideCoach"

type Props = Parameters<typeof GuideCoach>[0]

function setup(over: Partial<Props> = {}) {
  const props: Props = {
    index: 3,
    question: "What decides chunk size?",
    step: GUIDE_STEPS[3],
    values: { pages: "4", size: "300", dim: "384" },
    state: "ready",
    result: null,
    onRun: vi.fn(),
    onNext: vi.fn(),
    onLeave: vi.fn(),
    ...over,
  }
  return { props, ...render(<GuideCoach {...props} />) }
}

describe("GuideCoach", () => {
  afterEach(cleanup)

  it("labels the aside and shows the step count from the step list", () => {
    setup({ index: 2, step: GUIDE_STEPS[2] })
    expect(screen.getByRole("complementary", { name: "Guided run" })).toBeTruthy()
    expect(screen.getByText(`Guided run · step 3 of ${GUIDE_STEPS.length}`)).toBeTruthy()
  })

  it("fills placeholders from values", () => {
    const { container } = setup()
    expect(container.textContent).toContain("at most 300 characters")
    expect(container.textContent).not.toMatch(/\{\w+\}/)
  })

  it("keeps the question in every state", () => {
    for (const state of ["ready", "running", "done", "blocked"] as const) {
      const { unmount } = setup({ state, result: state === "done" ? "ok" : null, blockedReason: "Wait" })
      expect(screen.getByText("Our question")).toBeTruthy()
      expect(screen.getByText("What decides chunk size?")).toBeTruthy()
      unmount()
    }
  })

  it("runs from the Run button when ready", () => {
    const { props } = setup()
    fireEvent.click(screen.getByRole("button", { name: GUIDE_STEPS[3].run }))
    expect(props.onRun).toHaveBeenCalledTimes(1)
  })

  it("disables Run while running", () => {
    setup({ state: "running" })
    expect((screen.getByRole("button", { name: GUIDE_STEPS[3].run }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("disables Run and shows the reason when blocked", () => {
    setup({ state: "blocked", blockedReason: "Pick a document first." })
    expect((screen.getByRole("button", { name: GUIDE_STEPS[3].run }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText("Pick a document first.")).toBeTruthy()
  })

  it("shows result, Why and Next only when done", () => {
    const { unmount } = setup({ state: "ready" })
    expect(screen.queryByText("Why")).toBeNull()
    expect(screen.queryByRole("button", { name: "Next step" })).toBeNull()
    expect(screen.getByRole("status").textContent).toBe("")
    unmount()

    const { props } = setup({ state: "done", result: "Made 12 pieces." })
    expect(screen.getByRole("status").textContent).toBe("Made 12 pieces.")
    expect(screen.getByText("Why")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Next step" }))
    expect(props.onNext).toHaveBeenCalledTimes(1)
  })

  it("hides result, Why and Next while running or blocked", () => {
    for (const state of ["running", "blocked"] as const) {
      const { unmount } = setup({ state, result: "Leaked result.", blockedReason: "Wait" })
      expect(screen.queryByText("Leaked result.")).toBeNull()
      expect(screen.queryByText("Why")).toBeNull()
      expect(screen.queryByRole("button", { name: "Next step" })).toBeNull()
      unmount()
    }
  })

  it("shows the error line on a failed run, keeps Run enabled and hides Next", () => {
    setup({ state: "ready", error: "Docling is not reachable." })
    expect(screen.getByRole("status").textContent).toBe("Docling is not reachable.")
    expect((screen.getByRole("button", { name: GUIDE_STEPS[3].run }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByRole("button", { name: "Next step" })).toBeNull()
    expect(screen.queryByText("Why")).toBeNull()
  })

  it("reads Finish on the last step", () => {
    const last = GUIDE_STEPS.length - 1
    setup({ index: last, step: GUIDE_STEPS[last], state: "done", result: "Done." })
    expect(screen.getByRole("button", { name: "Finish" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Next step" })).toBeNull()
  })

  it("calls onLeave from the leave button", () => {
    const { props } = setup()
    fireEvent.click(screen.getByRole("button", { name: "Leave the guided run" }))
    expect(props.onLeave).toHaveBeenCalledTimes(1)
  })

  it("renders extra content", () => {
    setup({ extra: <p>extra bit</p> })
    expect(screen.getByText("extra bit")).toBeTruthy()
  })

  it("uses no dashes in its copy", () => {
    const { container } = setup({ state: "done", result: "Done." })
    expect(container.textContent).not.toMatch(/[–—]/)
  })
})
