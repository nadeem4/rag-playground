from pathlib import Path

GUIDE = (Path(__file__).resolve().parents[1] / "docs" / "app" / "guide.md").read_text(encoding="utf-8")


def test_guide_describes_the_page_entry_points():
    assert "Take it home" in GUIDE
    assert "/take-home" in GUIDE
    assert "guided run" in GUIDE
    for stale in (
        "The old sheet on Build stays for now",
        "opens a sheet that shows what the zip holds",
        "For now you reach it by its address",
    ):
        assert stale not in GUIDE
