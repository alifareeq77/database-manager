"""Request dependencies: authentication, CSRF, adapter lookup."""

from __future__ import annotations

import hmac
from datetime import timedelta
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.base import DatabaseAdapter
from app.config import get_settings
from app.core.security import token_digest
from app.db import get_db, utcnow
from app.models import Connection, User, UserSession
from app.services.connections import NotFound, adapters

SESSION_COOKIE = "strata_session"
CSRF_COOKIE = "strata_csrf"
CSRF_HEADER = "x-csrf-token"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

DB = Annotated[AsyncSession, Depends(get_db)]


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


async def current_session(request: Request, db: DB) -> UserSession:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    sess = await db.get(UserSession, token_digest(token))
    now = utcnow()
    if sess is None or sess.expires_at < now:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired")
    if request.method not in SAFE_METHODS:
        header = request.headers.get(CSRF_HEADER, "")
        if not header or not hmac.compare_digest(header, sess.csrf_token):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "CSRF token missing or invalid")
    # Sliding expiry, refreshed at most every 5 minutes to limit writes.
    ttl = timedelta(hours=get_settings().session_ttl_hours)
    if sess.expires_at - now < ttl - timedelta(minutes=5):
        sess.expires_at = now + ttl
        await db.commit()
    request.state.session = sess
    return sess


async def current_user(db: DB, sess: Annotated[UserSession, Depends(current_session)]) -> User:
    user = await db.get(User, sess.user_id)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    return user


CurrentUser = Annotated[User, Depends(current_user)]


async def require_admin(user: CurrentUser) -> User:
    if user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Administrator role required")
    return user


AdminUser = Annotated[User, Depends(require_admin)]


async def get_adapter(connection_id: str, db: DB, user: CurrentUser) -> tuple[Connection, DatabaseAdapter]:
    try:
        return await adapters.get(db, user, connection_id)
    except NotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except RuntimeError as exc:  # credential decryption failure
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, str(exc)) from exc


ConnAdapter = Annotated[tuple[Connection, DatabaseAdapter], Depends(get_adapter)]
