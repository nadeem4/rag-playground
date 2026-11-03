"""The server: run it with `uvicorn serve:app`.

It serves the one pipeline in pipeline.yaml. Who is asking is decided by
policy.py. Settings come from pipeline.yaml and environment variables:

    DATABASE_URL   a SQLAlchemy url for the conversation store (default: SQLite in index/)
    MODELS_DIR     where `pandion models pull` put the models (default /models)
"""

import os
from pathlib import Path

from pandion import ModelSettings
from pandion.extend import get_conversation_store
from pandion_api import ApiSettings, ServeSettings, create_app

from policy import GatewayPolicy

HERE = Path(__file__).resolve().parent


def make_app(policy=None, settings=None):
    """The app. Tests pass `policy=Policy.anonymous()` and their own `settings`."""
    settings = settings or ApiSettings(
        data_dir=HERE / "index",
        models=ModelSettings(download="never", cache_dir=Path(os.environ.get("MODELS_DIR", "/models"))),
    )
    conversations = get_conversation_store("sql", {"url_env": "DATABASE_URL"}) if os.environ.get("DATABASE_URL") else None
    return create_app(
        settings,
        policy or GatewayPolicy(),
        mode="serve",
        pipeline=HERE / "pipeline.yaml",
        conversations=conversations,
        serve=ServeSettings(),
    )


app = make_app()
