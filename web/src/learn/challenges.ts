import type { LearnChallenge, LearnChunking } from "@/api/types"

import { seeingLines, type ChunkAnalysis } from "./chunks"

/**
 * The words of the Chunking lab. The backend sends each challenge's settings;
 * the prompts and explanations live here, filled in with the real numbers.
 * Every explanation starts from the REAL run, never from `expect_whole`.
 */

/** A slider for one numeric chunker setting. */
export interface FieldMeta {
  label: string
  unit: "characters" | "tokens"
  min: number
  max: number
  step: number
}

export const FIELDS: Record<string, FieldMeta> = {
  chunk_size: { label: "Chunk size", unit: "characters", min: 40, max: 900, step: 10 },
  chunk_overlap: { label: "Chunk overlap", unit: "characters", min: 0, max: 400, step: 10 },
  max_tokens: { label: "Max tokens", unit: "tokens", min: 10, max: 200, step: 1 },
  overlap: { label: "Overlap", unit: "tokens", min: 0, max: 100, step: 1 },
}

const num = (v: unknown) => (typeof v === "number" ? v : 0)

/** The size setting and the overlap setting of a config, by name. */
export function sizeAndOverlap(config: Record<string, unknown>): { size?: string; overlap?: string } {
  const keys = Object.keys(config).filter((k) => FIELDS[k])
  return { size: keys.find((k) => !k.includes("overlap")), overlap: keys.find((k) => k.includes("overlap")) }
}

export function unitOf(config: Record<string, unknown>): FieldMeta["unit"] {
  const { size } = sizeAndOverlap(config)
  return size ? FIELDS[size].unit : "characters"
}

function lengthIn(unit: FieldMeta["unit"], data: Pick<LearnChunking, "sentence_chars" | "sentence_tokens">): number {
  return unit === "tokens" ? data.sentence_tokens : data.sentence_chars
}

/** "1 and 2", "1, 2 and 3", from 0-based indices. */
export function listChunks(idx: number[]): string {
  const n = idx.map((i) => String(i + 1))
  return n.length < 2 ? n.join("") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`
}

export function choicesFor(ch: LearnChallenge): [string, string] {
  return ch.id === "overlap" ? ["Yes, in one chunk", "No, still cut"] : ["It stays whole", "It gets cut"]
}

export function challengePrompt(ch: LearnChallenge, data: LearnChunking): string {
  const c = ch.config
  const chars = data.sentence_chars
  const tokens = data.sentence_tokens
  switch (ch.id) {
    case "shrink":
      return `The answer sentence is ${chars} characters long. If each chunk can hold only ${num(c.chunk_size)} characters, will the answer sentence stay whole?`
    case "room": {
      const size = num(c.chunk_size)
      return `Now each chunk can hold ${size} characters, which is ${size > chars ? "more" : "less"} than the sentence. The recursive strategy cuts between sentences when it can. Will the answer sentence stay whole?`
    }
    case "naive":
      return `Now switch to token_based, which cuts every time it counts a fixed number of tokens, wherever that is. The answer sentence is ${tokens} tokens long. With ${num(c.max_tokens)} tokens per chunk, will it stay whole?`
    case "overlap":
      return `Keep token_based, but repeat the last ${num(c.overlap)} tokens of each chunk at the start of the next. The answer sentence is ${tokens} tokens long. Will it now appear whole in at least one chunk?`
    default: {
      const unit = unitOf(c)
      return `The answer sentence is ${lengthIn(unit, data)} ${unit} long. With ${ch.strategy} and these settings, will it stay whole?`
    }
  }
}

/** What the real run did to the answer sentence, and why, in full sentences. */
export function outcomeText(strategy: string, config: Record<string, unknown>, a: ChunkAnalysis, data: LearnChunking): string {
  if (!a.answerAt) return "The answer sentence was not found in the parsed text, so this run cannot show where it landed."
  const { size, overlap } = sizeAndOverlap(config)
  const sizeValue = size ? num(config[size]) : 0
  const overlapValue = overlap ? num(config[overlap]) : 0
  const unit = unitOf(config)
  const tokenBased = strategy === "token_based"
  if (a.whole !== null) {
    const n = a.whole + 1
    let why: string
    if (a.chunks[a.whole].repeat > 0 && overlapValue > 0) {
      why = `Chunk ${n} starts with text repeated from the chunk before, and that repeat reaches back far enough to hold the whole sentence. The cost is that some text is stored twice. Look for the hatched repeated text.`
    } else if (tokenBased) {
      why = "The cut happened to fall outside the sentence. This strategy never looks at where sentences end, so that was luck."
    } else {
      why = "When a sentence fits in a chunk, this strategy moves the cut to the end of a sentence instead of cutting through it."
    }
    return `It stays whole, in chunk ${n}. ${why}`
  }
  let why: string
  if (tokenBased && overlapValue > 0) {
    why = "No chunk starts early enough to hold all of it, even with the overlap."
  } else if (tokenBased) {
    why = "The chunk ends after a fixed number of tokens, and that point falls inside the sentence. This strategy never looks at where sentences end."
  } else if (sizeValue < lengthIn(unit, data)) {
    why = "The sentence is longer than a whole chunk, so even this careful strategy has to cut it between words. Look for the note in the chunks below."
  } else {
    why = "Neither piece holds the whole idea, so neither may match the question well."
  }
  return `It gets cut, across chunks ${listChunks(a.touching)}. ${why}`
}

/** "What you are seeing" in the lab: the Build lines, plus where the answer landed. */
export function labLines(config: Record<string, unknown>, a: ChunkAnalysis, data: LearnChunking): string[] {
  const { size, overlap } = sizeAndOverlap(config)
  const unit = unitOf(config)
  const [count, repeat] = seeingLines(a)
  const lines = [count.replace("The document", "The sample")]
  if (!a.answerAt) lines.push("The answer sentence was not found in the parsed text.")
  else if (a.whole !== null) lines.push(`The answer sentence sits whole in chunk ${a.whole + 1}, so the search can find it in one piece.`)
  else lines.push(`The answer sentence is cut across chunks ${listChunks(a.touching)}. Neither piece holds the whole idea, so neither may match the question well.`)
  if (size) lines.push(`The answer sentence is ${lengthIn(unit, data)} ${unit} long, and each chunk can hold at most ${num(config[size])} ${unit}.`)
  if (!overlap || num(config[overlap]) === 0) lines.push("There is no overlap, so no text is stored twice.")
  else if (a.repeated > 0) lines.push(repeat)
  else lines.push("You set an overlap, but nothing was repeated. This strategy only repeats whole pieces of text, and the pieces at the ends of these chunks are longer than the overlap.")
  return lines
}
