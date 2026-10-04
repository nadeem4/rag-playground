/** The longest first sentence that may stay under a control as a hint. */
const MAX = 60

/** A unit or a range, as whole words: "per" must not match "upper". */
const UNIT = /\b(characters|tokens|pixels|seconds|per|px)\b|\b0 to 1\b/i

/**
 * The one line that stays under a field's control. A field's description
 * opens behind its info button; only a short first sentence that names a unit
 * or a range stays visible, since it says how to read the number in the box.
 */
export function hintFor(description: string | undefined): string | null {
  const text = description?.trim()
  if (!text) return null
  const first = text.split(/(?<=\.)\s/)[0]
  return first.length <= MAX && UNIT.test(first) ? first : null
}
