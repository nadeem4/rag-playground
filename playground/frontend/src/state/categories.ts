import { categoriesOf, withCategory, type CategoryDef, type PipelineConfig } from "./config"
import type { Sorted } from "./sorting"
import type { DocRef } from "./sourceDocs"
import type { IndexTemplate } from "./templates"

/** Operations on a pipeline's categories. Each returns a new config and leaves the old one as it was. */

/** The documents in category `id`: pinned there, or sorted there when not pinned. */
export function usedBy(docs: readonly DocRef[], sorted: Sorted, id: string): DocRef[] {
  return docs.filter((d) => (d.category ?? sorted[d.sha]?.category) === id)
}

/** An id from a name that no category has yet: `big-tables`, then `big-tables-2`, `big-tables-3`. */
function freshId(config: PipelineConfig, name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "category"
  const taken = categoriesOf(config)
  let id = base
  for (let n = 2; id in taken; n++) id = `${base}-${n}`
  return id
}

/** A copy of category `from` under a new name. */
export function copyCategory(config: PipelineConfig, from: string, name: string): { config: PipelineConfig; id: string } {
  const id = freshId(config, name)
  return { config: withCategory(config, id, { ...categoriesOf(config)[from], name }), id }
}

/** A new category with a template's settings; `template` records where it came from. */
export function addFromTemplate(config: PipelineConfig, template: IndexTemplate): { config: PipelineConfig; id: string } {
  const id = freshId(config, template.name)
  const def: CategoryDef = { name: template.name, template: template.id, ...template.pipeline.category }
  return { config: withCategory(config, id, def), id }
}

export function renameCategory(config: PipelineConfig, id: string, name: string): PipelineConfig {
  return withCategory(config, id, { ...categoriesOf(config)[id], name })
}

/** Remove a category nobody uses and no route names, and never the last one. */
export function removeCategory(config: PipelineConfig, id: string, users: readonly DocRef[]): { ok: true; config: PipelineConfig } | { ok: false; problem: string } {
  const cats = categoriesOf(config)
  const name = cats[id]?.name ?? id
  if (users.length) return { ok: false, problem: `${name} is used by ${users.map((d) => d.filename).join(", ")}. Move them to another category first.` }
  const rule = (config.route ?? []).findIndex((r) => r.category === id)
  if (rule >= 0) return { ok: false, problem: `Rule ${rule + 1} sends documents to ${name}. Change the rule first.` }
  const rest = Object.entries(cats).filter(([k]) => k !== id)
  if (!rest.length) return { ok: false, problem: "A pipeline needs at least one category." }
  const [lastId, lastDef] = rest[rest.length - 1]
  // Setting the last one again lets `withCategory` fall back to the old shape when only a plain default is left.
  return { ok: true, config: withCategory({ ...config, categories: Object.fromEntries(rest) }, lastId, lastDef) }
}

/** Copy category `from` under `name` and pin only document `sha` to the copy. */
export function moveToNew(config: PipelineConfig, docs: DocRef[], sha: string, from: string, name: string): { config: PipelineConfig; docs: DocRef[] } {
  const made = copyCategory(config, from, name)
  return { config: made.config, docs: docs.map((d) => (d.sha === sha ? { ...d, category: made.id } : d)) }
}
