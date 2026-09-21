import type { JsonSchema } from "@/api/types"

/**
 * Pure schema logic for the form renderer: resolve `$ref`, unwrap Pydantic v2
 * `Optional[...]` (an `anyOf` with a `{"type": "null"}` branch, never a
 * `nullable` flag), classify a property into a field kind, derive defaults and
 * validate numeric bounds. Anything that cannot be classified is `json`: the
 * documented raw-JSON escape hatch.
 */

export type FieldKind = "string" | "integer" | "number" | "boolean" | "enum" | "object" | "json"

export interface FieldInfo {
  kind: FieldKind
  /** Resolved and unwrapped, with the property's own title/default/description on top. */
  schema: JsonSchema
  nullable: boolean
  /** Enum choices, `null` excluded. */
  options: unknown[]
}

/** Field path ("a.b") to messages. The path of a root-level problem is "". */
export type FieldErrors = Record<string, string[]>

/** One entry of a Pydantic `ValidationError.json()`, as the API's 422 carries it. */
export interface PydanticError {
  loc: (string | number)[]
  msg: string
  type?: string
  [key: string]: unknown
}

/** Deeper than this, an object is shown as JSON rather than recursing forever. */
const MAX_DEPTH = 8

const isNullSchema = (s: JsonSchema) => s.type === "null" || ("const" in s && s.const === null)
const isPrimitive = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v)
export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

function lookup(root: JsonSchema, ref: string): JsonSchema | undefined {
  if (!ref.startsWith("#/")) return undefined
  let cur: unknown = root
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~")
    cur = isPlainObject(cur) ? cur[key] : undefined
  }
  return isPlainObject(cur) ? (cur as JsonSchema) : undefined
}

/** Follow `$ref` (and the single-member `allOf` wrapper) into `$defs`. Local keys win. */
export function resolveRef(node: JsonSchema, root: JsonSchema): JsonSchema | undefined {
  let cur = node
  const seen = new Set<string>()
  for (;;) {
    if (!cur.$ref && cur.allOf?.length === 1) {
      const { allOf, ...local } = cur
      cur = { ...allOf[0], ...local }
      continue
    }
    if (!cur.$ref) return cur
    if (seen.has(cur.$ref)) return undefined
    seen.add(cur.$ref)
    const target = lookup(root, cur.$ref)
    if (!target) return undefined
    const { $ref: _ref, ...local } = cur
    cur = { ...target, ...local }
  }
}

const json = (schema: JsonSchema, nullable = false): FieldInfo => ({ kind: "json", schema, nullable, options: [] })

export function describeField(node: JsonSchema, root: JsonSchema): FieldInfo {
  let s = resolveRef(node, root)
  if (!s) return json(node)
  let nullable = false

  const variants = s.anyOf ?? s.oneOf
  if (variants) {
    const resolved = variants.map((v) => resolveRef(v, root))
    if (resolved.some((v) => !v)) return json(s)
    const real = (resolved as JsonSchema[]).filter((v) => !isNullSchema(v))
    if (real.length !== 1) return json(s, real.length < variants.length)
    const { anyOf: _a, oneOf: _o, ...local } = s
    s = { ...real[0], ...local }
    nullable = real.length < variants.length
  }

  if (Array.isArray(s.type)) {
    const types = s.type.filter((t) => t !== "null")
    if (types.length !== 1) return json(s)
    nullable ||= types.length < s.type.length
    s = { ...s, type: types[0] }
  }

  if ("const" in s && isPrimitive(s.const) && s.const !== null) {
    return { kind: "enum", schema: s, nullable, options: [s.const] }
  }
  if (Array.isArray(s.enum) && s.enum.length > 0 && s.enum.every(isPrimitive)) {
    const options = s.enum.filter((v) => v !== null)
    if (options.length === 0) return json(s)
    return { kind: "enum", schema: s, nullable: nullable || options.length < s.enum.length, options }
  }

  switch (s.type) {
    case "string":
    case "integer":
    case "number":
    case "boolean":
      return { kind: s.type, schema: s, nullable, options: [] }
    case "object":
      return s.properties ? { kind: "object", schema: s, nullable, options: [] } : json(s, nullable)
    default:
      return json(s, nullable)
  }
}

