"""Links the sources do not contain are removed from answers (no data leaves in a URL)."""

from types import SimpleNamespace

import pytest

from pandion.answer_safety import strip_unsourced_urls as strip
from pandion.chat_turn import ChatSettings, chat_turn
from pandion.conversation_store import get_conversation_store

SRC = ["See https://docs.example.com/guide for the details."]


def test_a_url_in_a_source_is_kept():
    text = "Read https://docs.example.com/guide now."
    assert strip(text, SRC) == text


def test_a_url_not_in_any_source_is_removed():
    assert strip("Go to https://evil.example/x now.", SRC) == "Go to [link removed] now."


def test_a_markdown_image_to_a_new_host_is_dropped_whole():
    assert strip("Done ![x](https://evil.example/?q=SECRET) ok", SRC) == "Done  ok"


def test_a_markdown_link_keeps_its_label():
    assert strip("Open [the guide](https://evil.example/g).", SRC) == "Open the guide."
    kept = "Open [the guide](https://docs.example.com/guide)."
    assert strip(kept, SRC) == kept


def test_an_autolink_and_a_bare_www_are_removed():
    assert strip("<https://evil.example> and www.evil.example/a", SRC) == "[link removed] and [link removed]"


def test_data_and_javascript_urls_are_removed_even_if_in_a_source():
    sources = ["javascript:alert(1) data:text/html,hi"]
    assert strip("[a](javascript:alert(1)) ![b](data:text/html,hi)", sources) == "a "


def test_trailing_punctuation_does_not_hide_a_url():
    assert strip("Visit https://evil.example/a.", SRC) == "Visit [link removed]."
    assert strip("(https://docs.example.com/guide).", SRC) == "(https://docs.example.com/guide)."


def test_case_and_trailing_slash_still_match_the_source():
    assert strip("HTTPS://DOCS.example.com/guide/", SRC) == "HTTPS://DOCS.example.com/guide/"


def test_no_urls_means_the_text_is_returned_unchanged():
    assert strip("Nothing here. [1.1] a (b) [c]", []) == "Nothing here. [1.1] a (b) [c]"


class Stub:
    def __init__(self, text, source_text="Plain."):
        self.text, self.source_text = text, source_text

    def ask(self, question, **kwargs):
        payload = {"answer": [{"text": self.text}], "citations": []}
        hits = [SimpleNamespace(chunk=SimpleNamespace(text=self.source_text))]
        return SimpleNamespace(ok=True, text=self.text, output=SimpleNamespace(payload=payload), hits=hits)


@pytest.fixture
def store(tmp_path):
    return get_conversation_store("sql", {"url": f"sqlite:///{tmp_path / 'c.db'}"})


def test_chat_turn_strips_the_text_and_stores_the_stripped_answer(store):
    result = chat_turn(Stub("Yes ![x](https://evil.example/?q=1) and https://evil.example/y"), store, user_id="u", question="q")
    assert result.text == "Yes  and [link removed]"
    assert store.load(result.conversation_id, "u").turns[0].answer == result.text


def test_chat_turn_keeps_a_link_from_a_source(store):
    result = chat_turn(Stub("See https://a.example/p", "Visit https://a.example/p today."), store, user_id="u", question="q")
    assert result.text == "See https://a.example/p"


def test_strip_urls_can_be_turned_off(store):
    result = chat_turn(
        Stub("Go https://evil.example/y"), store, user_id="u", question="q", settings=ChatSettings(strip_urls=False)
    )
    assert result.text == "Go https://evil.example/y"
