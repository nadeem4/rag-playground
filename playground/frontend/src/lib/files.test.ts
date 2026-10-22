import { describe, expect, it } from "vitest"

import { FILE_COLOURS, fileOf, fileSlot, filesOf } from "./files"

const A = { sha: "a".repeat(64), filename: "a.pdf" }
const B = { sha: "b".repeat(64), filename: "b.docx" }

describe("file colours", () => {
  it("gives each document a colour by its order, and wraps after the last one", () => {
    expect([0, 1, 2, 3, 4, 5].map(fileSlot)).toEqual([1, 2, 3, 4, 5, 6])
    expect(fileSlot(FILE_COLOURS)).toBe(1)
  })

  it("names the files of several documents, each with its colour", () => {
    expect(filesOf([A, B])).toEqual([
      { ...A, slot: 1 },
      { ...B, slot: 2 },
    ])
  })

  it("names no file with one document: nothing changes then", () => {
    expect(filesOf([A])).toEqual([])
    expect(fileOf(filesOf([A]), A.sha)).toBeUndefined()
  })

  it("finds a file by its sha", () => {
    expect(fileOf(filesOf([A, B]), B.sha)?.filename).toBe("b.docx")
    expect(fileOf(filesOf([A, B]), null)).toBeUndefined()
  })
})
