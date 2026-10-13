"""markdown: a parser that turns a markdown file into blocks.

A parser reads the stored file and returns a ParsedDoc: the document as a list
of blocks (Elements) in reading order.
"""

from pathlib import Path

from pydantic import BaseModel

from pandion.extend import ArtifactType, Element, ParsedDoc, PortSpec, Stage, Transform, register


# No settings, but a parser still needs a settings model.
class MarkdownConfig(BaseModel):
    pass


@register
class Markdown(Transform[MarkdownConfig]):
    name = "markdown"
    stage = Stage.PARSE
    # A parser reads the port called `file`: a dict with sha, filename, path
    # and mime. The bytes are at inputs["file"]["path"].
    inputs = {"file": PortSpec(ArtifactType.RAW_FILE)}
    output = ArtifactType.PARSED_DOC
    config_model = MarkdownConfig
    summary = "Makes one block per paragraph; a line that starts with # is a heading."

    def apply(self, inputs, config, ctx):
        file = inputs["file"]
        text = Path(file["path"]).read_text(encoding="utf-8")
        elements = []
        for paragraph in (p.strip() for p in text.split("\n\n")):
            if not paragraph:
                continue
            n = len(elements)
            if paragraph.startswith("#"):
                level = len(paragraph) - len(paragraph.lstrip("#"))
                block = Element(id=f"e{n}", type="heading", text=paragraph.lstrip("#").strip(), order=n, level=level)
            else:
                block = Element(id=f"e{n}", type="paragraph", text=paragraph, order=n)
            elements.append(block)
        # source_id names the document; the chunker copies it onto every piece.
        doc = ParsedDoc(elements=elements, source_id=file["sha"], filename=file["filename"])
        return doc.model_dump(mode="json")
