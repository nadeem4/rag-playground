import { useState } from "react"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"

import registryJson from "@/api/fixtures/registry.json"
import type { JsonSchema, Registry } from "@/api/types"
import { SchemaForm } from "./SchemaForm"
import { defaultsFor, describeField, errorsFromPydantic, isShown } from "./fields/schema"

const registry = registryJson as unknown as Registry

afterEach(cleanup)

type Config = Record<string, unknown>

/** A stateful host, so the form behaves as it does in the app. */
function renderForm(schema: JsonSchema, initial?: Config, errors?: Record<string, string[]>) {
  const onChange = vi.fn<(v: Config) => void>()
  function Host() {
    const [value, setValue] = useState<Config | undefined>(initial)
    return (
      <SchemaForm
        schema={schema}
        value={value}
        errors={errors}
        onChange={(v) => {
          onChange(v)
          setValue(v)
        }}
      />
    )
  }
  const utils = render(<Host />)
  const last = () => onChange.mock.calls.at(-1)?.[0]
  return { ...utils, onChange, last }
}

const obj = (properties: Record<string, JsonSchema>, extra: Partial<JsonSchema> = {}): JsonSchema => ({
  type: "object",
  title: "TestConfig",
  properties,
  ...extra,
})

const plugins = Object.entries(registry).flatMap(([stage, byName]) =>
  Object.values(byName ?? {}).map((info) => [`${stage}/${info.name}`, info.config_schema] as const),
)

describe("every registered plugin", () => {
  it("the fixture is not empty", () => {
    expect(plugins.length).toBeGreaterThanOrEqual(14)
  })

  it.each(plugins)("%s renders with no JSON fallback", (_name, schema) => {
    const { container, last } = renderForm(schema)
    expect(container.querySelector('[data-field-kind="json"]')).toBeNull()
    for (const prop of Object.values(schema.properties ?? {})) {
      expect(describeField(prop, schema).kind).not.toBe("json")
    }
    // Every property shown at the defaults got a control (x-show-when may hide some),
    // and the form emitted exactly the defaults.
    const defaults = defaultsFor(schema, schema) as Record<string, unknown>
    const shown = Object.values(schema.properties ?? {}).filter((prop) => isShown(prop, defaults))
    expect(container.querySelectorAll("[data-field-kind]").length).toBe(shown.length)
    expect(last()).toEqual(defaultsFor(schema, schema))
  })
})

describe("defaults", () => {
  it("rendering with no value emits exactly the schema defaults", () => {
    const schema = registry.index!.lancedb.config_schema
    const { onChange } = renderForm(schema)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0]).toEqual({
      embedder: "qwen3-embedding-0.6b",
      truncate_dim: null,
      metric: "cosine",
      build_fts: true,
    })
  })

  it("does not emit on mount when a value is given", () => {
    const { onChange } = renderForm(obj({ a: { type: "integer", default: 1, title: "A" } }), { a: 7 })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByLabelText("A")).toHaveProperty("value", "7")
  })
})

