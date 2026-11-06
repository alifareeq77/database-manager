"""Application settings, loaded from environment variables prefixed with STRATA_."""

from __future__ import annotations

import os
import secrets
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="STRATA_", env_file=".env", extra="ignore")

    # Directory for the metadata store (users, encrypted connections, history, audit log).
    data_dir: Path = Path("./data")
    # Master secret used to derive the credential-encryption key. If unset, one is generated
    # and persisted to <data_dir>/secret.key (fine for local use; set it explicitly in production).
    secret_key: str | None = None

    # Session cookie
    session_ttl_hours: int = 12
    cookie_secure: bool = False  # set true behind HTTPS

    # Query execution guard rails
    default_query_timeout_s: int = 30
    max_query_timeout_s: int = 300
    default_max_rows: int = 1000
    hard_max_rows: int = 50_000
    max_page_size: int = 1000
    max_import_bytes: int = 50 * 1024 * 1024

    # SQLite connections may only open files under this directory (prevents arbitrary file reads).
    sqlite_root: Path = Path("./data/sqlite")

    # Connection pools are closed after this many idle seconds.
    engine_idle_seconds: int = 600

    # Rate limiting (requests per minute)
    login_rate_per_minute: int = 10
    api_rate_per_minute: int = 600

    cors_origins: list[str] = Field(default_factory=list)

    def resolved_secret(self) -> str:
        if self.secret_key:
            return self.secret_key
        self.data_dir.mkdir(parents=True, exist_ok=True)
        path = self.data_dir / "secret.key"
        if not path.exists():
            path.write_text(secrets.token_urlsafe(48))
            try:
                os.chmod(path, 0o600)
            except OSError:  # pragma: no cover - Windows
                pass
        return path.read_text().strip()


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.data_dir.mkdir(parents=True, exist_ok=True)
    s.sqlite_root.mkdir(parents=True, exist_ok=True)
    return s
