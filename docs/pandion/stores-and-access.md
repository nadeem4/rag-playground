# Index stores and who may read a document

Who may read a document, and the LanceDB and Qdrant index stores.

[Manual index](index.md) | Previous: [traces](traces.md) | Next: [cli](cli.md)

## Who may read a document

Add an `access:` block to the pipeline file and every document gets roles, and every search
is limited to the roles of the person asking. Without the block, access is off and nothing
changes. Access needs documents added as files (the default `upload` source or `index.sync`
of a folder or a `Source`), because an index row finds its roles by the file's hash.

```yaml
access:
  default: [staff]                        # a document nothing else decides about
  folders:                                # the first match wins; * also matches /
    - {match: "hr/**", roles: [hr]}
  rules: [sharepoint]                     # @access_rule functions, in order
```

A document's roles come from the first of these that has an opinion:

1. a `roles` label on the document, as a comma-separated list (`sync(..., metadata={"hr/a.pdf": {"roles": "hr, legal"}})`,
   or the `roles` metadata of a `SourceEntry`)
2. the first matching entry under `folders`
3. each name under `rules`, in order: the first rule that returns a list
4. `default`

Roles are worked out again on every sync and recorded in `manifest.json` beside the
category (`roles` and `roles_reason`), so a role change reaches the index at the next sync
without parsing the files again. An index built before the block was added is rebuilt once.

An access rule is a function from a `DocumentInfo` to a list of role names, or `None` for no
opinion:

```python
from pandion.extend import DocumentInfo, access_rule

@access_rule("by_title")
def by_title(info: DocumentInfo) -> list[str] | None:
    if info.properties.get("Title", "").startswith("HR"):
        return ["hr"]
    return None   # no opinion: the next rule, then the default
```

List the module under `plugins:` so the rule is registered before the file is checked. A
name under `rules` that is not registered refuses the file. [`owner_access.py`](../../examples/pandion/extensions/owner_access.py)
is a tested rule that gives a document the role of its top folder.

Access fails closed. A rule that raises, or returns anything but a list of role names, gives
that document no roles, and a document with no roles is found by nobody. The reason is kept in
`roles_reason`.

Searches take the caller's roles:

```python
p.retrieve("What is the pay date?", roles=["staff"])
p.ask("What is the pay date?", roles=["hr", "staff"])
```

With an `access:` block, a search without `roles` raises `AccessDenied` before any step runs,
`roles=[]` finds nothing, and `roles=ALL_ROLES` (from `pandion.extend`) skips the filter, for an
admin run. The filter is applied inside the store search, before ranking. The roles are part
of the search step's settings, so two people with different roles never share a cached answer.
Without an `access:` block, `roles` is ignored. Pandion does not read roles from a request; an
app passes the roles of the signed-in user. This does not protect the files on disk, only what
a search returns.

`pandion.evaluate` (and so `pandion eval`, `compare` and review) runs as an admin by default,
so a pipeline with an `access:` block can still be measured. Pass `roles=[...]` to `evaluate` to
measure what one person would see. `pandion retrieve` passes no roles and raises `AccessDenied`
while access is on. A `roles` label is read again on
every sync, so a changed label from a source or from `sync(metadata=...)` applies at the next
sync.

## Index stores

An index store is the place where an index keeps its rows. Pandion defines one contract, `IndexStore` and `Collection`, and you can write a store for the database your team already runs. This contract is **Stable**, and so is `register_store`. The memory store that comes with Pandion is the reference. LanceDB and Qdrant are on the contract. [`examples/pandion/extensions/json_file_store.py`](../../examples/pandion/extensions/json_file_store.py) is a small store you can copy, proven with `pandion.testing.store_conformance`. A registered store is used from code with `get_store`, and reaches `pipeline.yaml` only through an index step.

