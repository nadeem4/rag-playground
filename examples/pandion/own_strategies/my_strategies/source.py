"""text_file: a source that reads the one text file at `location`.

A source says where a document comes from. Each item given to `index.run`
becomes one document, and Pandion hands it to the source as `location`.
"""

from pathlib import Path

from pydantic import BaseModel

from pandion.extend import ArtifactType, RunContext, Stage, Transform, raw_file, register


# The settings. Every field needs a default. A source must have a field called
# `location`: that is how Pandion tells it which document to read.
class TextFileConfig(BaseModel):
    location: str = ""
    suffix: str = ".md"


@register
class TextFile(Transform[TextFileConfig]):
    name = "text_file"                 # the name you write in YAML or in code
    stage = Stage.SOURCE                # which stage this strategy is for
    inputs = {}                         # a source reads nothing from another step
    output = ArtifactType.RAW_FILE      # fixed by the stage: a source makes a raw file
    config_model = TextFileConfig
    summary = "Reads the one text file at location, a path on your disk."
    # A file can change while its path stays the same, so never reuse an old
    # read: every run reads the file again. The steps after it are still reused
    # when the bytes did not change.
    cacheable = False

    def apply(self, inputs, config, ctx: RunContext):
        path = Path(config.location)
        if path.suffix != config.suffix:
            raise ValueError(f"text_file reads {config.suffix} files, and {path.name} is not one.")
        # raw_file stores the bytes and returns what every source returns.
        return raw_file(ctx, path.read_bytes(), path.name)
