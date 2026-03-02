from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


@dataclass(slots=True)
class Settings:
    openai_api_key: str
    openai_model: str
    system_prompt: str
    history_max_messages: int
    sqlite_path: str
    matrix_homeserver: str
    matrix_user_id: str
    matrix_access_token: str
    matrix_password: str
    matrix_device_name: str
    matrix_command_prefix: str
    log_level: str


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f"Environment variable {name} must be an integer.") from exc


def load_settings() -> Settings:
    load_dotenv()

    openai_api_key = os.getenv("OPENAI_API_KEY", "").strip()
    matrix_homeserver = os.getenv("MATRIX_HOMESERVER", "").strip()
    matrix_user_id = os.getenv("MATRIX_USER_ID", "").strip()

    if not openai_api_key:
        raise ValueError("OPENAI_API_KEY is required.")
    if not matrix_homeserver:
        raise ValueError("MATRIX_HOMESERVER is required.")
    if not matrix_user_id:
        raise ValueError("MATRIX_USER_ID is required.")

    matrix_access_token = os.getenv("MATRIX_ACCESS_TOKEN", "").strip()
    matrix_password = os.getenv("MATRIX_PASSWORD", "").strip()

    if not matrix_access_token and not matrix_password:
        raise ValueError("Set MATRIX_ACCESS_TOKEN or MATRIX_PASSWORD.")

    history_max_messages = _env_int("HISTORY_MAX_MESSAGES", 20)
    if history_max_messages <= 0:
        raise ValueError("HISTORY_MAX_MESSAGES must be > 0.")

    sqlite_path = os.getenv("SQLITE_PATH", "data/codeharbor.db").strip()
    Path(sqlite_path).parent.mkdir(parents=True, exist_ok=True)

    return Settings(
        openai_api_key=openai_api_key,
        openai_model=os.getenv("OPENAI_MODEL", "gpt-4.1-mini").strip(),
        system_prompt=os.getenv(
            "SYSTEM_PROMPT",
            "You are CodeHarbor, a coding assistant routed through instant messaging. "
            "Be concise, accurate, and execution-oriented.",
        ).strip(),
        history_max_messages=history_max_messages,
        sqlite_path=sqlite_path,
        matrix_homeserver=matrix_homeserver,
        matrix_user_id=matrix_user_id,
        matrix_access_token=matrix_access_token,
        matrix_password=matrix_password,
        matrix_device_name=os.getenv("MATRIX_DEVICE_NAME", "CodeHarbor Bot").strip(),
        matrix_command_prefix=os.getenv("MATRIX_COMMAND_PREFIX", "!code").strip(),
        log_level=os.getenv("LOG_LEVEL", "INFO").upper().strip(),
    )
