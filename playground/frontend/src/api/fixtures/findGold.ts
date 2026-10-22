/**
 * Pandion's `POST /api/v2/golds/find` for the web tests, played by containment
 * with case and spacing aside: the fixtures need no more. The real rule is
 * Pandion's own (`pandion.evaluation.find_gold`) and is tested there.
 */
export const FIND_GOLD_URL = "/api/v2/golds/find"

const plain = (text: string) => text.split(/\s+/).filter(Boolean).join(" ").toLowerCase()

export function findGoldResponse(init?: RequestInit): Response {
  const { golds, texts } = JSON.parse(String(init?.body)) as { golds: string[]; texts: string[] }
  const holds = (text: string) => golds.find((g) => plain(text).includes(plain(g)))
  const index = texts.findIndex((t) => holds(t) !== undefined)
  const found = index === -1 ? null : { index, gold: holds(texts[index]), match: "normalized" }
  return new Response(JSON.stringify({ found }), { status: 200 })
}
