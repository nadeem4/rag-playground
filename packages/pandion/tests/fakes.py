"""The fake-transform builder the engine tests share.

It lives here, not in conftest.py, so a test can import it by a name no other
test folder uses ("conftest" is the name of every folder's fixtures file).
"""

from pydantic import BaseModel

from pandion.transform import Transform


class EmptyCfg(BaseModel):
    pass


class TextCfg(BaseModel):
    text: str = ""


def _make(name, stage, inputs, output, cfg=EmptyCfg, fn=None, **attrs):
    """Build a concrete Transform subclass without a class statement."""
    ns = {
        "name": name,
        "stage": stage,
        "inputs": inputs,
        "output": output,
        "config_model": cfg,
        "summary": "A test transform.",
        "apply": fn or (lambda self, inputs, config, ctx: {"n": name}),
        **attrs,
    }
    return type(f"Fake_{name}", (Transform,), ns)
