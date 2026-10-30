"""A request's pipeline dict, made safe to run on this server.

The server decides where every pipeline keeps its files (`ApiSettings.data_dir`)
and how models load (`ApiSettings.models`); a request's own `path` and `models`
are replaced. A request cannot name modules to import (`plugins`): that would
run code the request chose. Then the site's Policy has its say.
"""

from __future__ import annotations

import copy
from typing import Any

import yaml
from fastapi import HTTPException, Request

from pandion import ConfigError, Pipeline
from pandion.evaluation import COMPARE_STAGES, with_stage

NOT_A_MAPPING = "The pipeline must be a mapping of settings, in the pipeline file's shape."
PLUGINS_REFUSED = (
    "A request cannot load plugins: the server loads its strategies itself, from its "
    "own code or from installed packages. Leave plugins out."
)
MODELS_NOT_A_MAPPING = "models must be a mapping of settings."

#: The folder a copied pipeline file names: relative, so it works wherever the file is saved.
YAML_PATH = "./pandion-index"


def as_yaml(config: dict[str, Any]) -> str:
    """`config` (the file's shape, without the server's folder) as a pipeline file."""
    return yaml.safe_dump({"path": YAML_PATH, **config}, sort_keys=False, allow_unicode=True)


def problems(*sentences: str) -> HTTPException:
    """A 422 whose detail lists what is wrong, one sentence each, and in
    `details` each one again as `{"message", "step", "use", "settings"}`,
    here about no one step."""
    details = [{"message": s, "step": None, "use": None, "settings": []} for s in sentences]
    return HTTPException(status_code=422, detail={"problems": list(sentences), "details": details})


def refused(exc: ConfigError, policy: Any) -> HTTPException:
    """The 422 for a pipeline Pandion refused: its sentence in `problems`, and
    in `details` where it belongs (`ConfigError.to_dict`): the step's place in
    the pipeline file (not the run event's step name), its strategy, and each refused setting with its own
    sentence. Every sentence goes through the policy's scrub."""
    detail = exc.to_dict()
    detail["message"] = policy.scrub(detail["message"])
    detail["settings"] = [{**s, "message": policy.scrub(s["message"])} for s in detail["settings"]]
    return HTTPException(status_code=422, detail={"problems": [detail["message"]], "details": [detail]})


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
        raise refused(exc, policy) from None
    policy.check_run(p.to_dict(), request)
    return p


def public(p: Pipeline) -> dict[str, Any]:
    """The pipeline in the file's shape, without the server's folder and models."""
    data = p.to_dict()
    data.pop("path", None)
    data.pop("models", None)
    return data


def _block(value: Any) -> Any:
    """A stage as the file writes it: a bare name is {"use": name} ("none" stays)."""
    if isinstance(value, str):
        return value if value == "none" else {"use": value}
    if isinstance(value, list):
        return [_block(v) for v in value]
    return value


def variant_config(config: dict[str, Any], stage: str, variant: Any) -> dict[str, Any]:
    """`config` with one stage replaced by `variant`, taken as compare takes it:
    a bare name is {"use": name}, and one block for clean or rerank is a list of one.
    With categories, parse, clean and chunk are set in every category."""
    block = _block(variant)
    if stage in ("clean", "rerank") and isinstance(block, dict):
        block = [block]
    data = copy.deepcopy(config)
    section = COMPARE_STAGES[stage]
    if not isinstance(data.get(section), dict):
        data[section] = {}
    return with_stage(data, stage, block)
