"""drop_short: a cleaner that removes blocks shorter than a number of characters.

A cleaner reads a ParsedDoc and returns a ParsedDoc. Cleaners can be stacked:
`clean:` in a pipeline file takes a list.
"""

from pydantic import BaseModel

from pandion.extend import ArtifactType, ParsedDoc, PortSpec, Stage, Transform, register, set_note


class DropShortConfig(BaseModel):
    min_chars: int = 20


@register
class DropShort(Transform[DropShortConfig]):
    name = "drop_short"
    stage = Stage.CLEAN
    # A cleaner reads the port called `doc`.
    inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
    output = ArtifactType.PARSED_DOC
    config_model = DropShortConfig
    summary = "Removes every block with fewer characters than min_chars."

    def apply(self, inputs, config, ctx):
        doc = ParsedDoc.model_validate(inputs["doc"])
        kept = [e for e in doc.elements if len(e.text) >= config.min_chars]
        # A cleaner should always say what it removed. The note is shown with
        # the step's result.
        set_note(ctx, f"Removed {len(doc.elements) - len(kept)} short blocks.")
        doc.elements = kept
        return doc.model_dump(mode="json")
