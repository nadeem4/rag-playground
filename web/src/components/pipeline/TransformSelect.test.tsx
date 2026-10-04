import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { TransformInfo } from "@/api/types"
import { choose, openPicker, optionOf } from "@/components/ui/pickerTesting"
import { TEST_REGISTRY as R } from "@/state/testRegistry"

import { TransformSelect } from "./TransformSelect"

afterEach(cleanup)

const rerankers: TransformInfo[] = [
  { ...R.rerank!.mmr, name: "cross_encoder", summary: "Reads the question and each piece together. It is slower." },
  { ...R.rerank!.mmr, name: "llm_rerank", summary: "Asks a chat model to put the pieces in order. It needs an API key." },
]

function setup(over: Partial<Parameters<typeof TransformSelect>[0]> = {}) {
  const onChange = vi.fn()
  render(<TransformSelect id="t" label="Strategy" transforms={rerankers} value="cross_encoder" upstream={{}} onChange={onChange} {...over} />)
  return { onChange, trigger: () => screen.getByRole("button", { name: /^Strategy/ }) }
}

describe("TransformSelect", () => {
  it("is a Picker named by its label, with the plain name and the code name", () => {
    const { trigger } = setup({ labelFor: (n) => (n === "cross_encoder" ? "Cross-encoder" : n) })
    expect(trigger().textContent).toContain("Cross-encoder")
    expect(trigger().textContent).toContain("cross_encoder")
  })

  it("gives each option the first sentence of its summary as its help line", () => {
    const { trigger } = setup()
    const o = optionOf(trigger(), "cross_encoder")
    expect(o.textContent).toContain("Reads the question and each piece together.")
    expect(o.textContent).not.toContain("It is slower.")
  })

  it("tags a key strategy Needs a key when no key is set, and says so under itself", () => {
    const { trigger } = setup({ value: "llm_rerank", hasKey: false })
    expect(screen.getByTestId("key-note").textContent).toBe("Needs an API key. Add one under Key.")
    expect(optionOf(trigger(), "llm_rerank").textContent).toContain("Needs a key")
  })

  it("does not tag a key strategy while a key is set or nobody knows yet", () => {
    for (const hasKey of [true, null]) {
      const { trigger } = setup({ value: "llm_rerank", hasKey })
      expect(screen.queryByTestId("key-note")).toBeNull()
      expect(optionOf(trigger(), "llm_rerank").textContent).not.toContain("Needs a key")
      cleanup()
    }
  })

  it("picks through the list", () => {
    const { trigger, onChange } = setup()
    choose(trigger(), "llm_rerank")
    expect(onChange).toHaveBeenCalledWith("llm_rerank")
  })

  it("with one transform shows it as text, with no picker", () => {
    setup({ transforms: [rerankers[0]] })
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByLabelText("Strategy").tagName).toBe("OUTPUT")
  })

  it("keeps the list closed until pressed", () => {
    const { trigger } = setup()
    expect(screen.queryByRole("listbox")).toBeNull()
    openPicker(trigger())
    expect(screen.getByRole("listbox", { name: "Strategy" })).toBeTruthy()
  })
})
