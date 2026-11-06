"""Audit logging. Never record credentials; SQL is truncated."""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AuditLog, User

_MAX_SQL = 4000


async def audit(
    db: AsyncSession,
    user: User | None,
    action: str,
    *,
    connection_id: str | None = None,
    target: str | None = None,
    details: dict[str, Any] | None = None,
    ip: str | None = None,
    commit: bool = True,
) -> None:
    d = dict(details or {})
    if "sql" in d and isinstance(d["sql"], str) and len(d["sql"]) > _MAX_SQL:
        d["sql"] = d["sql"][:_MAX_SQL] + "…"
    for secret_key in ("password", "ssl_ca", "secret"):
        d.pop(secret_key, None)
    db.add(AuditLog(
        user_id=user.id if user else None, username=user.username if user else None, action=action,
        connection_id=connection_id, target=(target or "")[:512] or None, details=d, ip=ip,
    ))
    if commit:
        await db.commit()