describe("supported types", () => {
  it("string", () => {
    const { last } = renderForm(obj({ name: { type: "string", default: "x", title: "Name", description: "Model id" } }))
    const input = screen.getByLabelText("Name")
    expect(screen.getByText("Model id")).toBeTruthy()
    fireEvent.change(input, { target: { value: "bge-small" } })
    expect(last()).toEqual({ name: "bge-small" })
  })

  it("integer, mono and tabular", () => {
    const { last } = renderForm(obj({ k: { type: "integer", default: 5, title: "Top K" } }))
    const input = screen.getByLabelText("Top K") as HTMLInputElement
    expect(input.type).toBe("number")
    expect(input.step).toBe("1")
    expect(input.className).toContain("font-mono")
    expect(input.className).toContain("tabular-nums")
    fireEvent.change(input, { target: { value: "12" } })
    expect(last()).toEqual({ k: 12 })
  })

  it("integer rejects a fraction", () => {
    renderForm(obj({ k: { type: "integer", default: 5, title: "Top K" } }))
    fireEvent.change(screen.getByLabelText("Top K"), { target: { value: "1.5" } })
    expect(screen.getByText("Must be a whole number")).toBeTruthy()
  })

  it("number", () => {
    const { last } = renderForm(obj({ r: { type: "number", default: 0.5, title: "Ratio" } }))
    fireEvent.change(screen.getByLabelText("Ratio"), { target: { value: "0.25" } })
    expect(last()).toEqual({ r: 0.25 })
  })

  it("boolean", () => {
    const { last } = renderForm(obj({ drop: { type: "boolean", default: true, title: "Drop" } }))
    const box = screen.getByLabelText("Drop") as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    expect(last()).toEqual({ drop: false })
  })

  it("inline enum from Literal", () => {
    const { last } = renderForm(
      obj({ scope: { type: "string", enum: ["exact", "near"], default: "exact", title: "Scope" } }),
    )
    const select = screen.getByLabelText("Scope") as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual(["exact", "near"])
    fireEvent.change(select, { target: { value: "near" } })
    expect(last()).toEqual({ scope: "near" })
  })

  it("single-value Literal (const) renders as read-only text, not a control", () => {
    const { container, last } = renderForm(obj({ mode: { const: "text", default: "text", type: "string", title: "Mode" } }))
    expect(screen.queryByRole("combobox")).toBeNull()
    expect(container.querySelector("select, input, textarea")).toBeNull()
    const shown = screen.getByLabelText("Mode")
    expect(shown.tagName).toBe("OUTPUT")
    expect(shown.textContent).toBe("text")
    expect(shown.className).toContain("font-mono")
    // Still part of the config the backend receives.
    expect(last()).toEqual({ mode: "text" })
  })

  it("an enum with exactly one value renders as read-only text", () => {
    const { last } = renderForm(obj({ fmt: { type: "string", enum: ["markdown"], default: "markdown", title: "Format" } }))
    expect(screen.queryByRole("combobox")).toBeNull()
    expect(screen.getByLabelText("Format").textContent).toBe("markdown")
    expect(last()).toEqual({ fmt: "markdown" })
  })

  it("an enum with two values still renders a select", () => {
    renderForm(obj({ fmt: { type: "string", enum: ["a", "b"], default: "a", title: "Format" } }))
    expect(screen.getByRole("combobox", { name: "Format" })).toBeTruthy()
  })

  it("non-string enum keeps its value type", () => {
    const { last } = renderForm(obj({ n: { enum: [1, 2, 4], default: 1, title: "N" } }))
    fireEvent.change(screen.getByLabelText("N"), { target: { value: "1" } })
    fireEvent.change(screen.getByLabelText("N"), { target: { value: "2" } })
    expect(last()).toEqual({ n: 2 })
  })
})

describe("Optional (anyOf with null)", () => {
  const schema = obj({
    dim: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }], default: null, title: "Truncate Dim" },
  })

  it("unwraps to the inner type", () => {
    const f = describeField(schema.properties!.dim, schema)
    expect(f.kind).toBe("integer")
    expect(f.nullable).toBe(true)
    expect(f.schema.minimum).toBe(1)
    expect(f.schema.title).toBe("Truncate Dim")
  })

  it("starts unset, can be set, and can be set back to null", () => {
    const { last } = renderForm(schema)
    const input = screen.getByLabelText("Truncate Dim") as HTMLInputElement
    const unset = screen.getByRole("checkbox", { name: /unset/i }) as HTMLInputElement
    expect(unset.checked).toBe(true)
    expect(input.disabled).toBe(true)
    expect(last()).toEqual({ dim: null })

    fireEvent.click(unset)
    expect(input.disabled).toBe(false)
    expect(last()).toEqual({ dim: 1 })
    fireEvent.change(input, { target: { value: "256" } })
    expect(last()).toEqual({ dim: 256 })

    fireEvent.click(unset)
    expect(last()).toEqual({ dim: null })
    expect(input.value).toBe("")
  })

  it("does not flag an unset optional as missing", () => {
    renderForm(schema)
    expect(screen.queryByText("Required")).toBeNull()
  })
})

