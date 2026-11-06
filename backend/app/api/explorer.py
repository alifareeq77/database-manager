"""Metadata browsing, table data CRUD, and the dashboard."""

from __future__ import annotations

from collections.abc import Awaitable
from typing import Any, TypeVar

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel

from app.adapters import requests as rq
from app.adapters.base import AdapterError
from app.adapters.types import CatalogTable, DashboardData, DataPage, DbObject, SchemaInfo, TableStructure
from app.api.deps import DB, ConnAdapter, CurrentUser, client_ip
from app.config import get_settings
from app.db import utcnow
from app.services.audit import audit

router = APIRouter(prefix="/api/connections/{connection_id}", tags=["explorer"])
T = TypeVar("T")


async def guard(coro: Awaitable[T]) -> T:
    try:
        return await coro
    except AdapterError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc


@router.get("/databases", response_model=list[SchemaInfo])
async def databases(ca: ConnAdapter, db: DB) -> list[SchemaInfo]:
    conn, adapter = ca
    out = await guard(adapter.list_databases())
    conn.last_used_at = utcnow()
    await db.commit()
    return out


@router.get("/schemas", response_model=list[SchemaInfo])
async def schemas(ca: ConnAdapter, database: str | None = None) -> list[SchemaInfo]:
    return await guard(ca[1].list_schemas(database))


@router.get("/objects", response_model=list[DbObject])
async def objects(ca: ConnAdapter, database: str | None = None, schema: str | None = None) -> list[DbObject]:
    return await guard(ca[1].list_objects(database, schema))


@router.get("/catalog", response_model=list[CatalogTable])
async def catalog(ca: ConnAdapter, database: str | None = None) -> list[CatalogTable]:
    return await guard(ca[1].get_catalog(database))


@router.get("/structure", response_model=TableStructure)
async def structure(ca: ConnAdapter, table: str, database: str | None = None, schema: str | None = None) -> TableStructure:
    return await guard(ca[1].get_table_structure(database, schema, table))


class DdlOut(BaseModel):
    sql: str


@router.get("/ddl", response_model=DdlOut)
async def ddl(ca: ConnAdapter, name: str, kind: str = "table", database: str | None = None, schema: str | None = None) -> DdlOut:
    return DdlOut(sql=await guard(ca[1].get_ddl(database, schema, name, kind)))


@router.get("/dashboard", response_model=DashboardData)
async def dashboard(ca: ConnAdapter, database: str | None = None) -> DashboardData:
    import time

    adapter = ca[1]
    t0 = time.perf_counter()
    info = await guard(adapter.test_connection())
    data = await guard(adapter.get_dashboard(database))
    data.latency_ms = info.latency_ms
    data.insights.insert(0, {"label": "Dashboard query time", "value": f"{(time.perf_counter() - t0) * 1000:.0f} ms"})
    return data


# ---------------------------------------------------------------------------- table data


@router.post("/data", response_model=DataPage)
async def table_data(body: rq.DataRequest, ca: ConnAdapter, database: str | None = Query(None)) -> DataPage:
    return await guard(ca[1].get_table_data(database, body, get_settings().max_page_size))


class MutationOut(BaseModel):
    affected: int
    statements: list[str]


@router.post("/data/insert", response_model=MutationOut)
async def insert(body: rq.InsertRequest, request: Request, ca: ConnAdapter, db: DB, user: CurrentUser, database: str | None = Query(None)) -> MutationOut:
    conn, adapter = ca
    n, stmts = await guard(adapter.insert_rows(database, body))
    await audit(db, user, "data.insert", connection_id=conn.id, target=_target(database, body), details={"rows": n}, ip=client_ip(request))
    return MutationOut(affected=n, statements=stmts)


@router.post("/data/update", response_model=MutationOut)
async def update(body: rq.UpdateRequest, request: Request, ca: ConnAdapter, db: DB, user: CurrentUser, database: str | None = Query(None)) -> MutationOut:
    conn, adapter = ca
    n, stmts = await guard(adapter.update_rows(database, body))
    await audit(db, user, "data.update", connection_id=conn.id, target=_target(database, body), details={"rows": n, "sql": "\n".join(stmts[:5])}, ip=client_ip(request))
    return MutationOut(affected=n, statements=stmts)


@router.post("/data/delete", response_model=MutationOut)
async def delete(body: rq.DeleteRequest, request: Request, ca: ConnAdapter, db: DB, user: CurrentUser, database: str | None = Query(None)) -> MutationOut:
    conn, adapter = ca
    n, stmts = await guard(adapter.delete_rows(database, body))
    await audit(db, user, "data.delete", connection_id=conn.id, target=_target(database, body), details={"rows": n}, ip=client_ip(request))
    return MutationOut(affected=n, statements=stmts)


def _target(database: str | None, ref: Any) -> str:
    parts = [p for p in (database, getattr(ref, "schema_name", None), getattr(ref, "table", None)) if p]
    return ".".join(parts)
