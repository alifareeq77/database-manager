"""Streaming serializers for CSV / JSON / SQL INSERT exports."""

from __future__ import annotations

import csv
import datetime as dt
import decimal
import io
import json
import uuid
from collections.abc import AsyncIterator
from typing import Any

from app.adapters.sqlutil import serialize_value

BATCH = 500


def _plain(value: Any) -> Any:
    v = serialize_value(value)
    if isinstance(v, dict) and "$binary" in v:
        return value.hex() if isinstance(value, (bytes, bytearray)) else bytes(value).hex()
    return v


async def csv_stream(columns: list[str], rows: AsyncIterator[list[Any]]) -> AsyncIterator[bytes]:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(columns)
    yield ("﻿" + buf.getvalue()).encode()  # BOM so spreadsheet apps detect UTF-8
    buf.seek(0), buf.truncate(0)
    n = 0
    async for row in rows:
        writer.writerow(["" if v is None else json.dumps(p) if isinstance(p := _plain(v), (dict, list)) else p for v in row])
        n += 1
        if n % BATCH == 0:
            yield buf.getvalue().encode()
            buf.seek(0), buf.truncate(0)
    if buf.tell():
        yield buf.getvalue().encode()


async def json_stream(columns: list[str], rows: AsyncIterator[list[Any]]) -> AsyncIterator[bytes]:
    yield b"[\n"
    first = True
    parts: list[str] = []
    async for row in rows:
        parts.append(("" if first else ",\n") + json.dumps(dict(zip(columns, (_plain(v) for v in row), strict=False)), ensure_ascii=False))
        first = False
        if len(parts) >= BATCH:
            yield "".join(parts).encode()
            parts.clear()
    parts.append("\n]\n")
    yield "".join(parts).encode()


def sql_literal(value: Any, engine: str) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return ("1" if value else "0") if engine == "sqlite" else ("TRUE" if value else "FALSE")
    if isinstance(value, (int, float, decimal.Decimal)):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        h = bytes(value).hex()
        return f"'\\x{h}'::bytea" if engine == "postgresql" else f"X'{h}'"
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False)
    elif isinstance(value, (dt.date, dt.datetime, dt.time)):
        value = value.isoformat(sep=" ") if isinstance(value, dt.datetime) else value.isoformat()
    elif isinstance(value, uuid.UUID):
        value = str(value)
    s = str(value).replace("'", "''")
    if engine == "mysql":
        s = s.replace("\\", "\\\\")
    return f"'{s}'"


async def sql_stream(table_sql: str, quoted_columns: list[str], engine: str, rows: AsyncIterator[list[Any]]) -> AsyncIterator[bytes]:
    head = f"INSERT INTO {table_sql} ({', '.join(quoted_columns)}) VALUES "
    parts: list[str] = []
    async for row in rows:
        parts.append(head + "(" + ", ".join(sql_literal(v, engine) for v in row) + ");\n")
        if len(parts) >= BATCH:
            yield "".join(parts).encode()
            parts.clear()
    if parts:
        yield "".join(parts).encode()
