from __future__ import annotations

from app.session_store import SessionStore


def test_append_and_read_messages(tmp_path) -> None:
    db_path = tmp_path / "store.db"
    store = SessionStore(str(db_path))

    store.append_message("s1", "user", "hello")
    store.append_message("s1", "assistant", "hi")
    store.append_message("s1", "user", "how are you")

    messages = store.get_recent_messages("s1", 2)
    assert [m.role for m in messages] == ["assistant", "user"]
    assert [m.content for m in messages] == ["hi", "how are you"]

    store.close()


def test_trim_keeps_latest_messages(tmp_path) -> None:
    db_path = tmp_path / "store.db"
    store = SessionStore(str(db_path))

    for i in range(6):
        role = "user" if i % 2 == 0 else "assistant"
        store.append_message("session-a", role, f"message-{i}")

    store.trim("session-a", keep_last=3)
    messages = store.get_recent_messages("session-a", 10)

    assert len(messages) == 3
    assert [m.content for m in messages] == ["message-3", "message-4", "message-5"]
    store.close()


def test_mark_event_processed_is_idempotent(tmp_path) -> None:
    db_path = tmp_path / "store.db"
    store = SessionStore(str(db_path))

    assert store.mark_event_processed("session-a", "$event-1") is True
    assert store.mark_event_processed("session-a", "$event-1") is False

    store.close()
