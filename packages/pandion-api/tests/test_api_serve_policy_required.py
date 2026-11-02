"""Serve mode refuses to start without a Policy that says who is asking."""

import pytest
import yaml

from apihelpers import PIPELINE, make_client, settings
from pandion_api import Policy, create_app


def serve(tmp_path, policy, pipeline=PIPELINE):
    file = tmp_path / "pipeline.yaml"
    file.write_text(yaml.safe_dump(pipeline), encoding="utf-8")
    return create_app(settings(tmp_path), policy, mode="serve", pipeline=file)


class Full(Policy):
    def user_id(self, request):
        return "ann"

    def roles(self, request):
        return ["hr"]

    def limit(self, request):
        return None


def test_serve_without_a_policy_is_refused(tmp_path):
    with pytest.raises(ValueError, match="Serve mode needs a Policy that says who is asking"):
        serve(tmp_path, None)


def test_the_default_policy_is_refused_and_names_the_missing_hooks(tmp_path):
    with pytest.raises(ValueError, match="does not override: user_id, roles, limit"):
        serve(tmp_path, Policy())


def test_a_policy_overriding_all_three_is_accepted(tmp_path):
    assert serve(tmp_path, Full()) is not None


def test_one_missing_hook_is_named(tmp_path):
    class NoLimit(Full):
        limit = Policy.limit

    with pytest.raises(ValueError) as caught:
        serve(tmp_path, NoLimit())
    assert "does not override: limit." in str(caught.value)


def test_anonymous_is_accepted_on_purpose(tmp_path):
    assert serve(tmp_path, Policy.anonymous()) is not None


def test_anonymous_with_an_access_block_is_refused(tmp_path):
    with pytest.raises(ValueError, match="access"):
        serve(tmp_path, Policy.anonymous(), {**PIPELINE, "access": {"default": ["staff"]}})


def test_lab_mode_still_accepts_the_default_policy(tmp_path):
    with make_client(tmp_path) as c:
        assert c.get("/strategies").status_code == 200
