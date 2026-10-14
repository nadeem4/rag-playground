"""pandion-api: Pandion's public API over HTTP, with one Policy for a site's rules.

`create_app(ApiSettings(data_dir=...), policy)` gives a FastAPI app. Every
endpoint that takes a pipeline takes the pipeline file's shape as JSON. See
docs/pandion-api.md.
"""

from pandion_api.app import create_app
from pandion_api.policy import Policy
from pandion_api.settings import ApiSettings
from pandion_api.version import VERSION as __version__

__all__ = ["ApiSettings", "Policy", "create_app", "__version__"]
