from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Role = Literal["user", "assistant"]


@dataclass(slots=True)
class ChatMessage:
    role: Role
    content: str


@dataclass(slots=True)
class InboundMessage:
    channel: str
    conversation_id: str
    sender_id: str
    text: str
    event_id: str
