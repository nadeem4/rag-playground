import { useEffect, useId, useMemo, useRef, type ComponentType } from "react"

import type { JsonSchema, Lesson } from "@/api/types"
import { BooleanField } from "@/components/fields/BooleanField"
import { ConstField } from "@/components/fields/ConstField"
import { EnumField } from "@/components/fields/EnumField"
import { describedBy, Errors, FieldShell, fieldIds, Help, UnsetToggle } from "@/components/fields/FieldShell"
import { JsonField } from "@/components/fields/JsonField"
import { NumberField } from "@/components/fields/NumberField"
import {
  defaultsFor,
  describeField,
  isPlainObject,
  isShown,
  rangeHint,
  seedValue,
  validate,
  type FieldErrors,
  type FieldKind,
} from "@/components/fields/schema"
import { TextField } from "@/components/fields/TextField"
import { LearnHint } from "@/components/learn/LearnHint"
import type { ControlProps } from "@/components/fields/types"

/**
 * Renders a Pydantic v2 `model_json_schema()` as a form. Controlled: `value`
 * in, the full config object out through `onChange`. With no `value`, it
 * emits the schema defaults once on mount.
 *
 * `errors` are server errors keyed by field path ("a.b"), from
 * `errorsFromPydantic(detail.errors)`. Where the server has spoken about a
 * path it is authoritative; elsewhere the client-side bound checks show.
 *
 * Nesting: the root's fields are level 1, a nested model is an inline group
 * (level 2), anything deeper collapses behind a disclosure (contract §8).
 */
export interface SchemaFormProps {
  schema: JsonSchema
  value?: Record<string, unknown>
  onChange: (value: Record<string, unknown>) => void
  errors?: FieldErrors
  /**
   * Learn mode (plan I-22): lessons keyed by field path. A field with one
   * shows its hint and a "Read more" under it. Any plugin that ships `learn`
   * gets this; absent, the form is unchanged.
   */
  learn?: Record<string, Lesson>
}

const CONTROLS: Partial<Record<FieldKind, ComponentType<ControlProps>>> = {
  string: TextField,
  integer: NumberField,
  number: NumberField,
  enum: EnumField,
  json: JsonField,
}

const humanize = (key: string) => key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())

export function SchemaForm({ schema, value, onChange, errors, learn }: SchemaFormProps) {
  const defaults = useMemo(() => defaultsFor(schema, schema), [schema])
  const current = value ?? defaults
  const base = useId()

  // Emit the defaults once per schema, even if the parent never stores them.
  const emittedFor = useRef<JsonSchema | null>(null)
  useEffect(() => {
    if (value !== undefined || emittedFor.current === schema) return
    emittedFor.current = schema
    onChange(defaults)
  }, [value, schema, defaults, onChange])

  const allErrors = useMemo(() => ({ ...validate(schema, schema, current), ...errors }), [schema, current, errors])
  const root = describeField(schema, schema)
  const rootErrors = allErrors[""] ?? []

  if (root.kind !== "object") {
    const ids = fieldIds(`${base}root`)
    return (
      <FieldShell kind="json" ids={ids} label={schema.title ?? "Config"} errors={rootErrors} aside={<RawTag />}>
        <JsonField
          f={root}
          id={ids.control}
          value={current}
          invalid={rootErrors.length > 0}
          onChange={(v) => onChange(isPlainObject(v) ? v : {})}
        />
      </FieldShell>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Errors id={`${base}form-error`} errors={rootErrors} />
      <Fields
        schema={root.schema}
        root={schema}
        value={current}
        onValue={onChange}
        path={[]}
        depth={1}
        errors={allErrors}
        base={base}
        learn={learn}
      />
    </div>
  )
}

interface FieldsProps {
  schema: JsonSchema
  root: JsonSchema
  value: Record<string, unknown>
  onValue: (v: Record<string, unknown>) => void
  path: string[]
  depth: number
  errors: FieldErrors
  base: string
  learn?: Record<string, Lesson>
}

function Fields({ schema, value, onValue, ...rest }: FieldsProps) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {Object.entries(schema.properties ?? {})
        .filter(([, prop]) => isShown(prop, value))
        .map(([key, prop]) => (
        <Property
          key={key}
          name={key}
          prop={prop}
          value={value[key]}
          onValue={(v) => onValue({ ...value, [key]: v })}
          {...rest}
        />
      ))}
    </div>
  )
}

