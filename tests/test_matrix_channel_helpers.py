from __future__ import annotations

from app.channels.matrix import _extract_command_text, _split_text


def test_extract_command_text_with_prefix() -> None:
    assert _extract_command_text("!code explain this", "!code") == "explain this"
    assert _extract_command_text("hello", "!code") is None
    assert _extract_command_text("!code   ", "!code") is None


def test_extract_command_text_without_prefix() -> None:
    assert _extract_command_text("  hello world ", "") == "hello world"


def test_split_text() -> None:
    assert _split_text("abc", chunk_size=10) == ["abc"]
    assert _split_text("abcdefgh", chunk_size=3) == ["abc", "def", "gh"]
