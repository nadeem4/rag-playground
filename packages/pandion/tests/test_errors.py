import sys

import pytest

from pandion.errors import MissingExtra, require


def test_require_returns_the_module():
    assert require("json", extra="none", step="This test").dumps({}) == "{}"


def test_a_missing_module_names_the_step_and_the_install_command(monkeypatch):
    monkeypatch.setitem(sys.modules, "pypdfium2", None)
    with pytest.raises(MissingExtra) as caught:
        require("pypdfium2", extra="pdfium", step="The pdfium parser")
    assert str(caught.value) == (
        'The pdfium parser needs pypdfium2. Install it with: pip install "pandion[pdfium]"'
    )


def test_a_missing_extra_is_an_import_error():
    assert issubclass(MissingExtra, ImportError)
