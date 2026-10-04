/** The first sentence of a text: the Ask finding's quote and each strategy's help line in a picker. */

const MAX = 200

/** Markdown line markers: headings, quotes, list bullets and numbers. */
const MARKER = /^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)/gm

/**
 * The text up to the first `.`, `?` or `!` followed by a space or the end, or
 * up to the first line break, with leading heading lines skipped and markdown
 * line markers dropped first. At
 * most 200 characters, the ellipsis included.
 */
export function firstSentence(text: string): string {
  // A heading is not a sentence: skip leading heading and blank lines, unless nothing else is left.
  const body = text.replace(/^(?:[ \t]*(?:#{1,6}[ \t].*)?(?:\r?\n|$))+/, "")
  const t = (body.trim() ? body : text).replace(MARKER, "").trim()
  const end = /[.?!](?=\s|$)|\n/.exec(t)
  const s = end ? t.slice(0, end[0] === "\n" ? end.index : end.index + 1).trimEnd() : t
  return s.length <= MAX ? s : `${s.slice(0, MAX - 1).trimEnd()}…`
}
