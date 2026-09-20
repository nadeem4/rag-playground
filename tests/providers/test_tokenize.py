import pytest

from providers.tokenize import HeuristicTokenCounter, TokenCounter


@pytest.fixture
def counter() -> HeuristicTokenCounter:
    return HeuristicTokenCounter()


def test_satisfies_the_protocol(counter):
    assert isinstance(counter, TokenCounter)


def test_empty_text_is_zero_tokens(counter):
    assert counter.count("") == 0
    assert counter.count("   \n\t ") == 0


def test_words_are_counted(counter):
    assert counter.count("the capital of France") == 4


def test_punctuation_counts_separately(counter):
    """Word/punct split, like a real BPE tokenizer roughly behaves."""
    assert counter.count("hello, world!") == 4  # hello , world !


def test_numbers_and_underscores_are_word_characters(counter):
    assert counter.count("chunk_size 512") == 2


def test_whitespace_shape_does_not_change_the_count(counter):
    assert counter.count("a b c") == counter.count("a\n\n b\tc  ")


def test_deterministic_across_instances(counter):
    text = "Retrieval augmented generation, 2026 edition."
    assert counter.count(text) == HeuristicTokenCounter().count(text)
    assert counter.count(text) == counter.count(text)


def test_count_grows_monotonically_with_appended_text(counter):
    short = "the capital of France"
    assert counter.count(short + " is Paris") > counter.count(short)


def test_count_tokens_is_the_sum_over_a_batch(counter):
    texts = ["the capital of France", "hello, world!"]
    assert sum(counter.count(t) for t in texts) == 8


def test_any_object_with_count_satisfies_the_protocol():
    class Fixed:
        def count(self, text: str) -> int:
            return 7

    assert isinstance(Fixed(), TokenCounter)
