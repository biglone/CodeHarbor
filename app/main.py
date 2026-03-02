from __future__ import annotations

import asyncio
import logging

from app.agent.openai_agent import OpenAIAgent
from app.channels.matrix import MatrixChannel
from app.config import load_settings
from app.orchestrator import Orchestrator
from app.session_store import SessionStore


def _configure_logging(level: str) -> None:
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


async def async_main() -> None:
    settings = load_settings()
    _configure_logging(settings.log_level)

    logger = logging.getLogger("codeharbor.main")
    store = SessionStore(settings.sqlite_path)
    channel = MatrixChannel(settings)
    agent = OpenAIAgent(
        api_key=settings.openai_api_key,
        model=settings.openai_model,
        system_prompt=settings.system_prompt,
    )
    orchestrator = Orchestrator(
        store=store,
        agent=agent,
        channel=channel,
        history_max_messages=settings.history_max_messages,
    )

    logger.info("CodeHarbor starting with model=%s", settings.openai_model)
    try:
        await channel.start(orchestrator.handle_message)
    finally:
        await channel.stop()
        store.close()
        logger.info("CodeHarbor stopped.")


def run() -> None:
    try:
        asyncio.run(async_main())
    except KeyboardInterrupt:
        logging.getLogger("codeharbor.main").info("Interrupted by user.")
