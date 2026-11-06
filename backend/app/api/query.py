"""SQL execution, cancellation, query history and saved queries."""

from __future__ import annotations

import time
import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, or_, select

from app.adapters.base import AdapterError
from app.adapters.types import ResultSet
from app.api.deps import DB, ConnAdapter, CurrentUser, client_ip
from app.config import get_settings
from app.db import utcnow
from app.models import Connection, QueryHistory, SavedQuery
from app.services.audit import audit
from app.services.connections import RunningQuery, running_queries

router = APIRouter(tags=["query"])


class ExecuteIn(BaseModel):
    sql: str = Field(min_length=1, max_length=2_000_000)
    database: str | None = None
    query_id: str | None = Field(None, pattern=r"^[A-Za-z0-9_-]{8,64}$")
    max_rows: int | None = Field(None, ge=1)
    timeout_s: int | None = Field(None, ge=1)


class ExecuteOut(BaseModel):
    query_id: str
    results: list[ResultSet]
    duration_ms: float
    status: str
    history_id: int


@router.post("/api/connections/{connection_id}/query", response_model=ExecuteOut)
async def execute(body: ExecuteIn, request: Request, ca: ConnAdapter, db: DB, user: CurrentUser) -> ExecuteOut:
    settings = get_settings()
    conn, adapter = ca
    max_rows = min(body.max_rows or settings.default_max_rows, settings.hard_max_rows)
    timeout_s = min(body.timeout_s or adapter.config.query_timeout_s, settings.max_query_timeout_s)
    query_id = body.query_id or uuid.uuid4().hex
    running = RunningQuery(query_id=query_id, user_id=user.id, connection_id=conn.id, database=body.database, adapter=adapter, sql=body.sql)

    def on_start(handle: object) -> None:
        running.handle = handle

    try:
        running_queries.add(running)
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, "A query with this id is already running") from exc
    t0 = time.perf_counter()
    try:
        results = await adapter.execute_query(body.database, body.sql, max_rows=max_rows, timeout_s=timeout_s, on_start=on_start)
    except AdapterError as exc:
        results = [ResultSet(statement=body.sql, error=str(exc))]
    finally:
        running_queries.remove(query_id)
    duration = round((time.perf_counter() - t0) * 1000, 2)
    error = next((r.error for r in results if r.error), None)
    state = "cancelled" if running.cancelled else "error" if error else "success"
    last = results[-1] if results else None
    hist = QueryHistory(
        user_id=user.id, connection_id=conn.id, database=body.database, sql=body.sql, status=state, error=error,
        duration_ms=duration, rows=last.row_count if last else None,
    )
    db.add(hist)
    conn.last_used_at = utcnow()
    await audit(db, user, "query.execute", connection_id=conn.id, target=body.database,
                details={"sql": body.sql, "status": state, "statements": len(results), "duration_ms": duration},
                ip=client_ip(request), commit=False)
    await db.commit()
    return ExecuteOut(query_id=query_id, results=results, duration_ms=duration, status=state, history_id=hist.id)


