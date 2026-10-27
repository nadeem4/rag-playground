import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { GUIDE_INVITE, resetGuideForTests, useGuideHidden } from "@/state/guide"

import { GuideInvite } from "./GuideInvite"

function Parent({ onStart }: { onStart: () => void }) {
  const hidden = useGuideHidden()
  return hidden ? <p>gone</p> : <GuideInvite onStart={onStart} />
}

describe("GuideInvite", () => {
  beforeEach(() => {
    cleanup()
    window.localStorage.clear()
    act(() => resetGuideForTests())
  })

  it("shows the heading in a labelled section", () => {
    render(<GuideInvite onStart={() => {}} />)
    expect(screen.getByRole("region", { name: "Guided run invitation" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "New to RAG? Take the guided run." })).toBeTruthy()
  })

  it("calls onStart from the Start button", () => {
    const onStart = vi.fn()
    render(<GuideInvite onStart={onStart} />)
    fireEvent.click(screen.getByRole("button", { name: GUIDE_INVITE.start }))
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it("hides for good and unmounts when the parent reads the hidden state", () => {
    render(<Parent onStart={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "I know RAG, hide this" }))
    expect(screen.getByText("gone")).toBeTruthy()
    expect(window.localStorage.getItem("rag-playground:guide:v1")).toContain("true")
  })

  it("uses no dashes in its copy", () => {
    const { container } = render(<GuideInvite onStart={() => {}} />)
    expect(container.textContent).not.toMatch(/[–—]/)
  })
})
