from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from typing import Protocol

from app.models import ChatMessage, InboundMessage
from app.session_store import SessionStore


class Agent(Protocol):
    async def reply(self, history: list[ChatMessage]) -> str:
        ...


class ReplyChannel(Protocol):
    async def send_message(self, conversation_id: str, text: str) -> None:
        ...


class Orchestrator:
    def __init__(
        self,
        store: SessionStore,
        agent: Agent,
        channel: ReplyChannel,
        history_max_messages: int,
    ) -> None:
        if history_max_messages <= 0:
            raise ValueError("history_max_messages must be > 0")

        self._store = store
        self._agent = agent
        self._channel = channel
        self._history_max_messages = history_max_messages
        self._session_locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._logger = logging.getLogger("codeharbor.orchestrator")

    async def handle_message(self, inbound: InboundMessage) -> None:
        text = inbound.text.strip()
        if not text:
            return

        session_id = self.build_session_id(inbound)
        lock = self._session_locks[session_id]

        async with lock:
            if not self._store.mark_event_processed(session_id, inbound.event_id):
                self._logger.info("Duplicate event ignored: %s", inbound.event_id)
                return

            self._store.append_message(session_id, "user", text)
            history = self._store.get_recent_messages(session_id, self._history_max_messages)

            try:
                reply = await self._agent.reply(history)
            except Exception as exc:  # noqa: BLE001
                self._logger.exception("Failed to generate reply for %s", session_id)
                reply = f"[CodeHarbor] Failed to process your request: {exc}"

            self._store.append_message(session_id, "assistant", reply)
            self._store.trim(session_id, self._history_max_messages * 2)
            await self._channel.send_message(inbound.conversation_id, reply)

    @staticmethod
    def build_session_id(inbound: InboundMessage) -> str:
        return f"{inbound.channel}:{inbound.conversation_id}:{inbound.sender_id}"
