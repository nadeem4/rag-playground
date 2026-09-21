import type { ReactNode } from "react"

import artifacts from "@/api/fixtures/artifacts.json"
import chunkMarkdown from "@/api/fixtures/chunk_set.markdown_header.json"
import chunkRecursive from "@/api/fixtures/chunk_set.recursive_character.json"
import chunkToken from "@/api/fixtures/chunk_set.token_based.json"
import parsedDoc from "@/api/fixtures/parsed_doc.json"
import cleanedDoc from "@/api/fixtures/parsed_doc_cleaned.json"
import type { ChunkSet, ParsedDoc } from "@/api/types"
import { ChunkSetInspector } from "@/components/inspectors/ChunkSetInspector"
import { ParsedDocInspector } from "@/components/inspectors/ParsedDocInspector"
import { ArtifactInspector } from "@/components/inspectors/registry"

/**
 * The inspector gallery: every inspector rendered against real engine output
 * (web/scripts/export_fixtures.py), plus the empty, loading and error screens.
 * Check it in both themes before wiring an inspector to a live run.
 */

const recursive = chunkRecursive as unknown as ChunkSet
const markdown = chunkMarkdown as unknown as ChunkSet
const tokenBased = chunkToken as unknown as ChunkSet
const parsed = parsedDoc as unknown as ParsedDoc
const cleaned = cleanedDoc as unknown as ParsedDoc
const emptySet: ChunkSet = { chunks: [], source_text: "", doc_id: recursive.doc_id, chunker_meta: { chunker: "recursive_character" } }

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 bg-surface p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        {note ? <p className="max-w-[82ch] text-sm text-fg-muted">{note}</p> : null}
      </div>
      {children}
    </section>
  )
}

export function Inspect() {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-hairline">
      <div className="flex flex-col gap-px">
        <Section title="recursive_character" note="chunk_size 400, chunk_overlap 80. Adjacent chunks share their last and first 80 characters, so every boundary is an overlap.">
          <ChunkSetInspector chunkSet={recursive} initialSelected={1} />
        </Section>
        <Section title="markdown_header" note="The parser found no headings, so the chunker fell back to its token budget. The blank lines between sections belong to no chunk.">
          <ChunkSetInspector chunkSet={markdown} />
        </Section>
        <Section title="token_based" note="max_tokens 96, overlap 16. Windows cut mid-sentence.">
          <ChunkSetInspector chunkSet={tokenBased} />
        </Section>
        <Section title="Empty chunk set" note="A document with no text produces zero chunks.">
          <ChunkSetInspector chunkSet={emptySet} />
        </Section>
        <Section title="Parsed document" note="pdfium, text mode: 42 elements, before cleaning.">
          <ParsedDocInspector doc={parsed} />
        </Section>
        <Section title="Clean report" note="header_footer_strip, then dedupe_blocks, drawn on the document before cleaning.">
          <ArtifactInspector type="parsed_doc" data={cleaned} context={{ before: parsed }} />
        </Section>
        <Section title="Fallback" note="Artifact types without an inspector render as a JSON tree.">
          <ArtifactInspector type="index" data={artifacts} />
        </Section>
        <Section title="States">
          <div className="grid items-start gap-3 lg:grid-cols-2">
            <ChunkSetInspector />
            <ChunkSetInspector status={{ kind: "loading" }} />
            <ChunkSetInspector status={{ kind: "error", message: "ValueError: chunk_overlap (400) must be smaller than chunk_size (400)" }} />
            <ParsedDocInspector doc={{ ...parsed, elements: [] }} />
          </div>
        </Section>
      </div>
    </main>
  )
}
