import type { ProblemDetail } from "@/api/types"

/**
 * A 422's detail as pandion-api sends it for a pipeline Pandion refused: the
 * sentence in `problems`, and in `details` where Pandion placed it.
 */
export function refusedDetail(message: string, place: Partial<Omit<ProblemDetail, "message">> = {}) {
  return { problems: [message], details: [{ message, step: null, use: null, settings: [], ...place }] }
}
