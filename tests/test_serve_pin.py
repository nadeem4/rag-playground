"""The pandion-api range a generated serve project asks for follows pandion-api's own version."""

import pandion_api
from pandion.project import SERVE_API_PIN


def test_serve_api_pin_matches_the_pandion_api_minor():
    major, minor, *_ = pandion_api.__version__.split(".")
    assert SERVE_API_PIN == f"~={major}.{minor}.0"
