from __future__ import annotations

import pytest

from app.models import ChatMessage, InboundMessage
from app.orchestrator import Orchestrator
from app.session_store import SessionStore


class FakeAgent:
    def __init__(self, answer: str = "stub-reply", fail: bool = False) -> None:
        self.answer = answer
        self.fail = fail
        self.received_history: list[ChatMessage] = []
        self.call_count = 0

    async def reply(self, history: list[ChatMessage]) -> str:
        self.call_count += 1
        self.received_history = history
        if self.fail:
            raise RuntimeError("forced-failure")
        return self.answer


class FakeChannel:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []

    async def send_message(self, conversation_id: str, text: str) -> None:
        self.sent.append((conversation_id, text))


@pytest.mark.asyncio
async def test_orchestrator_happy_path(tmp_path) -> None:
    store = SessionStore(str(tmp_path / "db.sqlite3"))
    agent = FakeAgent(answer="assistant-answer")
    channel = FakeChannel()
    orchestrator = Orchestrator(store, agent, channel, history_max_messages=10)

    inbound = InboundMessage(
        channel="matrix",
        conversation_id="!room:example.com",
        sender_id="@alice:example.com",
        text="Please help me",
        event_id="$event1",
    )

    await orchestrator.handle_message(inbound)

    session_id = Orchestrator.build_session_id(inbound)
    messages = store.get_recent_messages(session_id, 10)

    assert [m.role for m in messages] == ["user", "assistant"]
    assert [m.content for m in messages] == ["Please help me", "assistant-answer"]
    assert channel.sent == [("!room:example.com", "assistant-answer")]
    assert agent.received_history[0].content == "Please help me"

    store.close()


@pytest.mark.asyncio
async def test_orchestrator_returns_error_message_on_agent_failure(tmp_path) -> None:
    store = SessionStore(str(tmp_path / "db.sqlite3"))
    agent = FakeAgent(fail=True)
    channel = FakeChannel()
    orchestrator = Orchestrator(store, agent, channel, history_max_messages=10)

    inbound = InboundMessage(
        channel="matrix",
        conversation_id="!room:example.com",
        sender_id="@bob:example.com",
        text="break it",
        event_id="$event2",
    )

    await orchestrator.handle_message(inbound)

    session_id = Orchestrator.build_session_id(inbound)
    messages = store.get_recent_messages(session_id, 10)

    assert len(messages) == 2
    assert messages[1].role == "assistant"
    assert "Failed to process your request" in messages[1].content
    assert channel.sent[0][0] == "!room:example.com"
    assert "forced-failure" in channel.sent[0][1]

    store.close()


@pytest.mark.asyncio
async def test_orchestrator_ignores_duplicate_events(tmp_path) -> None:
    store = SessionStore(str(tmp_path / "db.sqlite3"))
    agent = FakeAgent(answer="assistant-answer")
    channel = FakeChannel()
    orchestrator = Orchestrator(store, agent, channel, history_max_messages=10)

    inbound = InboundMessage(
        channel="matrix",
        conversation_id="!room:example.com",
        sender_id="@alice:example.com",
        text="same event",
        event_id="$same",
    )

    await orchestrator.handle_message(inbound)
    await orchestrator.handle_message(inbound)

    session_id = Orchestrator.build_session_id(inbound)
    messages = store.get_recent_messages(session_id, 10)

    assert len(messages) == 2
    assert agent.call_count == 1
    assert len(channel.sent) == 1

    store.close()
