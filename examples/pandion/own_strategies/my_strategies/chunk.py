"""per_block: a chunker that makes one piece per block.

A chunker reads a ParsedDoc and returns a ChunkSet: the pieces that are
searched later.
"""

from pydantic import BaseModel

from pandion.extend import ArtifactType, Chunk, ChunkSet, ParsedDoc, PortSpec, Stage, Transform, register

SEPARATOR = "\n\n"


class PerBlockConfig(BaseModel):
    pass


@register
class PerBlock(Transform[PerBlockConfig]):
    name = "per_block"
    stage = Stage.CHUNK
    # A chunker reads the port called `doc`.
    inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
    output = ArtifactType.CHUNK_SET
    config_model = PerBlockConfig
    summary = "Makes one piece from every block, so a piece never mixes two blocks."

    def apply(self, inputs, config, ctx):
        doc = ParsedDoc.model_validate(inputs["doc"])
        blocks = sorted(doc.elements, key=lambda e: e.order)
        # source_text is the text the pieces were cut from, so that
        # source_text[start_char:end_char] is exactly each piece's text.
        source_text = SEPARATOR.join(e.text for e in blocks)
        chunks, start = [], 0
        for n, block in enumerate(blocks):
            end = start + len(block.text)
            chunks.append(Chunk(
                id=f"{doc.source_id[:12]}-{n}",
                text=block.text,
                start_char=start,
                end_char=end,
                ordinal=n,
                doc_id=doc.source_id,
                source_element_ids=[block.id],
            ))
            start = end + len(SEPARATOR)
        return ChunkSet(chunks=chunks, doc_id=doc.source_id, source_text=source_text).model_dump(mode="json")
