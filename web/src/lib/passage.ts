/**
 * A piece's text, read for display. A parser such as Docling writes a table as
 * Markdown rows (`| a | b |`) under a rule of dashes; shown as plain text those
 * bars and dashes are noise. These helpers find the tables, so an open piece
 * can draw a real table and a clamped piece or a quote can say the row in words.
 */

export type PassageBlock = { kind: "text"; text: string } | { kind: "table"; head: string[]; rows: string[][] }

// A row starts with a bar and has a second one; its closing bar may be cut off by a chunk boundary.
const ROW = /^\s*\|[^|]*\|/
const HEADING = /^[ \t]*#{1,6}[ \t]+/
const RULE = /^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{0,}:?\s*\|?\s*$/

/** True for a Markdown table row: a line that starts and ends with a bar. */
export function isTableRow(line: string): boolean {
  return ROW.test(line)
}

function isRule(line: string): boolean {
  return RULE.test(line)
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
}

/**
 * The piece as text blocks and table blocks. Two or more rows, or a row over a
 * rule, make a table. A lone row, which a chunk boundary can leave at a
 * piece's edge, is said in words; a lone rule is dropped. Heading marks at the
 * start of a line come off.
 */
export function passageBlocks(text: string): PassageBlock[] {
  const lines = text.split("\n")
  const out: PassageBlock[] = []
  let buffer: string[] = []
  const flush = () => {
    const joined = buffer.join("\n").trim()
    if (joined) out.push({ kind: "text", text: joined })
    buffer = []
  }
  let i = 0
  while (i < lines.length) {
    let j = i
    while (j < lines.length && isTableRow(lines[j])) j++
    const run = lines.slice(i, j)
    const rows = run.filter((l) => !isRule(l))
    const withHead = run.length >= 2 && !isRule(run[0]) && isRule(run[1])
    if (rows.length >= 2 || withHead) {
      flush()
      out.push({ kind: "table", head: withHead ? cells(run[0]) : [], rows: (withHead ? run.slice(2) : run).filter((l) => !isRule(l)).map(cells) })
      i = j
    } else if (run.length) {
      // One row said in words; a rule on its own says nothing.
      for (const l of rows) buffer.push(flatRow(l))
      i = j
    } else {
      buffer.push(lines[i].replace(HEADING, ""))
      i++
    }
  }
  flush()
  return out
}

/** One table row in words: its label, a colon, then its values. */
export function flatRow(line: string): string {
  return wordsFor(cells(line))
}

function wordsFor(row: string[]): string {
  const [label, ...values] = row
  return values.length ? `${label}: ${values.join(", ")}` : label
}

/** The piece with each table said in words, its rows joined by semicolons, for a clamped piece. */
export function plainPassage(text: string): string {
  return passageBlocks(text)
    .map((b) => (b.kind === "text" ? b.text : [...(b.head.length ? [b.head] : []), ...b.rows].map(wordsFor).join("; ")))
    .join("\n")
}
