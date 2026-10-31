"""is_invoice: a route check that is true when a file's name starts with a prefix.

A check reads a `DocumentInfo` (the cheap facts about a file) and its settings,
and returns True or False. A route uses it by name: `when: {use: is_invoice}`.
Registering a check with `@route_check` is all it needs.
"""

from pydantic import BaseModel

from pandion.extend import DocumentInfo, route_check


class IsInvoiceConfig(BaseModel):
    prefix: str = "INV"


@route_check("is_invoice", summary="The file name starts with a prefix, such as INV.", config=IsInvoiceConfig)
def is_invoice(info: DocumentInfo, settings: IsInvoiceConfig) -> bool:
    return info.filename.lower().startswith(settings.prefix.lower())