describe("$ref resolution", () => {
  const schema: JsonSchema = {
    type: "object",
    title: "RefConfig",
    $defs: {
      Metric: { enum: ["cosine", "l2", "dot"], title: "Metric", type: "string" },
      Inner: {
        type: "object",
        title: "Inner",
        properties: { size: { type: "integer", default: 3, title: "Size" } },
      },
    },
    properties: {
      metric: { $ref: "#/$defs/Metric", default: "l2" },
      maybe: { anyOf: [{ $ref: "#/$defs/Metric" }, { type: "null" }], default: null, title: "Maybe Metric" },
      inner: { $ref: "#/$defs/Inner" },
      legacy: { allOf: [{ $ref: "#/$defs/Metric" }], default: "dot", title: "Legacy" },
    },
  }

  it("resolves enum refs, optional refs, allOf refs and nested model refs", () => {
    const { container, last } = renderForm(schema)
    expect(container.querySelector('[data-field-kind="json"]')).toBeNull()
    expect((screen.getByLabelText("Metric") as HTMLSelectElement).value).toBe("l2")
    expect(describeField(schema.properties!.maybe, schema)).toMatchObject({ kind: "enum", nullable: true })
    expect((screen.getByLabelText("Legacy") as HTMLSelectElement).value).toBe("dot")
    expect(screen.getByLabelText("Size")).toBeTruthy()
    expect(last()).toEqual({ metric: "l2", maybe: null, inner: { size: 3 }, legacy: "dot" })

    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "9" } })
    expect(last()).toEqual({ metric: "l2", maybe: null, inner: { size: 9 }, legacy: "dot" })
  })

  it("an unresolvable ref falls back to JSON", () => {
    expect(describeField({ $ref: "#/$defs/Missing" }, { type: "object" }).kind).toBe("json")
  })
})

describe("numeric constraints", () => {
  const schema = obj({
    ratio: { type: "number", minimum: 0, maximum: 1, default: 0.5, title: "Ratio" },
    temp: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 2, default: 1, title: "Temp" },
  })

  it("sets native min and max", () => {
    renderForm(schema)
    const input = screen.getByLabelText("Ratio") as HTMLInputElement
    expect(input.min).toBe("0")
    expect(input.max).toBe("1")
  })

  it("validates minimum and maximum below the field", () => {
    renderForm(schema)
    const input = screen.getByLabelText("Ratio")
    fireEvent.change(input, { target: { value: "1.4" } })
    expect(screen.getByText("Must be at most 1")).toBeTruthy()
    expect(input.getAttribute("aria-invalid")).toBe("true")
    fireEvent.change(input, { target: { value: "-0.1" } })
    expect(screen.getByText("Must be at least 0")).toBeTruthy()
    fireEvent.change(input, { target: { value: "0.3" } })
    expect(screen.queryByText(/Must be/)).toBeNull()
    expect(input.getAttribute("aria-invalid")).toBeNull()
  })

  it("validates exclusive bounds", () => {
    renderForm(schema)
    const input = screen.getByLabelText("Temp")
    fireEvent.change(input, { target: { value: "0" } })
    expect(screen.getByText("Must be greater than 0")).toBeTruthy()
    fireEvent.change(input, { target: { value: "2" } })
    expect(screen.getByText("Must be less than 2")).toBeTruthy()
  })

  it("an emptied required number is flagged, not silently kept", () => {
    const { last } = renderForm(schema)
    fireEvent.change(screen.getByLabelText("Ratio"), { target: { value: "" } })
    expect(last()).toMatchObject({ ratio: null })
    expect(screen.getByText("Required")).toBeTruthy()
  })
})

