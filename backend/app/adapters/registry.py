"""Adapter registry. Add a new engine by implementing DatabaseAdapter and registering it here."""

from __future__ import annotations

from app.adapters.base import ConnectionConfig, DatabaseAdapter
from app.adapters.mysql import MySQLAdapter
from app.adapters.postgres import PostgresAdapter
from app.adapters.sqlite import SQLiteAdapter

ADAPTERS: dict[str, type[DatabaseAdapter]] = {
    "postgresql": PostgresAdapter,
    "mysql": MySQLAdapter,
    "sqlite": SQLiteAdapter,
}


def adapter_class(engine: str) -> type[DatabaseAdapter]:
    try:
        return ADAPTERS[engine]
    except KeyError as exc:
        raise ValueError(f"Unsupported engine: {engine}") from exc


def create_adapter(config: ConnectionConfig) -> DatabaseAdapter:
    return adapter_class(config.engine)(config)
