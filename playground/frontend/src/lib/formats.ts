import type { Registry } from "@/api/types"

/**
 * The document formats Pandion's parsers may declare in `provides.formats`
 * (packages/pandion/src/pandion/formats.py): each one's plain name and its
 * extensions. Which of them this server reads comes from the registry.
 */
export const FORMATS: Record<string, { label: string; ext: string[] }> = {
  pdf: { label: "PDF", ext: [".pdf"] },
  docx: { label: "Word", ext: [".docx"] },
  pptx: { label: "PowerPoint", ext: [".pptx"] },
  html: { label: "HTML", ext: [".html", ".htm"] },
  md: { label: "Markdown", ext: [".md"] },
  txt: { label: "text", ext: [".txt"] },
  png: { label: "PNG", ext: [".png"] },
  jpg: { label: "JPG", ext: [".jpg", ".jpeg"] },
}

const ORDER = Object.keys(FORMATS)

/** The format of `filename` by its extension, or null when it has none we know. */
export function formatOf(filename: string): string | null {
  const dot = filename.lastIndexOf(".")
  if (dot < 0) return null
  const ext = filename.slice(dot).toLowerCase()
  return ORDER.find((f) => FORMATS[f].ext.includes(ext)) ?? null
}

/** Every format some parser declares, in FORMATS order. */
export function readableFormats(registry: Registry | null | undefined): string[] {
  const declared = new Set<string>()
  for (const t of Object.values(registry?.parse ?? {})) {
    const formats = t.provides?.formats
    if (Array.isArray(formats)) for (const f of formats) declared.add(String(f))
  }
  return ORDER.filter((f) => declared.has(f))
}

/** A file input's `accept`: every extension of `formats`. */
export function acceptFor(formats: readonly string[]): string {
  return formats.flatMap((f) => FORMATS[f]?.ext ?? []).join(",")
}

function joined(words: string[], last: string): string {
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} ${last} ${words[words.length - 1]}`
}

/** "PDF, Word, PowerPoint, HTML, Markdown, text or images": PNG and JPG read as images. */
export function formatsLine(formats: readonly string[]): string {
  const words = [...new Set(formats.map((f) => (f === "png" || f === "jpg" ? "images" : (FORMATS[f]?.label ?? f))))]
  return joined(words, "or")
}

/** Why a parser cannot read a document: "pdfium reads PDF files only." */
export function readsLine(parser: string, formats: readonly string[]): string {
  return `${parser} reads ${joined(
    formats.map((f) => FORMATS[f]?.label ?? f),
    "and",
  )} files only.`
}

/** The button that opens a piece in its document: the page for a PDF, the text for anything else. */
export function showLabel(filename: string): string {
  return hasPages(filename) ? "Show in PDF" : "Show in text"
}

/**
 * Whether the server draws this document's pages (`/pages`, `/find`): a PDF
 * only. Word, web pages, Markdown and text have no pages, and an image's or a
 * slide's boxes are not in PDF points, so every other format shows its text.
 * A name with no extension is taken as a PDF, as the server does.
 */
export function hasPages(filename: string): boolean {
  const kind = formatOf(filename)
  return kind === null || kind === "pdf"
}
