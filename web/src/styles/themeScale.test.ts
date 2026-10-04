import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import { buildCss } from "./compileCss"

/*
 * The theme (tokens.css) clears Tailwind's scales: the only breakpoints are md,
 * lg and xl, and the only spacing steps are 0, 1, 2, 3, 4, 6 and 8. Any other
 * step, or an sm: class, compiles to nothing, so it would silently do nothing
 * in the browser. Each file a change creates or touches is listed here.
 */
const FILES = [
  "components/AppHeader.tsx",
  "components/DocumentControl.tsx",
  "components/DocumentNote.tsx",
  "components/useUpload.ts",
  "components/pipeline/FirstRun.tsx",
  "components/pipeline/NodeCard.tsx",
  "components/pipeline/PipelineColumn.tsx",
  "state/graph.ts",
  "routes/Compare.tsx",
  "routes/Evaluate.tsx",
  "routes/Shell.tsx",
  "routes/useColumnsFit.ts",
  "components/ask/AskSettings.tsx",
  "components/ask/AskPanel.tsx",
  "components/compare/RecipeHead.tsx",
  "components/compare/ChunkEvidence.tsx",
  "components/compare/RetrieveEvidence.tsx",
  "components/compare/RecipeCard.tsx",
  "components/compare/ValueEditor.tsx",
  "components/compare/AddRecipeCard.tsx",
  "state/recipeSentence.ts",
  "state/compare.ts",
]

const offScale =
  /(^|[\s"'`:])-?(?:gap|gap-x|gap-y|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|space-x|space-y|inset|top|bottom|left|right)-(?!(?:0|1|2|3|4|6|8)(?![0-9.]))[0-9][0-9.]*/m
const offBreakpoint = /(^|[\s"'`])(?:sm|2xl|max-sm):/m

const read = (f: string) => readFileSync(`${__dirname}/../${f}`, "utf8")

describe("the theme's scales", () => {
  it("uses only the md, lg and xl breakpoints and the spacing steps 0, 1, 2, 3, 4, 6 and 8", () => {
    for (const f of FILES) {
      const src = read(f)
      expect(src, f).not.toMatch(offBreakpoint)
      expect(src, f).not.toMatch(offScale)
    }
  })

  it("compiles md:, lg:, xl: and arbitrary values, and nothing for sm:, 2xl: or an off-scale step", async () => {
    const css = await buildCss(["md:flex", "lg:flex", "xl:flex", "sm:flex", "2xl:flex", "p-5", "gap-7", "p-[5px]"])
    expect(css).toContain(String.raw`.md\:flex`)
    expect(css).toContain(String.raw`.lg\:flex`)
    expect(css).toContain(String.raw`.xl\:flex`)
    expect(css).toContain(String.raw`.p-\[5px\]`)
    expect(css).not.toContain(String.raw`.sm\:flex`)
    // 2xl:flex would compile as `.\32 xl\:flex`: only the one xl:flex rule is there.
    expect(css).not.toMatch(/xl\\:flex[^]*xl\\:flex/)
    expect(css).not.toMatch(/\.p-5\b/)
    expect(css).not.toMatch(/\.gap-7\b/)
  })
})
