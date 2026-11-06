"""Import and streaming export.

Exports use a two-step flow so large files stream straight to disk in the browser without the
SQL or filters ever appearing in a URL: POST /exports prepares a short-lived, user-bound ticket,
then GET /exports/{ticket} streams the file.
"""

from __future__ import annotations

import csv
import io
import json
import re
import secrets
import time
from dataclasses import dataclass
from typing import Any, Literal

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.adapters import requests as rq
from app.adapters.base import AdapterError
from app.api.deps import DB, CurrentUser, client_ip
from app.config import get_settings
from app.services.audit import audit
from app.services.connections import adapters
from app.services.exporters import csv_stream, json_stream, sql_stream

router = APIRouter(tags=["import-export"])
Format = Literal["csv", "json", "sql"]


class ExportIn(BaseModel):
    connection_id: str
    database: str | None = None
    format: Format = "csv"
    # Either a table export (with optional filters/sort) or a query export.
    table: rq.DataRequest | None = None
    sql: str | None = Field(None, max_length=1_000_000)
    limit: int | None = Field(None, ge=1)
    sql_table_name: str | None = Field(None, max_length=128)


@dataclass
class _Ticket:
    user_id: str
    spec: ExportIn
    expires: float


_tickets: dict[str, _Ticket] = {}


class TicketOut(BaseModel):
    ticket: str
    url: str


@router.post("/api/exports", response_model=TicketOut)
async def prepare_export(body: ExportIn, db: DB, user: CurrentUser) -> TicketOut:
    if (body.table is None) == (body.sql is None):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Provide either a table or a SQL query")
    await adapters.get(db, user, body.connection_id)  # ownership check
    now = time.time()
    for k in [k for k, t in _tickets.items() if t.expires < now]:
        _tickets.pop(k, None)
    ticket = secrets.token_urlsafe(24)
    _tickets[ticket] = _Ticket(user_id=user.id, spec=body, expires=now + 60)
    return TicketOut(ticket=ticket, url=f"/api/exports/{ticket}")


def _safe_filename(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", name)[:80] or "export"


@router.get("/api/exports/{ticket}")
async def download_export(ticket: str, request: Request, db: DB, user: CurrentUser) -> StreamingResponse:
    t = _tickets.pop(ticket, None)  # single use
    if t is None or t.user_id != user.id or t.expires < time.time():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Export link expired")
    spec = t.spec
    conn, adapter = await adapters.get(db, user, spec.connection_id)
    try:
        if spec.table is not None:
            columns, rows = await adapter.stream_table(spec.database, spec.table, spec.limit)
            names = [c.name for c in columns]
            base_name = spec.table.table
            table_sql = adapter.qualified(spec.table.schema_name, spec.table.table)
        else:
            names, rows = await adapter.stream_query(spec.database, spec.sql or "")
            base_name = spec.sql_table_name or "query_result"
            table_sql = adapter.quote(base_name)
    except AdapterError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    await audit(db, user, "data.export", connection_id=conn.id, target=base_name,
                details={"format": spec.format, "sql": spec.sql} if spec.sql else {"format": spec.format}, ip=client_ip(request))
    if spec.format == "csv":
        body, media = csv_stream(names, rows), "text/csv; charset=utf-8"
    elif spec.format == "json":
        body, media = json_stream(names, rows), "application/json"
    else:
        body, media = sql_stream(table_sql, [adapter.quote(n) for n in names], adapter.engine_name, rows), "application/sql"
    filename = f"{_safe_filename(base_name)}.{spec.format}"
    return StreamingResponse(body, media_type=media, headers={"Content-Disposition": f'attachment; filename="{filename}"'})


class ImportOut(BaseModel):
    rows: int
    statements: int = 0


async def _read_limited(file: UploadFile) -> bytes:
    limit = get_settings().max_import_bytes
    chunks, size = [], 0
    while chunk := await file.read(1024 * 1024):
        size += len(chunk)
        if size > limit:
            raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, f"File exceeds {limit // (1024 * 1024)} MB")
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/api/connections/{connection_id}/import", response_model=ImportOut)
async def import_file(
    connection_id: str,
    request: Request,
    db: DB,
    user: CurrentUser,
    file: UploadFile = File(...),
    format: Format = Form(...),
    database: str | None = Form(None),
    schema_name: str | None = Form(None),
    table: str | None = Form(None),
    empty_as_null: bool = Form(True),
) -> ImportOut:
    conn, adapter = await adapters.get(db, user, connection_id)
    raw = await _read_limited(file)
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "File must be UTF-8 encoded") from exc
    try:
        if format == "sql":
            if adapter.config.read_only:
                raise AdapterError("This connection is read-only.")
            results = await adapter.execute_query(database, text, max_rows=1, timeout_s=get_settings().max_query_timeout_s)
            err = next((r for r in results if r.error), None)
            if err:
                done = len(results) - 1
                raise AdapterError(f"Statement {done + 1} failed after {done} succeeded: {err.error}")
            await audit(db, user, "data.import", connection_id=conn.id, target=file.filename, details={"format": "sql", "statements": len(results)}, ip=client_ip(request))
            return ImportOut(rows=sum(r.row_count or 0 for r in results if not r.returns_rows), statements=len(results))
        if not table:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Target table is required")
        rows: list[dict[str, Any]]
        if format == "csv":
            reader = csv.DictReader(io.StringIO(text))
            rows = [{k: (None if empty_as_null and v == "" else v) for k, v in r.items() if k is not None} for r in reader]
        else:
            data = json.loads(text)
            if isinstance(data, dict):
                data = [data]
            if not isinstance(data, list) or not all(isinstance(r, dict) for r in data):
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "JSON import expects an array of objects")
            rows = data
        if not rows:
            return ImportOut(rows=0)
        n = await adapter.import_rows(database, schema_name, table, rows)
    except AdapterError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    except (json.JSONDecodeError, csv.Error) as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"Could not parse file: {exc}") from exc
    await audit(db, user, "data.import", connection_id=conn.id, target=table, details={"format": format, "rows": n, "file": file.filename}, ip=client_ip(request))
    return ImportOut(rows=n)
