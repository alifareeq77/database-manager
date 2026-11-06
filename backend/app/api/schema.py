"""Structural changes: always previewed as SQL, destructive operations need explicit confirmation."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel

from app.adapters import requests as rq
from app.adapters.base import AdapterError
from app.api.deps import DB, ConnAdapter, CurrentUser, client_ip
from app.services.audit import audit

router = APIRouter(prefix="/api/connections/{connection_id}/schema", tags=["schema"])


class PreviewOut(BaseModel):
    statements: list[str]
    destructive: bool
    transactional: bool


class ApplyIn(BaseModel):
    change: rq.SchemaChangeRequest
    confirm_destructive: bool = False
    # Must echo the previewed statements; guards against applying something the user did not see.
    expected_statements: list[str]


class ApplyOut(BaseModel):
    statements: list[str]


def _destructive(req: rq.SchemaChangeRequest) -> bool:
    return any(op.op in rq.DESTRUCTIVE_OPS for op in req.operations)


@router.post("/preview", response_model=PreviewOut)
async def preview(body: rq.SchemaChangeRequest, ca: ConnAdapter, database: str | None = Query(None)) -> PreviewOut:
    adapter = ca[1]
    try:
        stmts = await adapter.generate_ddl(database, body)
    except AdapterError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return PreviewOut(statements=stmts, destructive=_destructive(body), transactional=adapter.capabilities.transactional_ddl)


@router.post("/apply", response_model=ApplyOut)
async def apply(body: ApplyIn, request: Request, ca: ConnAdapter, db: DB, user: CurrentUser, database: str | None = Query(None)) -> ApplyOut:
    conn, adapter = ca
    if _destructive(body.change) and not body.confirm_destructive:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This change is destructive and must be confirmed.")
    try:
        stmts = await adapter.generate_ddl(database, body.change)
        if stmts != body.expected_statements:
            raise HTTPException(status.HTTP_409_CONFLICT, "The generated SQL changed since the preview; review it again.")
        await adapter.apply_ddl(database, stmts)
    except AdapterError as exc:
        await audit(db, user, "schema.failed", connection_id=conn.id, target=body.change.table,
                    details={"sql": "\n".join(body.expected_statements), "error": str(exc)}, ip=client_ip(request))
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    await audit(db, user, "schema.apply", connection_id=conn.id, target=body.change.table,
                details={"sql": ";\n".join(stmts), "operations": [op.op for op in body.change.operations]}, ip=client_ip(request))
    return ApplyOut(statements=stmts)
