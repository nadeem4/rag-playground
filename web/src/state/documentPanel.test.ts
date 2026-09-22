import { beforeEach, describe, expect, it, vi } from "vitest"

import { initialDocumentOpen, rememberDocumentOpen } from "./documentPanel"

beforeEach(() => {
  window.localStorage.clear()
})

describe("the document panel's remembered state", () => {
  it("starts open for the first lesson a viewer opens, and closed afterwards", () => {
    expect(initialDocumentOpen()).toBe(true)
    expect(initialDocumentOpen()).toBe(false)
  })

  it("remembers that the viewer opened it", () => {
    initialDocumentOpen()
    rememberDocumentOpen(true)
    expect(initialDocumentOpen()).toBe(true)
  })

  it("remembers that the viewer closed it", () => {
    rememberDocumentOpen(false)
    expect(initialDocumentOpen()).toBe(false)
  })

  it("opens, and does not throw, when storage is blocked", () => {
    const blocked = () => {
      throw new Error("blocked")
    }
    vi.spyOn(window.localStorage.__proto__, "getItem").mockImplementation(blocked)
    vi.spyOn(window.localStorage.__proto__, "setItem").mockImplementation(blocked)
    expect(initialDocumentOpen()).toBe(true)
    expect(() => rememberDocumentOpen(false)).not.toThrow()
    vi.restoreAllMocks()
  })
})
