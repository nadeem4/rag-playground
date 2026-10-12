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


def test_a_missing_submodule_of_the_extra_still_names_the_extra(monkeypatch):
    # Both entries, since an earlier test may already have imported them.
    monkeypatch.setitem(sys.modules, "docling", None)
    monkeypatch.setitem(sys.modules, "docling.datamodel", None)
    with pytest.raises(MissingExtra, match=r'pandion\[docling\]'):
        require("docling.datamodel", extra="docling", step="The docling parser")


def test_a_broken_install_keeps_its_own_error(monkeypatch, tmp_path):
    """The extra is installed but one of its own imports fails: say that, not "install"."""
    (tmp_path / "half_installed.py").write_text("import a_dependency_that_is_gone\n")
    monkeypatch.syspath_prepend(str(tmp_path))
    with pytest.raises(ModuleNotFoundError) as caught:
        require("half_installed", extra="half", step="This step")
    assert not isinstance(caught.value, MissingExtra)
    assert caught.value.name == "a_dependency_that_is_gone"


def test_an_import_error_that_is_not_a_missing_module_is_kept(monkeypatch, tmp_path):
    (tmp_path / "broken_inside.py").write_text("raise ImportError('a DLL failed to load')\n")
    monkeypatch.syspath_prepend(str(tmp_path))
    with pytest.raises(ImportError, match="a DLL failed to load") as caught:
        require("broken_inside", extra="broken", step="This step")
    assert not isinstance(caught.value, MissingExtra)
