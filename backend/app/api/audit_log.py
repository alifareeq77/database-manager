"""Audit log API: admins see everything, members see their own entries."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import func, select

from app.api.deps import DB, CurrentUser
from app.models import AuditLog

router = APIRouter(prefix="/api/audit", tags=["audit"])


class AuditOut(BaseModel):
    id: int
    username: str | None
    action: str
    connection_id: str | None
    target: str | None
    details: dict[str, Any]
    ip: str | None
    created_at: datetime


class AuditPage(BaseModel):
    items: list[AuditOut]
    total: int


@router.get("", response_model=AuditPage)
async def list_audit(db: DB, user: CurrentUser, action: str | None = None, q: str | None = None, limit: int = 100, offset: int = 0) -> AuditPage:
    conds = [] if user.role == "admin" else [AuditLog.user_id == user.id]
    if action:
        conds.append(AuditLog.action.like(f"{action}%"))
    if q:
        conds.append(AuditLog.target.ilike(f"%{q}%"))
    total = (await db.execute(select(func.count()).select_from(AuditLog).where(*conds))).scalar_one()
    rows = (await db.execute(select(AuditLog).where(*conds).order_by(AuditLog.id.desc()).limit(min(limit, 500)).offset(offset))).scalars()
    return AuditPage(total=total, items=[AuditOut(id=r.id, username=r.username, action=r.action, connection_id=r.connection_id,
                                                  target=r.target, details=r.details or {}, ip=r.ip, created_at=r.created_at) for r in rows])