describe("JSON fallback", () => {
  const schema = obj({
    tags: { type: "array", items: { type: "string" }, default: ["a"], title: "Tags" },
  })

  it("renders unsupported shapes as a labelled raw JSON textarea", () => {
    const { container, last } = renderForm(schema)
    const field = container.querySelector('[data-field-kind="json"]') as HTMLElement
    expect(field).not.toBeNull()
    expect(within(field).getByText(/raw json/i)).toBeTruthy()
    const area = screen.getByLabelText("Tags") as HTMLTextAreaElement
    expect(area.tagName).toBe("TEXTAREA")
    expect(JSON.parse(area.value)).toEqual(["a"])

    fireEvent.change(area, { target: { value: '["a", "b"]' } })
    expect(last()).toEqual({ tags: ["a", "b"] })
  })

  it("keeps the last good value and says so on invalid JSON", () => {
    const { last } = renderForm(schema)
    fireEvent.change(screen.getByLabelText("Tags"), { target: { value: '["a",' } })
    expect(last()).toEqual({ tags: ["a"] })
    expect(screen.getByText(/not valid json/i)).toBeTruthy()
  })

  it("a union of two real types falls back", () => {
    expect(describeField({ anyOf: [{ type: "integer" }, { type: "string" }] }, {}).kind).toBe("json")
  })
})

describe("nesting", () => {
  const schema = obj({
    top: { type: "integer", default: 1, title: "Top" },
    outer: {
      type: "object",
      title: "Outer",
      properties: {
        mid: { type: "integer", default: 2, title: "Mid" },
        deep: {
          type: "object",
          title: "Deep",
          properties: { leaf: { type: "boolean", default: false, title: "Leaf" } },
        },
      },
    },
  })

  it("level two is an inline group, level three collapses behind a disclosure", () => {
    const { container, last } = renderForm(schema)
    const group = container.querySelector('[data-field-kind="object"][data-depth="2"]') as HTMLElement
    expect(group.tagName).toBe("FIELDSET")
    expect(group.closest("details")).toBeNull()

    const deep = container.querySelector('[data-field-kind="object"][data-depth="3"]') as HTMLElement
    const details = deep.closest("details") as HTMLDetailsElement
    expect(details).not.toBeNull()
    expect(details.open).toBe(false)
    expect(within(details).getByText("Deep", { selector: "summary *, summary" })).toBeTruthy()
    expect(details.contains(screen.getByLabelText("Leaf"))).toBe(true)
    expect(screen.getByLabelText("Mid").closest("details")).toBeNull()

    expect(last()).toEqual({ top: 1, outer: { mid: 2, deep: { leaf: false } } })
    fireEvent.click(screen.getByLabelText("Leaf"))
    expect(last()).toEqual({ top: 1, outer: { mid: 2, deep: { leaf: true } } })
  })
})

