"""SQL text utilities: statement splitting and JSON-safe value serialization."""

from __future__ import annotations

import base64
import datetime as dt
import decimal
import ipaddress
import re
import uuid
from typing import Any

MAX_CELL_CHARS = 100_000
MAX_BINARY_PREVIEW = 1024


def split_statements(sql: str, dollar_quotes: bool = False) -> list[str]:
    """Split a script into statements on top-level semicolons.

    Respects single/double/backtick quotes, line and block comments, and (for PostgreSQL)
    dollar-quoted bodies. MySQL ``DELIMITER`` directives are honoured so procedure bodies survive.
    """
    statements: list[str] = []
    buf: list[str] = []
    i, n = 0, len(sql)
    delimiter = ";"

    def flush() -> None:
        stmt = "".join(buf).strip()
        if stmt and not _only_comments(stmt):
            statements.append(stmt)
        buf.clear()

    while i < n:
        ch = sql[i]
        # DELIMITER directive (MySQL client syntax) at line start
        if (i == 0 or sql[i - 1] == "\n") and sql[i : i + 10].upper() == "DELIMITER ":
            end = sql.find("\n", i)
            end = n if end == -1 else end
            flush()
            delimiter = sql[i + 10 : end].strip() or ";"
            i = end + 1
            continue
        if ch == "-" and sql.startswith("--", i) or ch == "#" and not dollar_quotes:
            end = sql.find("\n", i)
            end = n if end == -1 else end
            buf.append(sql[i:end])
            i = end
            continue
        if ch == "/" and sql.startswith("/*", i):
            end = sql.find("*/", i + 2)
            end = n if end == -1 else end + 2
            buf.append(sql[i:end])
            i = end
            continue
        if ch in ("'", '"', "`"):
            j = i + 1
            while j < n:
                if sql[j] == "\\" and ch != '"' and not dollar_quotes:
                    j += 2
                    continue
                if sql[j] == ch:
                    if j + 1 < n and sql[j + 1] == ch:  # doubled quote escape
                        j += 2
                        continue
                    break
                j += 1
            buf.append(sql[i : j + 1])
            i = j + 1
            continue
        if dollar_quotes and ch == "$":
            m = re.match(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$", sql[i:])
            if m:
                tag = m.group(0)
                end = sql.find(tag, i + len(tag))
                end = n if end == -1 else end + len(tag)
                buf.append(sql[i:end])
                i = end
                continue
        if sql.startswith(delimiter, i):
            flush()
            i += len(delimiter)
            continue
        buf.append(ch)
        i += 1
    flush()
    return statements


def _only_comments(stmt: str) -> bool:
    stripped = re.sub(r"--[^\n]*|/\*.*?\*/", "", stmt, flags=re.S).strip()
    return stripped == ""


def serialize_value(value: Any) -> Any:
    """Convert a driver value into something JSON can carry without losing meaning."""
    if value is None or isinstance(value, (bool, int, str)):
        if isinstance(value, str) and len(value) > MAX_CELL_CHARS:
            return value[:MAX_CELL_CHARS] + "…"
        if isinstance(value, int) and abs(value) > 2**53:  # beyond JS safe integer range
            return str(value)
        return value
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return str(value)
        return value
    if isinstance(value, decimal.Decimal):
        return str(value)
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, dt.timedelta):
        return str(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        return {"$binary": base64.b64encode(raw[:MAX_BINARY_PREVIEW]).decode(), "length": len(raw)}
    if isinstance(value, (dict,)):
        return {str(k): serialize_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [serialize_value(v) for v in value]
    if isinstance(value, (ipaddress.IPv4Address, ipaddress.IPv6Address, ipaddress.IPv4Network, ipaddress.IPv6Network)):
        return str(value)
    return str(value)


def category_for_type(type_name: str) -> str:
    """Map a database type name to a coarse UI category."""
    t = type_name.lower().strip()
    if t.endswith("[]") or t.startswith("_") or t == "array":
        return "array"
    if t in ("tinyint(1)", "boolean", "bool", "bit(1)"):
        return "boolean"
    if re.match(r"^(small|big|medium|tiny)?int|^integer|^serial|^bigserial|^smallserial|^int\d|^oid", t):
        return "integer"
    if re.match(r"^(double|float|real)", t):
        return "float"
    if re.match(r"^(numeric|decimal|money)", t):
        return "decimal"
    if re.match(r"^(jsonb?)$", t):
        return "json"
    if t == "uuid":
        return "uuid"
    if re.match(r"^(timestamp|datetime)", t):
        return "datetime"
    if t == "date":
        return "date"
    if re.match(r"^time", t):
        return "time"
    if re.match(r"^(bytea|blob|tinyblob|mediumblob|longblob|binary|varbinary)", t):
        return "binary"
    if re.match(r"^(char|varchar|character|text|tinytext|mediumtext|longtext|citext|name|enum|set|string|clob|nvarchar|nchar)", t):
        return "text"
    return "other"


_TYPE_RE = re.compile(
    r"^[A-Za-z][A-Za-z0-9_ ]{0,62}(\(\s*\d+(\s*,\s*\d+)?\s*\))?( unsigned| zerofill| with(out)? time zone)*(\[\])*$",
    re.IGNORECASE,
)


def validate_type_name(type_name: str) -> str:
    """Validate a user-supplied column type for DDL generation."""
    t = " ".join(type_name.split())
    if not _TYPE_RE.match(t):
        raise ValueError(f"Invalid column type: {type_name!r}")
    return t


_ENUM_RE = re.compile(r"^(enum|set)\s*\((\s*'([^'\\]|''|\\.)*'\s*,?)+\)$", re.IGNORECASE)


def validate_column_type(type_name: str, allow_enum: bool = False) -> str:
    if allow_enum and _ENUM_RE.match(type_name.strip()):
        return type_name.strip()
    return validate_type_name(type_name)
