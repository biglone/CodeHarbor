from __future__ import annotations

import sqlite3
from pathlib import Path
from threading import Lock

from app.models import ChatMessage, Role


class SessionStore:
    def __init__(self, db_path: str) -> None:
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._lock = Lock()
        self._init_schema()

    def _init_schema(self) -> None:
        with self._lock:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_messages_session_id_id ON messages(session_id, id)"
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS processed_events (
                    event_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            self._conn.commit()

    def append_message(self, session_id: str, role: Role, content: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO messages(session_id, role, content) VALUES(?, ?, ?)",
                (session_id, role, content),
            )
            self._conn.commit()

    def get_recent_messages(self, session_id: str, limit: int) -> list[ChatMessage]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT role, content
                FROM messages
                WHERE session_id = ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (session_id, limit),
            ).fetchall()

        rows.reverse()
        return [ChatMessage(role=row[0], content=row[1]) for row in rows]

    def trim(self, session_id: str, keep_last: int) -> None:
        with self._lock:
            self._conn.execute(
                """
                DELETE FROM messages
                WHERE session_id = ?
                  AND id NOT IN (
                    SELECT id
                    FROM messages
                    WHERE session_id = ?
                    ORDER BY id DESC
                    LIMIT ?
                  )
                """,
                (session_id, session_id, keep_last),
            )
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def mark_event_processed(self, session_id: str, event_id: str) -> bool:
        with self._lock:
            try:
                self._conn.execute(
                    "INSERT INTO processed_events(event_id, session_id) VALUES(?, ?)",
                    (event_id, session_id),
                )
                self._conn.commit()
                return True
            except sqlite3.IntegrityError:
                return False
