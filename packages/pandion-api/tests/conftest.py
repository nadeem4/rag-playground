"""Fixtures for pandion-api's tests: a client on a temp data folder."""

import pytest

from apihelpers import make_client


@pytest.fixture
def client(tmp_path):
    with make_client(tmp_path) as c:
        yield c