@router.post("/api/queries/{query_id}/cancel")
async def cancel(query_id: str, user: CurrentUser) -> dict[str, bool]:
    ok = await running_queries.cancel(query_id, user.id)
    if not ok and running_queries.get(query_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Query is not running")
    return {"cancelled": ok}


class RunningOut(BaseModel):
    query_id: str
    connection_id: str
    sql: str
    started_at: float


@router.get("/api/queries/running", response_model=list[RunningOut])
async def running(user: CurrentUser) -> list[RunningOut]:
    return [RunningOut(query_id=r.query_id, connection_id=r.connection_id, sql=r.sql[:500], started_at=r.started_at) for r in running_queries.for_user(user.id)]


# ---------------------------------------------------------------------------- history


class HistoryOut(BaseModel):
    id: int
    connection_id: str | None
    connection_name: str | None = None
    database: str | None
    sql: str
    status: str
    error: str | None
    duration_ms: float
    rows: int | None
    pinned: bool
    executed_at: datetime


class HistoryPage(BaseModel):
    items: list[HistoryOut]
    total: int


@router.get("/api/history", response_model=HistoryPage)
async def history(
    db: DB, user: CurrentUser, q: str | None = None, connection_id: str | None = None, status_: str | None = Query(None, alias="status"),
    since: datetime | None = None, until: datetime | None = None, pinned: bool | None = None,
    limit: int = 100, offset: int = 0,
) -> HistoryPage:
    conds = [QueryHistory.user_id == user.id]
    if q:
        conds.append(QueryHistory.sql.ilike(f"%{q.replace('%', '').replace('_', '')}%"))
    if connection_id:
        conds.append(QueryHistory.connection_id == connection_id)
    if status_:
        conds.append(QueryHistory.status == status_)
    if since:
        conds.append(QueryHistory.executed_at >= since)
    if until:
        conds.append(QueryHistory.executed_at <= until)
    if pinned is not None:
        conds.append(QueryHistory.pinned == pinned)
    total = (await db.execute(select(func.count()).select_from(QueryHistory).where(*conds))).scalar_one()
    rows = (await db.execute(
        select(QueryHistory, Connection.name).outerjoin(Connection, Connection.id == QueryHistory.connection_id)
        .where(*conds).order_by(QueryHistory.pinned.desc(), QueryHistory.executed_at.desc())
        .limit(min(limit, 500)).offset(max(offset, 0))
    )).all()
    items = [HistoryOut(**{c: getattr(h, c) for c in HistoryOut.model_fields if c != "connection_name"}, connection_name=name) for h, name in rows]
    return HistoryPage(items=items, total=total)


class HistoryPatch(BaseModel):
    pinned: bool


@router.patch("/api/history/{history_id}", response_model=HistoryOut)
async def patch_history(history_id: int, body: HistoryPatch, db: DB, user: CurrentUser) -> HistoryOut:
    h = await db.get(QueryHistory, history_id)
    if h is None or h.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    h.pinned = body.pinned
    await db.commit()
    return HistoryOut(**{c: getattr(h, c) for c in HistoryOut.model_fields if c != "connection_name"})


@router.delete("/api/history", status_code=204)
async def clear_history(db: DB, user: CurrentUser) -> None:
    await db.execute(delete(QueryHistory).where(QueryHistory.user_id == user.id, QueryHistory.pinned.is_(False)))
    await db.commit()


# ---------------------------------------------------------------------------- saved queries / snippets


class SavedIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    sql: str = Field(min_length=1, max_length=500_000)
    description: str | None = Field(None, max_length=2000)
    connection_id: str | None = None
    is_snippet: bool = False


class SavedOut(SavedIn):
    id: str
    created_at: datetime
    updated_at: datetime


def _saved_out(s: SavedQuery) -> SavedOut:
    return SavedOut(id=s.id, name=s.name, sql=s.sql, description=s.description, connection_id=s.connection_id,
                    is_snippet=s.is_snippet, created_at=s.created_at, updated_at=s.updated_at)


@router.get("/api/saved-queries", response_model=list[SavedOut])
async def list_saved(db: DB, user: CurrentUser, q: str | None = None) -> list[SavedOut]:
    stmt = select(SavedQuery).where(SavedQuery.user_id == user.id)
    if q:
        stmt = stmt.where(or_(SavedQuery.name.ilike(f"%{q}%"), SavedQuery.sql.ilike(f"%{q}%")))
    return [_saved_out(s) for s in (await db.execute(stmt.order_by(SavedQuery.name))).scalars()]


@router.post("/api/saved-queries", response_model=SavedOut, status_code=201)
async def create_saved(body: SavedIn, db: DB, user: CurrentUser) -> SavedOut:
    s = SavedQuery(user_id=user.id, **body.model_dump())
    db.add(s)
    await db.commit()
    await db.refresh(s)
    return _saved_out(s)


@router.put("/api/saved-queries/{saved_id}", response_model=SavedOut)
async def update_saved(saved_id: str, body: SavedIn, db: DB, user: CurrentUser) -> SavedOut:
    s = await db.get(SavedQuery, saved_id)
    if s is None or s.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    for k, v in body.model_dump().items():
        setattr(s, k, v)
    s.updated_at = utcnow()
    await db.commit()
    return _saved_out(s)


@router.delete("/api/saved-queries/{saved_id}", status_code=204)
async def delete_saved(saved_id: str, db: DB, user: CurrentUser) -> None:
    s = await db.get(SavedQuery, saved_id)
    if s is None or s.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await db.delete(s)
    await db.commit()
