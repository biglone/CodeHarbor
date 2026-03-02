from __future__ import annotations

import asyncio
import logging

from nio import AsyncClient, LoginError, LoginResponse, MatrixRoom, RoomMessageText

from app.channels.base import MessageHandler
from app.config import Settings
from app.models import InboundMessage


class MatrixChannel:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._logger = logging.getLogger("codeharbor.channels.matrix")
        self._client = AsyncClient(settings.matrix_homeserver, settings.matrix_user_id)
        self._handler: MessageHandler | None = None
        self._started = False

        self._client.add_event_callback(self._on_room_message, RoomMessageText)

    async def start(self, handler: MessageHandler) -> None:
        self._handler = handler
        await self._login()
        self._started = True
        self._logger.info("Matrix channel connected and syncing.")
        await self._client.sync_forever(timeout=30_000, full_state=True)

    async def send_message(self, conversation_id: str, text: str) -> None:
        if not self._started:
            raise RuntimeError("Matrix channel has not been started.")

        for chunk in _split_text(text):
            await self._client.room_send(
                room_id=conversation_id,
                message_type="m.room.message",
                content={"msgtype": "m.text", "body": chunk},
            )

    async def stop(self) -> None:
        self._client.stop_sync_forever = True
        await self._client.close()
        self._started = False
        self._logger.info("Matrix channel stopped.")

    async def _login(self) -> None:
        if self._settings.matrix_access_token:
            self._client.access_token = self._settings.matrix_access_token
            return

        response = await self._client.login(
            password=self._settings.matrix_password,
            device_name=self._settings.matrix_device_name,
        )
        if isinstance(response, LoginError):
            raise RuntimeError(f"Matrix login failed: {response.message}")
        if not isinstance(response, LoginResponse):
            raise RuntimeError("Unexpected Matrix login response.")

    async def _on_room_message(self, room: MatrixRoom, event: RoomMessageText) -> None:
        if self._handler is None:
            return
        if event.sender == self._settings.matrix_user_id:
            return

        incoming = (event.body or "").strip()
        if not incoming:
            return

        message_text = _extract_command_text(incoming, self._settings.matrix_command_prefix)
        if message_text is None:
            return

        inbound = InboundMessage(
            channel="matrix",
            conversation_id=room.room_id,
            sender_id=event.sender,
            text=message_text,
            event_id=event.event_id,
        )

        try:
            await self._handler(inbound)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            self._logger.exception("Unhandled error while processing Matrix inbound event.")


def _extract_command_text(raw_text: str, prefix: str) -> str | None:
    if not prefix:
        return raw_text.strip()
    if not raw_text.startswith(prefix):
        return None
    stripped = raw_text[len(prefix) :].strip()
    if not stripped:
        return None
    return stripped


def _split_text(text: str, chunk_size: int = 3500) -> list[str]:
    clean = text.strip()
    if not clean:
        return [""]
    if len(clean) <= chunk_size:
        return [clean]

    chunks: list[str] = []
    start = 0
    while start < len(clean):
        chunks.append(clean[start : start + chunk_size])
        start += chunk_size
    return chunks
