import { describe, expect, it } from "vitest"

import { firstSentence } from "./sentence"

describe("firstSentence", () => {
  it("ends at the first full stop, question or exclamation mark followed by a space or the end", () => {
    expect(firstSentence("One. Two.")).toBe("One.")
    expect(firstSentence("Is it? Yes.")).toBe("Is it?")
    expect(firstSentence("Stop! Go.")).toBe("Stop!")
    expect(firstSentence("Version 1.5 is out. Next.")).toBe("Version 1.5 is out.")
    expect(firstSentence("No end mark at all")).toBe("No end mark at all")
    expect(firstSentence("  Trimmed.  ")).toBe("Trimmed.")
  })

  it("drops markdown line markers and ends at a newline", () => {
    expect(firstSentence("## Heading\nFirst body sentence.")).toBe("First body sentence.")
    expect(firstSentence("## Reading order in two-column reports\n\nThe survey ran for six weeks.")).toBe("The survey ran for six weeks.")
    expect(firstSentence("## Title\n\nBody sentence. More.")).toBe("Body sentence.")
    // A heading and nothing else falls back to the heading.
    expect(firstSentence("## Only a heading")).toBe("Only a heading")
    expect(firstSentence("> Quoted line. More.")).toBe("Quoted line.")
    expect(firstSentence("- A list item\n- Another")).toBe("A list item")
    expect(firstSentence("1. First step. Then more.")).toBe("First step.")
    expect(firstSentence("\n\n### Deep\nBody.")).toBe("Body.")
  })

  it("cuts a long sentence at 200 characters with an ellipsis", () => {
    const long = "word ".repeat(60).trim() + "."
    const out = firstSentence(long)
    expect(out.endsWith("…")).toBe(true)
    expect(out.length).toBeLessThanOrEqual(200)
    expect(out.endsWith("\u2026")).toBe(true)
    expect(long.startsWith(out.slice(0, -1))).toBe(true)
  })
})
