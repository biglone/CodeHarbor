from __future__ import annotations

from typing import Awaitable, Callable, Protocol

from app.models import InboundMessage

MessageHandler = Callable[[InboundMessage], Awaitable[None]]


class Channel(Protocol):
    async def start(self, handler: MessageHandler) -> None:
        """Start consuming messages and forward inbound events to `handler`."""

    async def send_message(self, conversation_id: str, text: str) -> None:
        """Send a text message back to the conversation."""

    async def stop(self) -> None:
        """Stop channel background work and release resources."""
