"""lowercase: a rewrite that lowercases the question before the search.

A rewrite is the step that makes the question the search uses. It returns a
Query.
"""

from pydantic import BaseModel

from pandion.extend import ArtifactType, Query, Stage, Transform, register


# A rewrite must have a `text` field: Pandion puts the question there when you
# call p.retrieve or p.ask. Do not set it in the pipeline file.
class LowercaseConfig(BaseModel):
    text: str = ""


@register
class Lowercase(Transform[LowercaseConfig]):
    name = "lowercase"
    stage = Stage.QUERY
    # A rewrite reads nothing from another step. To read the parsed document,
    # declare a `doc` input: {"doc": PortSpec(ArtifactType.PARSED_DOC, ambient=True, required=False)}.
    inputs = {}
    output = ArtifactType.QUERY
    config_model = LowercaseConfig
    summary = "Lowercases the question, and keeps the question as typed for the answer."

    def apply(self, inputs, config, ctx):
        # `text` is what the search uses; `original` is the question as typed.
        return Query(text=config.text.lower(), original=config.text).model_dump(mode="json")
