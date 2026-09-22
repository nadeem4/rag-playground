import type { ChatCitation, ChatPayload, ChatSegment, ChunkSet, Grounding, GroundingStats } from "@/api/types"

import { chunkSlot } from "./spans"

/**
 * The pure half of the chat inspector (plan I-10): how a segment is drawn,
 * which colour and page a citation gets, and the counts in the summary.
 */

export type SegmentKind = "cited" | "ungrounded" | "plain"

/**
 * A segment with citations is cited. One without is NOT grounded, and is
 * marked, unless it holds no word at all (". " between two cited claims):
 * underlining a lone full stop marks nothing a reader could check.
 */
export function segmentKind(seg: ChatSegment): SegmentKind {
  if (seg.citations.length > 0) return "cited"
  return /[\p{L}\p{N}]/u.test(seg.text) ? "ungrounded" : "plain"
}

export function isChatOutput(data: unknown): data is { kind: "chat"; payload: ChatPayload } {
  if (!data || typeof data !== "object") return false
  const d = data as { kind?: unknown; payload?: { answer?: unknown; citations?: unknown } }
  return d.kind === "chat" && Array.isArray(d.payload?.answer) && Array.isArray(d.payload?.citations)
}

/** Index of the cited chunk in the chunk set, when both are known. */
export function chunkIndexOf(c: Pick<ChatCitation, "chunk_id">, chunkSet?: ChunkSet): number | null {
  if (!c.chunk_id || !chunkSet) return null
  const i = chunkSet.chunks.findIndex((ch) => ch.id === c.chunk_id)
  return i === -1 ? null : i
}

/** The chunk's palette slot, so a citation has the hue its chunk has everywhere. */
export function citationSlot(c: Pick<ChatCitation, "chunk_id">, chunkSet?: ChunkSet): number | null {
  const i = chunkIndexOf(c, chunkSet)
  return i === null ? null : chunkSlot(i)
}

/**
 * The page to open for a citation. The citation's own page first; when its
 * offset fell in no element (page null), the first page of its chunk, where
 * the text search can still find the quote. Null when neither is known.
 */
export function citationPage(
  c: Pick<ChatCitation, "page" | "chunk_id">,
  chunkSet?: ChunkSet,
): { page: number; from: "citation" | "chunk" } | null {
  if (c.page !== null && c.page !== undefined) return { page: c.page, from: "citation" }
  const i = chunkIndexOf(c, chunkSet)
  const span = i === null ? null : chunkSet!.chunks[i].page_span
  return span ? { page: span[0], from: "chunk" } : null
}

/** The quote as shown and as searched: whitespace runs collapsed, ends trimmed. */
export function quoteText(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

export function unverifiedReason(c: ChatCitation): string {
  if (c.chunk_id === null || c.doc_start === null || c.doc_end === null) {
    return "Not verified. The model cited a document outside the retrieved hits, so there is no position to check."
  }
  return `Not verified. The document at characters ${c.doc_start}-${c.doc_end} does not match this quote.`
}

export interface ChatStats {
  citations: number
  verified: number
  unverified: number
  segments: number
  ungrounded: number
}

export function chatStats(p: ChatPayload): ChatStats {
  const verified = p.citations.filter((c) => c.verified).length
  return {
    citations: p.citations.length,
    verified,
    unverified: p.citations.length - verified,
    segments: p.answer.filter((s) => segmentKind(s) !== "plain").length,
    ungrounded: p.answer.filter((s) => segmentKind(s) === "ungrounded").length,
  }
}

/** A sentence for a stop reason that changes how the answer should be read. */
export function stopNote(stop: string | null, empty: boolean): string | null {
  if (stop === "refusal") return "The model declined to answer this question."
  if (stop === "max_tokens") return "The answer stopped at the token limit, so it may be cut off."
  if (empty) return "The model returned no text."
  return null
}

/**
 * The sentence-id label a segment is drawn with (plan I-20). Null for native
 * segments, which keep the I-10 marks, and for text with no word in it.
 */
export function claimKind(seg: ChatSegment): Grounding | null {
  if (!seg.grounding) return null
  return segmentKind(seg) === "plain" ? null : seg.grounding
}

/** "4 cited · 1 weak · 0 similarity · 1 not grounded · 0 invalid ids" */
export function groundingLine(s: GroundingStats): string {
  const ids = s.unknown_ids === 1 ? "invalid id" : "invalid ids"
  return `${s.cited} cited · ${s.weak} weak · ${s.similarity} similarity · ${s.none} not grounded · ${s.unknown_ids} ${ids}`
}

export function methodCaption(method: ChatPayload["citation_method"]): string | null {
  if (method === "native") return "Citations: native (Claude)"
  if (method === "sentence_ids") return "Citations: sentence ids, checked by us"
  return null
}
