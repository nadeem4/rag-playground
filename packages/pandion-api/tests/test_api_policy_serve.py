"""The three Policy hooks serve mode adds: who is asking, with which roles, and whether they may."""

from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from pandion_api import Policy


def test_the_default_hooks_are_permissive():
    policy = Policy()
    assert policy.roles(None) is None
    assert policy.user_id(None) == "anonymous"
    assert policy.limit(None) is None


def test_a_subclass_can_override_each_hook_and_see_the_request():
    class Headers(Policy):
        def user_id(self, request):
            return request.headers["x-user"]

        def roles(self, request):
            return request.headers["x-roles"].split(",")

    app = FastAPI()
    policy = Headers()

    @app.get("/who")
    def who(request: Request):
        return {"user": policy.user_id(request), "roles": policy.roles(request)}

    r = TestClient(app).get("/who", headers={"x-user": "ann", "x-roles": "hr,staff"})
    assert r.json() == {"user": "ann", "roles": ["hr", "staff"]}


def test_a_limit_that_raises_a_429_is_the_refusal():
    class Full(Policy):
        def limit(self, request):
            raise HTTPException(status_code=429, detail="Too many questions. Try again later.")

    app = FastAPI()
    policy = Full()

    @app.get("/go")
    def go(request: Request):
        policy.limit(request)
        return {}

    r = TestClient(app).get("/go")
    assert r.status_code == 429 and r.json()["detail"] == "Too many questions. Try again later."
