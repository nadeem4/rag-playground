"""zip: a Source that reads the documents inside one zip file.

A Source lists documents (an id and a version each, no bytes) and reads one on
request. `index.sync(source)` reads only the entries that are new or changed.
"""

import zipfile
from typing import ClassVar, Iterable


from pandion.extend import SourceEntry, register_source


@register_source
class ZipSource:
    name: ClassVar[str] = "zip"

    def __init__(self, location: str) -> None:
        # `location` is the name a pipeline file's relative paths are resolved by.
        self.location = location

    def list(self) -> Iterable[SourceEntry]:
        with zipfile.ZipFile(self.location) as z:
            infos = [i for i in z.infolist() if not i.is_dir()]
        # The version must change whenever the content does: the crc and size do.
        return [
            SourceEntry(i.filename, f"{i.CRC}-{i.file_size}", {"path": i.filename})
            for i in sorted(infos, key=lambda i: i.filename)
        ]

    def read(self, doc_id: str) -> bytes:
        with zipfile.ZipFile(self.location) as z:
            try:
                return z.read(doc_id)
            except KeyError:
                raise ValueError(f"The zip file has no entry named '{doc_id}'.") from None
