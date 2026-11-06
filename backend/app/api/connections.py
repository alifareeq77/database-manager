"""Connection manager API. Credentials are write-only: they are never returned to clients."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select

from app.adapters.base import AdapterError, ConnectionConfig
from app.adapters.registry import ADAPTERS, adapter_class, create_adapter
from app.adapters.types import Capabilities, ServerInfo
from app.api.deps import DB, CurrentUser, client_ip
from app.config import get_settings
from app.core.ratelimit import limiter
from app.core.security import decrypt_secret, encrypt_secret
from app.db import utcnow
from app.models import Connection
from app.services.audit import audit
from app.services.connections import adapters, config_from_model

router = APIRouter(prefix="/api/connections", tags=["connections"])

Engine = Literal["postgresql", "mysql", "sqlite"]
SslMode = Literal["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]
_HOST = re.compile(r"^[A-Za-z0-9._:\-\[\]]{1,253}$")
_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


class ConnectionIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    engine: Engine
    group: str | None = Field(None, max_length=80)
    color: str | None = None
    host: str | None = None
    port: int | None = Field(None, ge=1, le=65535)
    username: str | None = Field(None, max_length=255)
    password: str | None = Field(None, max_length=1024)  # None = keep existing on update
    clear_password: bool = False
    database: str | None = Field(None, max_length=255)
    ssl_mode: SslMode = "prefer"
    ssl_ca: str | None = Field(None, max_length=20_000)
    clear_ssl_ca: bool = False
    params: dict[str, str] = Field(default_factory=dict)
    read_only: bool = False
    query_timeout_s: int | None = Field(None, ge=1, le=3600)

    @field_validator("host")
    @classmethod
    def _host(cls, v: str | None) -> str | None:
        if v and not _HOST.match(v):
            raise ValueError("Invalid host name")
        return v or None

    @field_validator("color")
    @classmethod
    def _color(cls, v: str | None) -> str | None:
        if v and not _COLOR.match(v):
            raise ValueError("Color must be a hex value like #3b82f6")
        return v

    @field_validator("params")
    @classmethod
    def _params(cls, v: dict[str, str]) -> dict[str, str]:
        if len(v) > 32:
            raise ValueError("Too many parameters")
        for k, val in v.items():
            if not re.match(r"^[A-Za-z_][A-Za-z0-9_.]{0,63}$", k) or len(str(val)) > 500:
                raise ValueError(f"Invalid parameter: {k}")
        return v


class ConnectionTestIn(ConnectionIn):
    connection_id: str | None = None  # reuse stored secrets while editing


class ConnectionOut(BaseModel):
    id: str
    name: str
    engine: Engine
    group: str | None
    color: str | None
    host: str | None
    port: int | None
    username: str | None
    database: str | None
    ssl_mode: str
    params: dict[str, Any]
    read_only: bool
    query_timeout_s: int | None
    has_password: bool
    has_ssl_ca: bool
    is_open: bool
    capabilities: Capabilities
    identifier_quote: str
    created_at: datetime
    last_used_at: datetime | None


def to_out(c: Connection) -> ConnectionOut:
    cls = adapter_class(c.engine)
    return ConnectionOut(
        id=c.id, name=c.name, engine=c.engine, group=c.group, color=c.color, host=c.host, port=c.port,  # type: ignore[arg-type]
        username=c.username, database=c.database, ssl_mode=c.ssl_mode, params=c.params or {}, read_only=c.read_only,
        query_timeout_s=c.query_timeout_s, has_password=bool(c.password_enc), has_ssl_ca=bool(c.ssl_ca_enc),
        is_open=adapters.is_open(c.id), capabilities=cls.capabilities, identifier_quote=cls.identifier_quote,
        created_at=c.created_at, last_used_at=c.last_used_at,
    )


def _validate(body: ConnectionIn) -> None:
    if body.engine == "sqlite":
        from app.adapters.sqlite import resolve_sqlite_path

        try:
            resolve_sqlite_path(body.database)
        except AdapterError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    elif not body.host:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Host is required")


def _apply(conn: Connection, body: ConnectionIn) -> None:
    conn.name, conn.engine, conn.group, conn.color = body.name, body.engine, body.group or None, body.color
    conn.host, conn.port, conn.username, conn.database = body.host, body.port, body.username, body.database
    conn.ssl_mode, conn.params, conn.read_only, conn.query_timeout_s = body.ssl_mode, body.params, body.read_only, body.query_timeout_s
    if body.clear_password:
        conn.password_enc = None
    elif body.password is not None:
        conn.password_enc = encrypt_secret(body.password)
    if body.clear_ssl_ca:
        conn.ssl_ca_enc = None
    elif body.ssl_ca:
        conn.ssl_ca_enc = encrypt_secret(body.ssl_ca)
    conn.updated_at = utcnow()


@router.get("", response_model=list[ConnectionOut])
async def list_connections(db: DB, user: CurrentUser) -> list[ConnectionOut]:
    rows = (await db.execute(select(Connection).where(Connection.owner_id == user.id).order_by(Connection.group, Connection.name))).scalars()
    return [to_out(c) for c in rows]


@router.get("/engines")
async def engines(_: CurrentUser) -> list[dict[str, Any]]:
    return [{"engine": k, "default_port": v.default_port, "capabilities": v.capabilities, "identifier_quote": v.identifier_quote}
            for k, v in ADAPTERS.items()]


@router.post("", response_model=ConnectionOut, status_code=201)
async def create_connection(body: ConnectionIn, request: Request, db: DB, user: CurrentUser) -> ConnectionOut:
    _validate(body)
    conn = Connection(owner_id=user.id)
    _apply(conn, body)
    db.add(conn)
    await db.flush()
    await audit(db, user, "connection.create", connection_id=conn.id, target=conn.name, details={"engine": conn.engine, "host": conn.host}, ip=client_ip(request))
    await db.refresh(conn)
    return to_out(conn)


async def _owned(db: DB, user: CurrentUser, connection_id: str) -> Connection:
    conn = await db.get(Connection, connection_id)
    if conn is None or conn.owner_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")
    return conn


@router.get("/{connection_id}", response_model=ConnectionOut)
async def get_connection(connection_id: str, db: DB, user: CurrentUser) -> ConnectionOut:
    return to_out(await _owned(db, user, connection_id))


@router.put("/{connection_id}", response_model=ConnectionOut)
async def update_connection(connection_id: str, body: ConnectionIn, request: Request, db: DB, user: CurrentUser) -> ConnectionOut:
    _validate(body)
    conn = await _owned(db, user, connection_id)
    _apply(conn, body)
    await db.commit()
    await adapters.close(conn.id)
    await audit(db, user, "connection.update", connection_id=conn.id, target=conn.name, ip=client_ip(request))
    await db.refresh(conn)
    return to_out(conn)


@router.delete("/{connection_id}", status_code=204)
async def delete_connection(connection_id: str, request: Request, db: DB, user: CurrentUser) -> None:
    conn = await _owned(db, user, connection_id)
    await adapters.close(conn.id)
    name = conn.name
    await db.delete(conn)
    await audit(db, user, "connection.delete", connection_id=connection_id, target=name, ip=client_ip(request))


@router.post("/test", response_model=ServerInfo)
async def test_unsaved(body: ConnectionTestIn, request: Request, db: DB, user: CurrentUser) -> ServerInfo:
    if not limiter.allow(f"conntest:{user.id}", 30):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many connection tests")
    _validate(body)
    password, ssl_ca = body.password, body.ssl_ca
    if body.connection_id:
        stored = await _owned(db, user, body.connection_id)
        if password is None and not body.clear_password:
            password = decrypt_secret(stored.password_enc)
        if not ssl_ca and not body.clear_ssl_ca:
            ssl_ca = decrypt_secret(stored.ssl_ca_enc)
    cfg = ConnectionConfig(
        id="test", engine=body.engine, host=body.host, port=body.port, username=body.username, password=password,
        database=body.database, ssl_mode=body.ssl_mode, ssl_ca=ssl_ca, params=body.params, read_only=body.read_only,
        query_timeout_s=get_settings().default_query_timeout_s,
    )
    adapter = create_adapter(cfg)
    try:
        info = await adapter._run(adapter.test_connection())  # noqa: SLF001
    except AdapterError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    finally:
        await adapter.disconnect()
    await audit(db, user, "connection.test", target=f"{body.engine}://{body.host or body.database}", ip=client_ip(request))
    return info


@router.post("/{connection_id}/connect", response_model=ServerInfo)
async def connect(connection_id: str, db: DB, user: CurrentUser) -> ServerInfo:
    await _owned(db, user, connection_id)
    conn, adapter = await adapters.get(db, user, connection_id)
    try:
        info = await adapter._run(adapter.test_connection())  # noqa: SLF001
    except AdapterError as exc:
        await adapters.close(connection_id)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    conn.last_used_at = utcnow()
    await db.commit()
    return info


@router.post("/{connection_id}/disconnect")
async def disconnect(connection_id: str, db: DB, user: CurrentUser) -> dict[str, bool]:
    await _owned(db, user, connection_id)
    await adapters.close(connection_id)
    return {"ok": True}


__all__ = ["router", "to_out", "config_from_model"]
