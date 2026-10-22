import type { Against, ScoredRun } from "@/api/types"

/**
 * Pandion's `POST /api/v2/evaluations/against` for the web tests: questions
 * paired by id, the better run by hit rate then MRR. The fixtures need no
 * more. The real rule, text pairing and notes included, is Pandion's own
 * (`pandion.evaluation.regression` and `best`) and is tested there.
 */
export const AGAINST_URL = "/api/v2/evaluations/against"

export function againstResponse(init?: RequestInit): Response {
  const { report, baseline } = JSON.parse(String(init?.body)) as { report: ScoredRun; baseline: ScoredRun }
  const before = new Map(baseline.questions.map((q) => [q.id, q]))
  const pairs = report.questions.flatMap((q) => {
    const b = before.get(q.id)
    return b && !q.error && !b.error ? [[q, b] as const] : []
  })
  const key = (r: ScoredRun) => [r.hit_rate ?? 0, r.mrr ?? 0]
  const [a, b] = [key(baseline), key(report)]
  const best = a[0] === b[0] && a[1] === b[1] ? [0, 1] : b[0] > a[0] || (b[0] === a[0] && b[1] > a[1]) ? [1] : [0]
  const body: Against = {
    found_before: pairs.filter(([, x]) => x.found).length,
    found_now: pairs.filter(([q]) => q.found).length,
    compared: pairs.length,
    newly_missed: pairs.filter(([q, x]) => x.found && !q.found).map(([q]) => q.id),
    newly_found: pairs.filter(([q, x]) => q.found && !x.found).map(([q]) => q.id),
    unmatched: [],
    partial: false,
    notes: [],
    ok: true,
    best,
  }
  return new Response(JSON.stringify(body), { status: 200 })
}