A row (`IndexRow`) holds an id, the document id and version, the text, the vector, the `roles` that may see it, some metadata, and the chunk as JSON. Keys that start with `source_` in the metadata belong to Pandion: the built-in index steps write the document id and labels there (see [Sync from a source](index-and-search.md#sync-from-a-source)), so a store should keep every metadata key it is given. A row with an empty `roles` list is visible to nobody. A search takes a filter built from `Eq`, `In`, `AnyOf` and `And`, and the store must apply it before it ranks. Roles use `AnyOf("roles", (...))`, so every store must support `any_of`.

A store says what it can do in `Capabilities`: whether it can change one document at a time, whether it has text search, which filters it has, and which metrics it has. Pandion refuses a pairing the store cannot serve. A store with no text search cannot be used with BM25 or hybrid retrieval.

```python
from pydantic import BaseModel
from pandion.extend import register_store


class MySettings(BaseModel):
    url: str = "http://localhost:6333"


@register_store
class MyStore:
    name = "mine"
    settings_model = MySettings

    def __init__(self, settings: MySettings): ...
    # capabilities, create, open, drop and list, as in pandion.index_store.IndexStore
```

Prove your store with the conformance suite, the same one the memory store passes. It includes the check that a row with no roles is never returned.

```python
from pandion.testing import store_conformance

store_conformance(lambda: MyStore(MySettings()))
```

`pandion plugins` lists every store, with the kind `store`.

### The LanceDB store

`store: lancedb` is the store behind the `lancedb` index step. Its settings are `location`, a local path, `s3://...` or `gs://...`, and `fts`, which builds the keyword index (leave it on if you use BM25 or hybrid retrieval). It is incremental, so one document can be replaced or deleted without a rebuild, and it filters by `eq`, `in`, `any_of` and `and` before it ranks. A metadata key keeps the type of its first value, and the names `id`, `doc_id`, `doc_version`, `text`, `vector`, `roles`, `chunk` and `chunk_json` are row fields, so a row refuses a metadata key with one of those names.

The `lancedb` step builds through this store (step version 4), so an index built by an older Pandion rebuilds once, from the cached embeddings. Nothing else changes in a pipeline file.

The index result is no longer a LanceDB folder. It is a small JSON binding that names the store, its settings (never a secret), the collection and the recipe hash. The pipeline's own index folder is not kept in it, so the pipeline folder can move; the retriever is told where the folder is when it opens the binding. The collection is named from the recipe hash and the result id, so two sets of documents never share one, and a forced rerun replaces only its own. The retrievers open the collection through the binding and search it through the store contract: `dense` uses `search_dense`, `bm25` uses `search_lexical`, and `hybrid_rrf` uses both. Clearing the result store does not delete collections; they live in the store. A retriever whose store cannot serve it (for example `bm25` on an index built with `build_fts: false`) fails with a message that says what to change.

When access is on, the roles of the person searching come from the pipeline (the `roles=` you pass), not from the question's filters, so a custom rewrite step that drops `filters` cannot widen a search. Every retriever filters by those roles in the store and then checks each returned row again. A row the store should not have returned is dropped, and its id (never its text) is logged on the `pandion.access` logger. `hybrid_rrf` checks before it fuses. An empty role list finds nothing.

### The Qdrant store

`store: qdrant` is the store behind the `qdrant` index step. Install it with `pip install "pandion[qdrant]"`. It is the same step as `lancedb` (same settings, `embedder`, `truncate_dim`, `metric`, `build_fts`), with the rows in Qdrant, and the same three retrievers read it. `metric` can also be `dot`.

```yaml
index:
  embed: {use: qwen3-embedding-0.6b}
  store:
    use: qdrant
    metric: cosine
    settings: {url: "http://qdrant.internal:6333", api_key_env: QDRANT_API_KEY, prefix: support-bot}
```

The `settings` are `url` (a Qdrant server; it wins over `location`), `location` (a folder; with no server), `api_key_env` (the name of an environment variable that holds the key; the key itself is never in the pipeline file or in the index result) and `prefix` (every Qdrant collection is named `<prefix>__<name>`, so two pipelines can share one server). With no `url` and no `location`, the step keeps its rows in a folder beside the pipeline's index, the same place `lancedb` uses. A pipeline file does not expand `${VAR}`: write the url, and keep only the key in the environment. Never put a key inside the url; use `api_key_env`. `:memory:` is a location for the store in code (tests, `QdrantStore` used directly); a pipeline step with no place given uses its folder, because memory would vanish before a search could open it. `build_fts: false` leaves the keyword index out, so the store has no text search and `bm25` and `hybrid_rrf` are refused when the file is read.

| | LanceDB | Qdrant, in a folder | Qdrant, on a server |
|---|---|---|---|
| Needs a server | no | no | yes |
| Text search | yes (full-text index) | yes (bm25-like) | yes (bm25-like) |
| Change one document | yes | yes | yes |
| Filters | `eq`, `in`, `any_of`, `and` | the same | the same |
| Metrics | cosine, dot, l2 | the same | the same |
| Best for | one machine, or object storage | one process on one machine | a team, many servers |

A folder holds one open Qdrant at a time, so use a server when more than one process reads the index. Text search in Qdrant is a sparse-vector search with an IDF weight, which is bm25-like: it has no length normalisation, so its scores differ a little from LanceDB's. Both embedded and server mode accept it (checked on qdrant-client 1.20). If a store ever has no text search, a pipeline that pairs it with `bm25` or `hybrid_rrf` is refused when the file is read, with a sentence that says so. A cosine collection stores its vectors scaled to length 1, so a row comes back with its vector scaled that way.

A filter on a list-valued field with `eq` or `in` matches if any element matches in Qdrant, where the memory store matches nothing; use `any_of` for lists (roles and pages do). `in` takes whole numbers and text, not decimals.

To run the store tests against a real server, set `QDRANT_URL`, for example `QDRANT_URL=http://localhost:6333 uv run pytest packages/pandion/tests/test_index_qdrant.py`. Without it that one test is skipped.
