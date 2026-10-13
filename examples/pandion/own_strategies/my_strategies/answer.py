"""bullets: an answer step that lists the pieces found as bullets.

An answer step reads the hits and returns an Output. Put the answer's text in
payload["text"], and `p.ask(question).text` gives it back.
"""

from pydantic import BaseModel

from pandion.extend import ArtifactType, Output, PortSpec, RetrievalResult, Stage, Transform, register


class BulletsConfig(BaseModel):
    top_k: int = 3


@register
class Bullets(Transform[BulletsConfig]):
    name = "bullets"
    stage = Stage.USE_CASE
    # An answer reads the port called `result`. To read the parsed document as
    # well, declare a `doc` input, as a rewrite can.
    inputs = {"result": PortSpec(ArtifactType.RETRIEVAL_RESULT)}
    output = ArtifactType.OUTPUT
    config_model = BulletsConfig
    summary = "Lists the top pieces found, one bullet each."

    def apply(self, inputs, config, ctx):
        result = RetrievalResult.model_validate(inputs["result"])
        text = "\n".join(f"- {hit.chunk.text}" for hit in result.hits[: config.top_k])
        return Output(kind="text", payload={"text": text}).model_dump(mode="json")
