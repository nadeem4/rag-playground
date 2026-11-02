# Extension examples

One small, tested example for each way to extend Pandion. `tests/integration/test_extension_examples.py` runs them in the fast suite.

| File | Registered name | Extension point |
|---|---|---|
| [`zip_source.py`](zip_source.py) | `zip` | `Source`: documents read from a zip file |
| [`owner_access.py`](owner_access.py) | `team_from_path` | `@access_rule`: the top folder is the role |
| [`json_file_store.py`](json_file_store.py) | `json_file` | `IndexStore`: rows in one JSON file per collection |
| [`../own_strategies/my_strategies/route.py`](../own_strategies/my_strategies/route.py) | `is_invoice` | `@route_check` |

Import a module before you build the pipeline, so its name is registered. A source is used with `pipeline.index.sync(get_source("zip", path="docs.zip"))`, or from `pipeline.yaml` with `source: {use: zip, path: docs.zip}`. An access rule is used with `access: {rules: [team_from_path]}`.

A registered store is proven with `pandion.testing.store_conformance` and used from code with `get_store("json_file", {"folder": "..."})`. It reaches `pipeline.yaml` only through an index step, because `StoreIndex` is not a Stable export.
