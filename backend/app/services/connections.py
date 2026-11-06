"""Live adapter management and connection isolation.

Each saved connection gets at most one adapter instance (with its own engine pools), keyed by the
connection id. Connections are owned by a single user and ownership is checked on every lookup,
so pools are never shared between users. Idle adapters are disposed by a background sweeper.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.base import ConnectionConfig, DatabaseAdapter
from app.adapters.registry import create_adapter
from app.config import get_settings
from app.core.security import decrypt_secret
from app.models import Connection, User


class NotFound(Exception):
    pass


def config_from_model(conn: Connection) -> ConnectionConfig:
    settings = get_settings()
    return ConnectionConfig(
        id=conn.id, engine=conn.engine, host=conn.host, port=conn.port, username=conn.username,
        password=decrypt_secret(conn.password_enc), database=conn.database, ssl_mode=conn.ssl_mode or "prefer",
        ssl_ca=decrypt_secret(conn.ssl_ca_enc), params=dict(conn.params or {}), read_only=conn.read_only,
        query_timeout_s=min(conn.query_timeout_s or settings.default_query_timeout_s, settings.max_query_timeout_s),
    )


class AdapterManager:
    def __init__(self) -> None:
        self._adapters: dict[str, tuple[float, DatabaseAdapter]] = {}  # id -> (version stamp, adapter)
        self._lock = asyncio.Lock()
        self._sweeper: asyncio.Task[None] | None = None

    async def get(self, db: AsyncSession, user: User, connection_id: str) -> tuple[Connection, DatabaseAdapter]:
        conn = await db.get(Connection, connection_id)
        if conn is None or conn.owner_id != user.id:
            raise NotFound("Connection not found")
        stamp = conn.updated_at.timestamp() if conn.updated_at else 0.0
        async with self._lock:
            cached = self._adapters.get(conn.id)
            if cached and cached[0] == stamp:
                adapter = cached[1]
            else:
                if cached:
                    await cached[1].disconnect()
                adapter = create_adapter(config_from_model(conn))
                self._adapters[conn.id] = (stamp, adapter)
        adapter.last_used = time.monotonic()
        return conn, adapter

    def is_open(self, connection_id: str) -> bool:
        cached = self._adapters.get(connection_id)
        return bool(cached and cached[1]._engines)  # noqa: SLF001

    async def close(self, connection_id: str) -> None:
        async with self._lock:
            cached = self._adapters.pop(connection_id, None)
        if cached:
            await cached[1].disconnect()

    async def close_all(self) -> None:
        async with self._lock:
            items, self._adapters = list(self._adapters.values()), {}
        for _, adapter in items:
            await adapter.disconnect()

    async def _sweep(self) -> None:
        idle = get_settings().engine_idle_seconds
        while True:
            await asyncio.sleep(60)
            now = time.monotonic()
            stale = [cid for cid, (_, a) in self._adapters.items() if now - a.last_used > idle]
            for cid in stale:
                if not running_queries.has_connection(cid):
                    await self.close(cid)

    def start(self) -> None:
        if self._sweeper is None:
            self._sweeper = asyncio.create_task(self._sweep())

    async def stop(self) -> None:
        if self._sweeper:
            self._sweeper.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._sweeper
            self._sweeper = None
        await self.close_all()


@dataclass
class RunningQuery:
    query_id: str
    user_id: str
    connection_id: str
    database: str | None
    adapter: DatabaseAdapter
    sql: str
    started_at: float = field(default_factory=time.time)
    handle: Any = None
    cancelled: bool = False


class QueryRegistry:
    def __init__(self) -> None:
        self._running: dict[str, RunningQuery] = {}

    def add(self, rq: RunningQuery) -> None:
        if rq.query_id in self._running:
            raise ValueError("Duplicate query id")
        self._running[rq.query_id] = rq

    def remove(self, query_id: str) -> None:
        self._running.pop(query_id, None)

    def get(self, query_id: str) -> RunningQuery | None:
        return self._running.get(query_id)

    def has_connection(self, connection_id: str) -> bool:
        return any(r.connection_id == connection_id for r in self._running.values())

    def for_user(self, user_id: str) -> list[RunningQuery]:
        return [r for r in self._running.values() if r.user_id == user_id]

    async def cancel(self, query_id: str, user_id: str) -> bool:
        rq = self._running.get(query_id)
        if rq is None or rq.user_id != user_id:
            return False
        rq.cancelled = True
        return await rq.adapter.cancel_backend(rq.database, rq.handle)


adapters = AdapterManager()
running_queries = QueryRegistry()
