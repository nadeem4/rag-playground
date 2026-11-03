"""pandion-api: Pandion's public API over HTTP, with one Policy for a site's rules.

`create_app(ApiSettings(data_dir=...), policy)` gives a FastAPI app. Every
endpoint that takes a pipeline takes the pipeline file's shape as JSON.
`create_app(settings, policy, mode="serve", pipeline="pipeline.yaml")` instead
serves one fixed pipeline to a site's users. See docs/pandion-api/index.md.
"""

from pandion_api.app import create_app
from pandion_api.policy import Policy
from pandion_api.serve import ServeSettings
from pandion_api.settings import ApiSettings
from pandion_api.version import VERSION as __version__

__all__ = ["ApiSettings", "Policy", "ServeSettings", "create_app", "__version__"]
