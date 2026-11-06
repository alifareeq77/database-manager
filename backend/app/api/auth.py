"""Authentication: first-run setup, login/logout, user management."""

from __future__ import annotations

import re
import secrets
from datetime import timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, select

from app.api.deps import CSRF_COOKIE, DB, SESSION_COOKIE, AdminUser, CurrentUser, client_ip, current_session
from app.config import get_settings
from app.core.ratelimit import limiter
from app.core.security import DUMMY_HASH, hash_password, new_token, token_digest, verify_password
from app.db import utcnow
from app.models import User, UserSession
from app.services.audit import audit

router = APIRouter(prefix="/api/auth", tags=["auth"])


class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class NewUser(Credentials):
    role: Literal["admin", "member"] = "member"

    @field_validator("username")
    @classmethod
    def _username(cls, v: str) -> str:
        if not re.match(r"^[A-Za-z0-9_.-]+$", v):
            raise ValueError("Username may contain letters, digits, '.', '_' and '-'")
        return v

    @field_validator("password")
    @classmethod
    def _password(cls, v: str) -> str:
        if len(v) < 10:
            raise ValueError("Password must be at least 10 characters")
        return v


class UserOut(BaseModel):
    id: str
    username: str
    role: str


class AuthStatus(BaseModel):
    setup_required: bool
    user: UserOut | None
    csrf_token: str | None = None


def _user_out(u: User) -> UserOut:
    return UserOut(id=u.id, username=u.username, role=u.role)


async def _start_session(db: DB, request: Request, response: Response, user: User) -> str:
    settings = get_settings()
    token, csrf = new_token(), secrets.token_urlsafe(24)
    ttl = timedelta(hours=settings.session_ttl_hours)
    db.add(UserSession(token_hash=token_digest(token), user_id=user.id, csrf_token=csrf, expires_at=utcnow() + ttl,
                       ip=client_ip(request), user_agent=(request.headers.get("user-agent") or "")[:255]))
    await db.execute(delete(UserSession).where(UserSession.expires_at < utcnow()))
    await db.commit()
    response.set_cookie(SESSION_COOKIE, token, httponly=True, secure=settings.cookie_secure, samesite="strict",
                        max_age=int(ttl.total_seconds()), path="/")
    # Readable by JS so the frontend can echo it in the X-CSRF-Token header (double-submit).
    response.set_cookie(CSRF_COOKIE, csrf, httponly=False, secure=settings.cookie_secure, samesite="strict",
                        max_age=int(ttl.total_seconds()), path="/")
    return csrf


@router.get("/status", response_model=AuthStatus)
async def auth_status(request: Request, db: DB) -> AuthStatus:
    n_users = (await db.execute(select(func.count()).select_from(User))).scalar_one()
    if n_users == 0:
        return AuthStatus(setup_required=True, user=None)
    try:
        sess = await current_session(request, db)
    except HTTPException:
        return AuthStatus(setup_required=False, user=None)
    user = await db.get(User, sess.user_id)
    return AuthStatus(setup_required=False, user=_user_out(user) if user else None, csrf_token=sess.csrf_token)


@router.post("/setup", response_model=AuthStatus)
async def setup(body: NewUser, request: Request, response: Response, db: DB) -> AuthStatus:
    if not limiter.allow(f"login:{client_ip(request)}", get_settings().login_rate_per_minute):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many attempts")
    n_users = (await db.execute(select(func.count()).select_from(User))).scalar_one()
    if n_users > 0:
        raise HTTPException(status.HTTP_409_CONFLICT, "Setup already completed")
    user = User(username=body.username, password_hash=hash_password(body.password), role="admin")
    db.add(user)
    await db.flush()
    csrf = await _start_session(db, request, response, user)
    await audit(db, user, "auth.setup", ip=client_ip(request))
    return AuthStatus(setup_required=False, user=_user_out(user), csrf_token=csrf)


@router.post("/login", response_model=AuthStatus)
async def login(body: Credentials, request: Request, response: Response, db: DB) -> AuthStatus:
    ip = client_ip(request)
    if not limiter.allow(f"login:{ip}", get_settings().login_rate_per_minute):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many login attempts; try again shortly",
                            headers={"Retry-After": str(limiter.retry_after(f"login:{ip}"))})
    user = (await db.execute(select(User).where(User.username == body.username))).scalar_one_or_none()
    ok = verify_password(body.password, user.password_hash if user else DUMMY_HASH)
    if not user or not ok:
        await audit(db, None, "auth.login_failed", target=body.username, ip=ip)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid username or password")
    csrf = await _start_session(db, request, response, user)
    await audit(db, user, "auth.login", ip=ip)
    return AuthStatus(setup_required=False, user=_user_out(user), csrf_token=csrf)


@router.post("/logout")
async def logout(request: Request, response: Response, db: DB, user: CurrentUser) -> dict[str, bool]:
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        await db.execute(delete(UserSession).where(UserSession.token_hash == token_digest(token)))
    await audit(db, user, "auth.logout", ip=client_ip(request))
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(CSRF_COOKIE, path="/")
    return {"ok": True}


@router.get("/users", response_model=list[UserOut])
async def list_users(db: DB, _: AdminUser) -> list[UserOut]:
    rows = (await db.execute(select(User).order_by(User.username))).scalars().all()
    return [_user_out(u) for u in rows]


@router.post("/users", response_model=UserOut, status_code=201)
async def create_user(body: NewUser, request: Request, db: DB, admin: AdminUser) -> UserOut:
    exists = (await db.execute(select(User).where(User.username == body.username))).scalar_one_or_none()
    if exists:
        raise HTTPException(status.HTTP_409_CONFLICT, "Username already taken")
    user = User(username=body.username, password_hash=hash_password(body.password), role=body.role)
    db.add(user)
    await db.flush()
    await audit(db, admin, "user.create", target=user.username, details={"role": body.role}, ip=client_ip(request))
    return _user_out(user)


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=10, max_length=256)


@router.post("/password")
async def change_password(body: PasswordChange, request: Request, db: DB, user: CurrentUser) -> dict[str, bool]:
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Current password is incorrect")
    user.password_hash = hash_password(body.new_password)
    current = request.cookies.get(SESSION_COOKIE)
    # Revoke every other session for this user.
    await db.execute(delete(UserSession).where(UserSession.user_id == user.id, UserSession.token_hash != token_digest(current or "")))
    await audit(db, user, "auth.password_change", ip=client_ip(request))
    return {"ok": True}
