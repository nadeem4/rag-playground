import { afterEach, describe, expect, it, vi } from "vitest"

import { applyContrast, readContrast } from "./contrast"

afterEach(() => {
  window.localStorage.clear()
  delete document.documentElement.dataset.contrast
  vi.restoreAllMocks()
})

describe("the contrast choice", () => {
  it("reads system when nothing is stored, or something unknown is", () => {
    expect(readContrast()).toBe("system")
    window.localStorage.setItem("rag-contrast", "loud")
    expect(readContrast()).toBe("system")
  })

  it("More sets data-contrast on <html> and stores the choice", () => {
    applyContrast("more")
    expect(document.documentElement.getAttribute("data-contrast")).toBe("more")
    expect(window.localStorage.getItem("rag-contrast")).toBe("more")
    expect(readContrast()).toBe("more")
  })

  it("System removes data-contrast and the stored choice", () => {
    applyContrast("more")
    applyContrast("system")
    expect(document.documentElement.hasAttribute("data-contrast")).toBe(false)
    expect(window.localStorage.getItem("rag-contrast")).toBeNull()
    expect(readContrast()).toBe("system")
  })

  it("still applies to the page when storage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    applyContrast("more")
    expect(document.documentElement.getAttribute("data-contrast")).toBe("more")
    expect(readContrast()).toBe("system")
  })
})