interface PropertyProps extends Omit<FieldsProps, "schema" | "value" | "onValue"> {
  name: string
  prop: JsonSchema
  value: unknown
  onValue: (v: unknown) => void
}

function Property(props: PropertyProps) {
  const lesson = props.learn?.[[...props.path, props.name].join(".")]
  const field = <Field {...props} />
  if (!lesson) return field
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {field}
      <LearnHint lesson={lesson} />
    </div>
  )
}

function Field({ name, prop, value, onValue, root, path, depth, errors, base, learn }: PropertyProps) {
  const f = describeField(prop, root)
  const at = [...path, name]
  const key = at.join(".")
  const ids = fieldIds(`${base}${key}`)
  const label = f.schema.title ?? humanize(name)
  const own = errors[key] ?? []
  const v = value === undefined ? f.schema.default : value
  const isNull = f.nullable && v === null
  const help = f.schema.description

  const unset = f.nullable ? (
    <UnsetToggle id={`${ids.control}-unset`} isNull={isNull} onToggle={() => onValue(isNull ? seedValue(f, root) : null)} />
  ) : null

  if (f.kind === "object") {
    const inner = isPlainObject(v) ? v : defaultsFor(f.schema, root)
    const body = (
      <>
        {help ? <Help id={ids.help} text={help} /> : null}
        {unset}
        <Errors id={ids.error} errors={own} />
        {isNull ? null : (
          <Fields
            schema={f.schema}
            root={root}
            value={inner}
            onValue={onValue}
            path={at}
            depth={depth + 1}
            errors={errors}
            base={base}
            learn={learn}
          />
        )}
      </>
    )
    if (depth + 1 >= 3) {
      return (
        <details className="relative min-w-0 rounded-control border border-hairline">
          <summary className="flex h-control items-center justify-between gap-2 px-2 text-sm font-medium select-none hover:bg-muted">
            {label}
            <span className="meta">{Object.keys(f.schema.properties ?? {}).length} fields</span>
          </summary>
          <fieldset data-field-kind="object" data-depth={depth + 1} className="m-0 flex min-w-0 flex-col gap-2 border-0 border-t border-hairline p-2">
            <legend className="sr-only">{label}</legend>
            {body}
          </fieldset>
        </details>
      )
    }
    return (
      <fieldset data-field-kind="object" data-depth={depth + 1} className="m-0 flex min-w-0 flex-col gap-2 border-0 border-l border-hairline p-0 pl-3">
        <legend className="mb-2 p-0 text-sm font-semibold">{label}</legend>
        {body}
      </fieldset>
    )
  }

  const control = {
    f,
    id: ids.control,
    value: v,
    disabled: isNull,
    invalid: own.length > 0,
    describedBy: describedBy(ids, Boolean(help), own),
    onChange: onValue,
  }

  if (f.kind === "boolean") {
    return (
      <div data-field-kind="boolean" className="flex min-w-0 flex-col gap-1">
        <div className="flex min-h-[20px] items-center justify-between gap-2">
          <label htmlFor={ids.control} className="flex items-center gap-2 text-sm font-medium text-fg select-none">
            <BooleanField {...control} />
            {label}
          </label>
          {unset}
        </div>
        {help ? <Help id={ids.help} text={help} /> : null}
        <Errors id={ids.error} errors={own} />
      </div>
    )
  }

  const kind = f.kind
  // A single-value Literal offers no choice, so it is not drawn as a control.
  const Control = kind === "enum" && f.options.length === 1 ? ConstField : (CONTROLS[kind] ?? JsonField)
  const range = f.kind === "integer" || f.kind === "number" ? rangeHint(f.schema) : null
  const aside =
    kind === "json" ? (
      <RawTag />
    ) : range || unset ? (
      <>
        {range ? <span className="meta normal-case">{range}</span> : null}
        {unset}
      </>
    ) : null

  return (
    <FieldShell
      kind={kind}
      ids={ids}
      label={label}
      help={kind === "json" ? (help ? `${help} ` : "") + "No form control for this shape. Edit it as JSON." : help}
      errors={own}
      aside={aside}
    >
      <Control {...control} />
    </FieldShell>
  )
}

function RawTag() {
  return <span className="meta">raw JSON</span>
}