describe("server errors", () => {
  // Captured from the engine: RecursiveCharacterConfig(chunk_size=0, chunk_overlap=-5).
  const pydantic = [
    { type: "greater_than_equal", loc: ["chunk_size"], msg: "Input should be greater than or equal to 1", input: 0, ctx: { ge: 1 } },
    { type: "greater_than_equal", loc: ["chunk_overlap"], msg: "Input should be greater than or equal to 0", input: -5, ctx: { ge: 0 } },
    { type: "missing", loc: ["outer", "mid"], msg: "Field required" },
  ]

  it("keys Pydantic errors by field path", () => {
    expect(errorsFromPydantic(pydantic)).toEqual({
      chunk_size: ["Input should be greater than or equal to 1"],
      chunk_overlap: ["Input should be greater than or equal to 0"],
      "outer.mid": ["Field required"],
    })
  })

  it("renders each error below its own input", () => {
    const schema = registry.chunk!.recursive_character.config_schema
    renderForm(schema, { chunk_size: 0, chunk_overlap: -5 }, errorsFromPydantic(pydantic))
    for (const [label, msg] of [
      ["Chunk Size", "Input should be greater than or equal to 1"],
      ["Chunk Overlap", "Input should be greater than or equal to 0"],
    ]) {
      const input = screen.getByLabelText(label)
      const error = screen.getByText(msg)
      expect(input.getAttribute("aria-invalid")).toBe("true")
      expect(input.getAttribute("aria-describedby")).toContain(error.id)
      // Same field block, and the error comes after the input.
      expect(input.closest("[data-field-kind]")).toBe(error.closest("[data-field-kind]"))
      expect(input.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })

  it("renders errors on nested paths under the nested input", () => {
    const schema = obj({
      outer: { type: "object", title: "Outer", properties: { mid: { type: "integer", default: 2, title: "Mid" } } },
    })
    renderForm(schema, undefined, { "outer.mid": ["Field required"] })
    const error = screen.getByText("Field required")
    expect(error.closest("[data-field-kind]")).toBe(screen.getByLabelText("Mid").closest("[data-field-kind]"))
  })
})

describe("form rules", () => {
  it("labels sit above inputs and no input uses a placeholder", () => {
    const { container } = renderForm(registry.clean!.header_footer_strip.config_schema)
    for (const input of container.querySelectorAll("input:not([type=checkbox]), select, textarea")) {
      expect(input.getAttribute("placeholder")).toBeNull()
      const label = container.querySelector(`label[for="${input.id}"]`)!
      expect(label.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })

  it("no visible string contains an em or en dash", () => {
    const { container } = renderForm(registry.clean!.dedupe_blocks.config_schema)
    expect(container.textContent).not.toMatch(new RegExp("[\\u2013\\u2014]"))
  })
})

describe("x-show-when", () => {
  const schema = obj({
    kind: { type: "string", enum: ["a", "other"], default: "a", title: "Kind" },
    extra: { type: "string", default: "", title: "Extra", "x-show-when": { kind: "other" } },
    always: { type: "string", default: "", title: "Always" },
  })

  it("isShown matches every key against the current values", () => {
    expect(isShown({ "x-show-when": { kind: "other" } }, { kind: "other" })).toBe(true)
    expect(isShown({ "x-show-when": { kind: "other" } }, { kind: "a" })).toBe(false)
    expect(isShown({ "x-show-when": { kind: "other", n: 2 } }, { kind: "other", n: 3 })).toBe(false)
    expect(isShown({}, {})).toBe(true)
    expect(isShown({ "x-show-when": "nonsense" }, {})).toBe(true)
  })

  it("hides the field until the condition holds, and keeps its value in the config", () => {
    const { last } = renderForm(schema)
    expect(screen.queryByLabelText("Extra")).toBeNull()
    expect(screen.getByLabelText("Always")).toBeTruthy()
    expect(last()).toEqual({ kind: "a", extra: "", always: "" })
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "other" } })
    fireEvent.change(screen.getByLabelText("Extra"), { target: { value: "x" } })
    expect(last()).toEqual({ kind: "other", extra: "x", always: "" })
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "a" } })
    expect(screen.queryByLabelText("Extra")).toBeNull()
    expect(last()).toEqual({ kind: "a", extra: "x", always: "" })
  })

  it("works inside a nested object, against that object's values", () => {
    renderForm(obj({ inner: { type: "object", title: "Inner", properties: schema.properties!, default: { kind: "other" } } }))
    expect(screen.getByLabelText("Extra")).toBeTruthy()
  })
})

describe("x-labels", () => {
  it("shows a label per option when the schema has one, the id otherwise, and emits the id", () => {
    const { last } = renderForm(
      obj({
        model: { type: "string", enum: ["m-1", "m-2"], default: "m-1", title: "Model", "x-labels": { "m-1": "Model One" } },
      }),
    )
    const select = screen.getByLabelText("Model") as HTMLSelectElement
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ["m-1", "Model One"],
      ["m-2", "m-2"],
    ])
    fireEvent.change(select, { target: { value: "m-2" } })
    expect(last()).toEqual({ model: "m-2" })
  })
})