const clone = <T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T))

/** The config a schema produces untouched: every `default`, nested models recursed. */
export function defaultsFor(schema: JsonSchema, root: JsonSchema, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const f = describeField(prop, root)
    if ("default" in f.schema) out[key] = clone(f.schema.default)
    else if (f.kind === "object" && depth < MAX_DEPTH) out[key] = defaultsFor(f.schema, root, depth + 1)
  }
  return out
}

/** A starting value for a field being switched from unset to set. */
export function seedValue(f: FieldInfo, root: JsonSchema): unknown {
  const d = f.schema.default
  if (d !== undefined && d !== null) return clone(d)
  switch (f.kind) {
    case "integer":
    case "number": {
      const { minimum, exclusiveMinimum } = f.schema
      if (minimum !== undefined) return minimum
      if (exclusiveMinimum !== undefined) return exclusiveMinimum + (f.kind === "integer" ? 1 : 0.1)
      return 0
    }
    case "boolean":
      return false
    case "enum":
      return f.options[0]
    case "object":
      return defaultsFor(f.schema, root)
    default:
      return ""
  }
}

export const fmtNum = (n: number) => String(n)

/** Human form of the numeric bounds, for the label row: "0 to 1", "min 1". */
export function rangeHint(s: JsonSchema): string | null {
  const lo = s.minimum ?? s.exclusiveMinimum
  const hi = s.maximum ?? s.exclusiveMaximum
  const lower = s.minimum !== undefined ? `min ${lo}` : lo !== undefined ? `over ${lo}` : null
  const upper = s.maximum !== undefined ? `max ${hi}` : hi !== undefined ? `under ${hi}` : null
  if (s.minimum !== undefined && s.maximum !== undefined) return `${lo} to ${hi}`
  return [lower, upper].filter(Boolean).join(", ") || null
}

function checkNumber(f: FieldInfo, v: unknown): string[] {
  if (typeof v !== "number" || Number.isNaN(v)) return ["Enter a number"]
  const s = f.schema
  const out: string[] = []
  if (f.kind === "integer" && !Number.isInteger(v)) out.push("Must be a whole number")
  if (s.minimum !== undefined && v < s.minimum) out.push(`Must be at least ${fmtNum(s.minimum)}`)
  if (s.maximum !== undefined && v > s.maximum) out.push(`Must be at most ${fmtNum(s.maximum)}`)
  if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) out.push(`Must be greater than ${fmtNum(s.exclusiveMinimum)}`)
  if (s.exclusiveMaximum !== undefined && v >= s.exclusiveMaximum) out.push(`Must be less than ${fmtNum(s.exclusiveMaximum)}`)
  return out
}

/** Client-side checks the renderer can make without the server. */
export function validate(
  schema: JsonSchema,
  root: JsonSchema,
  value: unknown,
  path: string[] = [],
  depth = 0,
): FieldErrors {
  const out: FieldErrors = {}
  const obj = isPlainObject(value) ? value : {}
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const f = describeField(prop, root)
    const at = [...path, key]
    const v = key in obj ? obj[key] : f.schema.default
    let errs: string[] = []
    if (v === undefined) {
      if (schema.required?.includes(key) && f.kind !== "object") errs = ["Required"]
    } else if (v === null) {
      if (!f.nullable && f.kind !== "json") errs = ["Required"]
    } else if (f.kind === "integer" || f.kind === "number") {
      errs = checkNumber(f, v)
    } else if (f.kind === "object" && depth < MAX_DEPTH) {
      Object.assign(out, validate(f.schema, root, v, at, depth + 1))
    }
    if (f.kind === "object" && v === undefined && depth < MAX_DEPTH) {
      Object.assign(out, validate(f.schema, root, {}, at, depth + 1))
    }
    if (errs.length) out[at.join(".")] = errs
  }
  return out
}

/** Pydantic `loc` arrays to field paths, for the API's 422 `detail.errors`. */
export function errorsFromPydantic(errors: PydanticError[]): FieldErrors {
  const out: FieldErrors = {}
  for (const e of errors) {
    const key = e.loc.join(".")
    ;(out[key] ??= []).push(e.msg)
  }
  return out
}
