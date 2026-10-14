"""A request's pipeline dict, made safe to run on this server.

The server decides where every pipeline keeps its files (`ApiSettings.data_dir`)
and how models load (`ApiSettings.models`); a request's own `path` and `models`
are replaced. A request cannot name modules to import (`plugins`): that would
run code the request chose. Then the site's Policy has its say.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, Request

from pandion import ConfigError, Pipeline
from pandion.evaluation import COMPARE_STAGES

NOT_A_MAPPING = "The pipeline must be a mapping of settings, in the pipeline file's shape."
PLUGINS_REFUSED = (
    "A request cannot load plugins: the server loads its strategies itself, from its "
    "own code or from installed packages. Leave plugins out."
)
MODELS_NOT_A_MAPPING = "models must be a mapping of settings."


def problems(*sentences: str) -> HTTPException:
    """A 422 whose detail lists what is wrong, one sentence each."""
    return HTTPException(status_code=422, detail={"problems": list(sentences)})


def prepare(config: Any, request: Request) -> Pipeline:
    """The pipeline to run for this request, or the HTTP error that says why not."""
    settings = request.app.state.settings
    policy = request.app.state.policy
    if not isinstance(config, dict):
        raise problems(NOT_A_MAPPING)
    if "plugins" in config:
        raise problems(PLUGINS_REFUSED)
    if config.get("models") is not None and not isinstance(config["models"], dict):
        # The server's models replace it, but a request that sends a broken
        # block is told, as a pipeline file with one would be.
        raise problems(MODELS_NOT_A_MAPPING)
    models = {
        **settings.models.model_dump(mode="json"),
        "public_endpoints_only": policy.public_endpoints_only(request),
    }
    data = {**config, "path": str(settings.data_dir), "models": models}
    try:
        p = Pipeline.from_dict(data, base=settings.data_dir)
    except ConfigError as exc:
        raise problems(policy.scrub(str(exc))) from None
    policy.check_run(p.to_dict(), request)
    return p


def public(p: Pipeline) -> dict[str, Any]:
    """The pipeline in the file's shape, without the server's folder and models."""
    data = p.to_dict()
    data.pop("path", None)
    data.pop("models", None)
    return data


def variant_config(config: dict[str, Any], stage: str, variant: Any) -> dict[str, Any]:
    """`config` with one stage replaced by `variant`, as compare runs it."""
    section = COMPARE_STAGES[stage]
    current = config.get(section)
    return {**config, section: {**(current if isinstance(current, dict) else {}), stage: variant}}
