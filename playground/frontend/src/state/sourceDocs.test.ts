import { describe, expect, it } from "vitest"

import { addedDocument, documentOf, documentsOf, removedDocument, withDocument, withDocuments } from "./document"
import { initialGraph, signature } from "./graph"
import { docsOfSource, sourceConfigWith } from "./sourceDocs"
import { TEST_REGISTRY as R } from "./testRegistry"

const A = { sha: "a".repeat(64), filename: "manual.pdf" }
const B = { sha: "b".repeat(64), filename: "faq.md" }
const C = { sha: "c".repeat(64), filename: "guide.html" }

describe("a source node's documents", () => {
  it("reads an older node's one file, and a list in order", () => {
    expect(docsOfSource({ sha: A.sha, filename: A.filename })).toEqual([A])
    expect(docsOfSource({ sha: A.sha, filename: A.filename, documents: [A, B, C] })).toEqual([A, B, C])
    expect(docsOfSource({})).toEqual([])
    expect(docsOfSource(undefined)).toEqual([])
  })

  it("keeps each document once, and only the ones that name a file", () => {
    expect(docsOfSource({ documents: [A, B, A, { sha: "" }, { filename: "x" }, null, "nope"] })).toEqual([A, B])
  })

  it("keeps one document exactly as a node always held it, and lists several", () => {
    expect(sourceConfigWith({ other: 1 }, [A])).toEqual({ other: 1, sha: A.sha, filename: A.filename })
    expect(sourceConfigWith({}, [A, B])).toEqual({ sha: A.sha, filename: A.filename, documents: [A, B] })
    // Back to one: the list goes.
    expect(sourceConfigWith({ sha: A.sha, filename: A.filename, documents: [A, B] }, [B])).toEqual({ sha: B.sha, filename: B.filename })
    expect(sourceConfigWith({ sha: A.sha, filename: A.filename }, [])).toEqual({})
  })
})

describe("a graph on several documents", () => {
  const g = initialGraph(R)

  it("holds every document, in order, and its first is the one a single-document reader sees", () => {
    const both = withDocuments(g, [A, B, C])
    expect(documentsOf(both)).toEqual([A, B, C])
    expect(documentOf(both)).toEqual(A)
    expect(documentsOf(withDocuments(both, [C, A]))).toEqual([C, A])
  })

  it("on one document, is the same graph as before several existed: same settings, same signature", () => {
    const one = withDocument(g, A)
    const source = one.nodes.find((n) => n.stage === "source")!
    expect(source.config).toEqual({ ...g.nodes.find((n) => n.stage === "source")!.config, sha: A.sha, filename: A.filename })
    expect(signature(withDocuments(withDocuments(g, [A, B]), [A]), "source", R)).toBe(signature(one, "source", R))
  })

  it("adds a document at the end once, and removes one by its fingerprint", () => {
    expect(addedDocument([A], B)).toEqual([A, B])
    expect(addedDocument([A, B], A)).toEqual([A, B])
    expect(removedDocument([A, B, C], B.sha)).toEqual([A, C])
    expect(removedDocument([A], "nope")).toEqual([A])
  })
})
