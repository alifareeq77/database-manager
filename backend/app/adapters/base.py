"""The database adapter abstraction.

Every engine implements :class:`DatabaseAdapter`. The rest of the application (API routes,
services, the frontend) only ever talks to this interface and the engine-neutral types in
``types.py`` / ``requests.py``. Generic behaviour that can be expressed with SQLAlchemy Core
(paginated reads, CRUD, streaming, statement execution) lives here; adapters supply
introspection queries, session setup, cancellation and dialect-specific DDL.
"""

from __future__ import annotations

import asyncio
import re
import time
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, ClassVar

import sqlalchemy as sa
from sqlalchemy.engine import URL
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

from app.adapters import requests as rq
from app.adapters.sqlutil import serialize_value, split_statements, validate_column_type
from app.adapters.types import (
    CatalogTable,
    Capabilities,
    ColumnInfo,
    DashboardData,
    DataPage,
    DbObject,
    ResultColumn,
    ResultSet,
    SchemaInfo,
    ServerInfo,
    TableStructure,
)


class AdapterError(Exception):
    """A user-facing database error (message is safe to show)."""


@dataclass
class ConnectionConfig:
    """Decrypted connection settings. Lives only in backend memory; never serialized to clients."""

    id: str
    engine: str
    host: str | None = None
    port: int | None = None
    username: str | None = None
    password: str | None = field(default=None, repr=False)
    database: str | None = None
    ssl_mode: str = "prefer"
    ssl_ca: str | None = field(default=None, repr=False)
    params: dict[str, Any] = field(default_factory=dict)
    read_only: bool = False
    query_timeout_s: int = 30


BackendHandle = Any
OnStart = Callable[[BackendHandle], Awaitable[None] | None]

_READ_PREFIX = re.compile(r"^\s*(\(\s*)*(select|with|show|explain|values|table|pragma|describe|desc)\b", re.I)


def is_row_returning(stmt: str) -> bool:
    """Heuristic used only to pick an execution strategy (streamed read vs. plain execute)."""
    return bool(_READ_PREFIX.match(_strip_leading_comments(stmt)))


def _strip_leading_comments(stmt: str) -> str:
    return re.sub(r"^(\s*(--[^\n]*\n|/\*.*?\*/))*", "", stmt, flags=re.S)


class RawType(sa.types.UserDefinedType):
    """Renders a database-reported type name verbatim inside CAST(... AS <type>)."""

    cache_ok = True
    _SAFE = re.compile(r'^[A-Za-z0-9_ ."(),\[\]]+$')

    def __init__(self, spec: str):
        if not self._SAFE.match(spec) or "--" in spec:
            raise AdapterError(f"Unsupported column type for binding: {spec}")
        self.spec = spec

    def get_col_spec(self, **_kw: Any) -> str:
        return self.spec


class DatabaseAdapter(ABC):
    engine_name: ClassVar[str]
    default_port: ClassVar[int | None] = None
    capabilities: ClassVar[Capabilities]
    identifier_quote: ClassVar[str] = '"'
    dollar_quotes: ClassVar[bool] = False
    estimate_threshold: ClassVar[int] = 500_000  # use estimated counts above this many rows

    def __init__(self, config: ConnectionConfig):
        self.config = config
        self._engines: dict[str | None, AsyncEngine] = {}
        self._lock = asyncio.Lock()
        self.last_used = time.monotonic()

    # ------------------------------------------------------------------ connection lifecycle

    @abstractmethod
    def build_url(self, database: str | None) -> URL: ...

    def connect_args(self, database: str | None) -> dict[str, Any]:
        return {}

    def engine_kwargs(self) -> dict[str, Any]:
        return {"pool_size": 3, "max_overflow": 5, "pool_pre_ping": True, "pool_recycle": 1800, "pool_timeout": 15}

    def resolve_database(self, database: str | None) -> str | None:
        return database or self.config.database

    def engine_for(self, database: str | None) -> AsyncEngine:
        db = self.resolve_database(database)
        self.last_used = time.monotonic()
        eng = self._engines.get(db)
        if eng is None:
            eng = create_async_engine(
                self.build_url(db), connect_args=self.connect_args(db), **self.engine_kwargs()
            )
            self._attach_events(eng)
            self._engines[db] = eng
        return eng

    def _attach_events(self, engine: AsyncEngine) -> None:
        """Hook for adapters that need per-DBAPI-connection setup."""

    @property
    def dialect(self) -> sa.engine.Dialect:
        return self.engine_for(None).dialect

    async def connect(self) -> None:
        async with self.engine_for(None).connect() as conn:
            await conn.exec_driver_sql("SELECT 1")

    async def disconnect(self) -> None:
        engines, self._engines = list(self._engines.values()), {}
        for eng in engines:
            await eng.dispose()

    async def test_connection(self) -> ServerInfo:
        t0 = time.perf_counter()
        async with self.engine_for(None).connect() as conn:
            info = await self.server_info(conn)
        info.latency_ms = round((time.perf_counter() - t0) * 1000, 2)
        return info

    @abstractmethod
    async def server_info(self, conn: AsyncConnection) -> ServerInfo: ...

    # ------------------------------------------------------------------ introspection

    @abstractmethod
    async def list_databases(self) -> list[SchemaInfo]: ...

    @abstractmethod
    async def list_schemas(self, database: str | None) -> list[SchemaInfo]: ...

    @abstractmethod
    async def list_objects(self, database: str | None, schema: str | None) -> list[DbObject]: ...

    @abstractmethod
    async def get_columns(self, database: str | None, schema: str | None, table: str) -> list[ColumnInfo]: ...

    @abstractmethod
    async def get_table_structure(self, database: str | None, schema: str | None, table: str) -> TableStructure: ...

    @abstractmethod
    async def get_catalog(self, database: str | None) -> list[CatalogTable]: ...

    @abstractmethod
    async def get_ddl(self, database: str | None, schema: str | None, name: str, kind: str) -> str: ...

    @abstractmethod
    async def get_dashboard(self, database: str | None) -> DashboardData: ...

    async def estimate_rows(self, conn: AsyncConnection, schema: str | None, table: str) -> int | None:
        return None

    # ------------------------------------------------------------------ helpers

    def quote(self, ident: str) -> str:
        return self.dialect.identifier_preparer.quote_identifier(ident)

    def qualified(self, schema: str | None, name: str) -> str:
        return f"{self.quote(schema)}.{self.quote(name)}" if schema else self.quote(name)

    def _sa_table(self, schema: str | None, table: str, columns: list[ColumnInfo]) -> sa.TableClause:
        return sa.table(table, *[sa.column(c.name) for c in columns], schema=schema)

    def bind_value(self, value: Any, col: ColumnInfo) -> sa.ColumnElement[Any]:
        """Bind a client-supplied value for comparison with / assignment to ``col``."""
        if value is None:
            return sa.null()
        if isinstance(value, (dict, list)):
            import json

            value = json.dumps(value)
        elif isinstance(value, bool) and col.category != "boolean":
            value = int(value)
        return sa.literal(value)

    def as_text(self, col: sa.ColumnElement[Any]) -> sa.ColumnElement[Any]:
        return sa.cast(col, sa.Text)

    def clean_error(self, exc: BaseException) -> str:
        orig = getattr(exc, "orig", None) or exc
        msg = str(orig).strip()
        # SQLAlchemy appends "(Background on this error at: ...)" and the SQL; keep only the message.
        msg = re.split(r"\n\[SQL:|\n\(Background on this error", msg)[0].strip()
        if self.config.password:
            msg = msg.replace(self.config.password, "••••")
        return msg or exc.__class__.__name__

    async def _run(self, coro: Awaitable[Any]) -> Any:
        try:
            return await coro
        except AdapterError:
            raise
        except (sa.exc.SQLAlchemyError, OSError, asyncio.TimeoutError, ConnectionError) as exc:
            raise AdapterError(self.clean_error(exc)) from exc
        except Exception as exc:  # driver-specific exceptions not wrapped by SQLAlchemy
            raise AdapterError(self.clean_error(exc)) from exc

    async def fetch_all(
        self, database: str | None, sql: str, params: dict[str, Any] | None = None
    ) -> list[sa.Row[Any]]:
        async def go() -> list[sa.Row[Any]]:
            async with self.engine_for(database).connect() as conn:
                res = await conn.execute(sa.text(sql), params or {})
                return list(res.fetchall())

        return await self._run(go())

    # ------------------------------------------------------------------ table data

    def _column_map(self, columns: list[ColumnInfo]) -> dict[str, ColumnInfo]:
        return {c.name: c for c in columns}

    def _filter_clause(
        self, t: sa.TableClause, cols: dict[str, ColumnInfo], f: rq.FilterSpec
    ) -> sa.ColumnElement[bool]:
        if f.column not in cols:
            raise AdapterError(f"Unknown column: {f.column}")
        meta, c = cols[f.column], t.c[f.column]
        op = f.op
        if op == "is_null":
            return c.is_(None)
        if op == "not_null":
            return c.is_not(None)
        if op in ("contains", "not_contains", "starts_with", "ends_with"):
            needle = str(f.value if f.value is not None else "")
            escaped = needle.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            pattern = {"contains": f"%{escaped}%", "not_contains": f"%{escaped}%",
                       "starts_with": f"{escaped}%", "ends_with": f"%{escaped}"}[op]
            expr = self.as_text(c).ilike(pattern, escape="\\")
            return sa.not_(expr) if op == "not_contains" else expr
        if op in ("in", "not_in"):
            values = f.value if isinstance(f.value, list) else [v.strip() for v in str(f.value).split(",")]
            if not values:
                raise AdapterError("IN filter requires at least one value")
            bound = [self.bind_value(v, meta) for v in values[:1000]]
            return c.in_(bound) if op == "in" else c.not_in(bound)
        v = self.bind_value(f.value, meta)
        return {"eq": c == v, "neq": c != v, "gt": c > v, "gte": c >= v, "lt": c < v, "lte": c <= v}[op]

    def _where(self, t: sa.TableClause, cols: dict[str, ColumnInfo], req: rq.DataRequest) -> list[sa.ColumnElement[bool]]:
        clauses: list[sa.ColumnElement[bool]] = []
        if req.filters:
            parts = [self._filter_clause(t, cols, f) for f in req.filters]
            clauses.append(sa.and_(*parts) if req.filter_mode == "and" else sa.or_(*parts))
        if req.search:
            escaped = req.search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            searchable = [
                self.as_text(t.c[name]).ilike(f"%{escaped}%", escape="\\")
                for name, meta in cols.items() if meta.category not in ("binary",)
            ]
            if searchable:
                clauses.append(sa.or_(*searchable))
        return clauses

    def _render(self, stmt: sa.ClauseElement) -> str:
        try:
            return str(stmt.compile(dialect=self.dialect, compile_kwargs={"literal_binds": True}))
        except Exception:
            return str(stmt.compile(dialect=self.dialect))

    async def get_table_data(self, database: str | None, req: rq.DataRequest, max_page_size: int) -> DataPage:
        columns = await self.get_columns(database, req.schema_name, req.table)
        if not columns:
            raise AdapterError(f"Table not found: {req.table}")
        cols = self._column_map(columns)
        pk = [c.name for c in columns if c.is_primary_key]
        t = self._sa_table(req.schema_name, req.table, columns)
        page_size = min(req.page_size, max_page_size)
        where = self._where(t, cols, req)

        order: list[sa.ColumnElement[Any]] = []
        for s in req.sort:
            if s.column not in cols:
                raise AdapterError(f"Unknown sort column: {s.column}")
            order.append(t.c[s.column].desc() if s.direction == "desc" else t.c[s.column].asc())
        if not order and pk:
            order = [t.c[k].asc() for k in pk]  # stable pagination

        stmt = sa.select(*[t.c[c.name] for c in columns]).select_from(t)
        if where:
            stmt = stmt.where(*where)
        stmt = stmt.order_by(*order).limit(page_size).offset((req.page - 1) * page_size)

        async def go() -> DataPage:
            t0 = time.perf_counter()
            async with self.engine_for(database).connect() as conn:
                await self.prepare_session(conn, self.config.query_timeout_s)
                rows = (await conn.execute(stmt)).fetchall()
                total: int | None = None
                estimate = False
                if req.with_total:
                    est = None if where else await self.estimate_rows(conn, req.schema_name, req.table)
                    if est is not None and est > self.estimate_threshold:
                        total, estimate = est, True
                    else:
                        cstmt = sa.select(sa.func.count()).select_from(t)
                        if where:
                            cstmt = cstmt.where(*where)
                        total = int((await conn.execute(cstmt)).scalar() or 0)
                await conn.rollback()
            return DataPage(
                columns=columns,
                rows=[[serialize_value(v) for v in r] for r in rows],
                total=total,
                total_is_estimate=estimate,
                page=req.page,
                page_size=page_size,
                primary_key=pk,
                editable=bool(pk) and not self.config.read_only,
                sql=self._render(stmt),
                duration_ms=round((time.perf_counter() - t0) * 1000, 2),
            )

        return await self._run(go())

    def _key_clause(self, t: sa.TableClause, cols: dict[str, ColumnInfo], pk: list[str], key: dict[str, Any]) -> sa.ColumnElement[bool]:
        if not pk:
            raise AdapterError("This table has no primary key; rows cannot be addressed safely.")
        if set(key) != set(pk):
            raise AdapterError(f"Row key must contain exactly the primary key columns: {', '.join(pk)}")
        return sa.and_(*[t.c[k] == self.bind_value(key[k], cols[k]) for k in pk])

    async def _mutate(self, database: str | None, stmts: list[sa.Executable]) -> int:
        if self.config.read_only:
            raise AdapterError("This connection is read-only.")

        async def go() -> int:
            affected = 0
            async with self.engine_for(database).begin() as conn:
                await self.prepare_session(conn, self.config.query_timeout_s)
                for s in stmts:
                    res = await conn.execute(s)
                    affected += max(res.rowcount or 0, 0)
            return affected

        return await self._run(go())

    def _insert_statements(self, schema: str | None, table: str, columns: list[ColumnInfo],
                           rows: list[dict[str, Any]], chunk: int = 200) -> list[sa.Executable]:
        cols = self._column_map(columns)
        t = self._sa_table(schema, table, columns)
        stmts: list[sa.Executable] = []
        groups: dict[tuple[str, ...], list[dict[str, Any]]] = {}
        for row in rows:
            unknown = set(row) - set(cols)
            if unknown:
                raise AdapterError(f"Unknown column(s): {', '.join(sorted(unknown))}")
            if not row:
                stmts.append(self.insert_default_values(t))
                continue
            groups.setdefault(tuple(sorted(row)), []).append(row)
        for keys, group in groups.items():
            size = max(1, min(chunk, 30_000 // max(1, len(keys))))  # stay under driver bind-parameter limits
            for i in range(0, len(group), size):
                values = [{k: self.bind_value(v, cols[k]) for k, v in r.items()} for r in group[i : i + size]]
                stmts.append(sa.insert(t).values(values))
        return stmts

    async def insert_rows(self, database: str | None, req: rq.InsertRequest) -> tuple[int, list[str]]:
        columns = await self.get_columns(database, req.schema_name, req.table)
        stmts = self._insert_statements(req.schema_name, req.table, columns, req.rows)
        n = await self._mutate(database, stmts)
        return n, [self._render(s) for s in stmts[:5]]

    async def import_rows(self, database: str | None, schema: str | None, table: str, rows: list[dict[str, Any]]) -> int:
        """Insert many rows in a single transaction (all-or-nothing)."""
        columns = await self.get_columns(database, schema, table)
        if not columns:
            raise AdapterError(f"Table not found: {table}")
        return await self._mutate(database, self._insert_statements(schema, table, columns, rows))

    def insert_default_values(self, t: sa.TableClause) -> sa.Executable:
        return sa.text(f"INSERT INTO {self.qualified(t.schema, t.name)} DEFAULT VALUES")

    async def update_rows(self, database: str | None, req: rq.UpdateRequest) -> tuple[int, list[str]]:
        columns = await self.get_columns(database, req.schema_name, req.table)
        cols = self._column_map(columns)
        pk = [c.name for c in columns if c.is_primary_key]
        t = self._sa_table(req.schema_name, req.table, columns)
        stmts: list[sa.Executable] = []
        for u in req.updates:
            unknown = set(u.values) - set(cols)
            if unknown:
                raise AdapterError(f"Unknown column(s): {', '.join(sorted(unknown))}")
            stmts.append(
                sa.update(t)
                .where(self._key_clause(t, cols, pk, u.key))
                .values({k: self.bind_value(v, cols[k]) for k, v in u.values.items()})
            )
        n = await self._mutate(database, stmts)
        return n, [self._render(s) for s in stmts[:20]]

    async def delete_rows(self, database: str | None, req: rq.DeleteRequest) -> tuple[int, list[str]]:
        columns = await self.get_columns(database, req.schema_name, req.table)
        cols = self._column_map(columns)
        pk = [c.name for c in columns if c.is_primary_key]
        t = self._sa_table(req.schema_name, req.table, columns)
        clauses = [self._key_clause(t, cols, pk, k) for k in req.keys]
        stmts: list[sa.Executable] = [
            sa.delete(t).where(sa.or_(*clauses[i : i + 500])) for i in range(0, len(clauses), 500)
        ]
        n = await self._mutate(database, stmts)
        return n, [self._render(s) for s in stmts[:5]]

    async def stream_table(
        self, database: str | None, req: rq.DataRequest, limit: int | None = None
    ) -> tuple[list[ColumnInfo], AsyncIterator[list[Any]]]:
        """Stream all rows matching ``req`` (ignoring pagination) using a server-side cursor."""
        columns = await self.get_columns(database, req.schema_name, req.table)
        if not columns:
            raise AdapterError(f"Table not found: {req.table}")
        cols = self._column_map(columns)
        t = self._sa_table(req.schema_name, req.table, columns)
        stmt = sa.select(*[t.c[c.name] for c in columns]).select_from(t)
        where = self._where(t, cols, req)
        if where:
            stmt = stmt.where(*where)
        order = [t.c[s.column].desc() if s.direction == "desc" else t.c[s.column].asc() for s in req.sort if s.column in cols]
        if order:
            stmt = stmt.order_by(*order)
        if limit:
            stmt = stmt.limit(limit)
        return columns, self._stream(database, stmt)

    async def _stream(self, database: str | None, stmt: sa.Executable) -> AsyncIterator[list[Any]]:
        async with self.engine_for(database).connect() as conn:
            async with conn.stream(stmt.execution_options(yield_per=1000)) as result:
                async for row in result:
                    yield list(row)
            await conn.rollback()

    async def stream_query(self, database: str | None, sql: str) -> tuple[list[str], AsyncIterator[list[Any]]]:
        """Stream a single read statement for export."""
        stmts = split_statements(sql, self.dollar_quotes)
        if len(stmts) != 1 or not is_row_returning(stmts[0]):
            raise AdapterError("Export requires exactly one row-returning statement.")
        engine = self.engine_for(database)
        conn = await engine.connect()
        try:
            await self.prepare_session(conn, self.config.query_timeout_s * 4)
            result = await conn.stream(sa.text(_escape_colons(stmts[0])).execution_options(yield_per=1000))
        except Exception as exc:
            await conn.close()
            raise AdapterError(self.clean_error(exc)) from exc
        names = list(result.keys())

        async def rows() -> AsyncIterator[list[Any]]:
            try:
                async for row in result:
                    yield list(row)
            finally:
                await result.close()
                await conn.rollback()
                await conn.close()

        return names, rows()

    # ------------------------------------------------------------------ query execution

    async def prepare_session(self, conn: AsyncConnection, timeout_s: int) -> None:
        """Apply per-execution session settings (statement timeouts)."""

    async def backend_handle(self, conn: AsyncConnection) -> BackendHandle:
        return None

    async def cancel_backend(self, database: str | None, handle: BackendHandle) -> bool:
        return False

    def needs_autocommit(self, stmt: str) -> bool:
        return False

    def result_column(self, name: str, cursor_desc: Any) -> ResultColumn:
        return ResultColumn(name=name)

    async def execute_query(
        self,
        database: str | None,
        sql: str,
        *,
        max_rows: int,
        timeout_s: int,
        on_start: OnStart | None = None,
    ) -> list[ResultSet]:
        statements = split_statements(sql, self.dollar_quotes)
        if not statements:
            raise AdapterError("Nothing to execute.")
        results: list[ResultSet] = []
        try:
            conn_cm = self.engine_for(database).connect()
            conn = await conn_cm.__aenter__()
        except Exception as exc:
            raise AdapterError(self.clean_error(exc)) from exc
        handle = None
        try:
            await self.prepare_session(conn, timeout_s)
            await conn.commit()
            handle = await self.backend_handle(conn)
            if on_start:
                maybe = on_start(handle)
                if asyncio.iscoroutine(maybe):
                    await maybe
            for stmt in statements:
                t0 = time.perf_counter()
                try:
                    rs = await asyncio.wait_for(self._execute_one(conn, stmt, max_rows), timeout=timeout_s + 3)
                except asyncio.TimeoutError:
                    await self.cancel_backend(database, handle)
                    rs = ResultSet(statement=stmt, error=f"Query exceeded the {timeout_s}s timeout and was cancelled.")
                    await _safe_rollback(conn)
                except Exception as exc:
                    rs = ResultSet(statement=stmt, error=self.clean_error(exc))
                    await _safe_rollback(conn)
                rs.duration_ms = round((time.perf_counter() - t0) * 1000, 2)
                results.append(rs)
                if rs.error:
                    break
        finally:
            await conn_cm.__aexit__(None, None, None)
        return results

    async def _execute_one(self, conn: AsyncConnection, stmt: str, max_rows: int) -> ResultSet:
        if self.needs_autocommit(stmt):
            await conn.commit()
            ac = await conn.execution_options(isolation_level="AUTOCOMMIT")
            res = await ac.exec_driver_sql(stmt)
            rs = ResultSet(statement=stmt, row_count=res.rowcount if res.rowcount >= 0 else None)
            await conn.execution_options(isolation_level=self.default_isolation())
            return rs
        if is_row_returning(stmt):
            result = await conn.stream(sa.text(_escape_colons(stmt)))
            try:
                names = list(result.keys())
                desc = getattr(result._real_result, "cursor", None)  # noqa: SLF001
                desc = getattr(desc, "description", None)
                batch = await result.fetchmany(max_rows + 1)
            finally:
                await result.close()
            await conn.commit()
            truncated = len(batch) > max_rows
            rows = [[serialize_value(v) for v in r] for r in batch[:max_rows]]
            columns = [self.result_column(n, desc[i] if desc and i < len(desc) else None) for i, n in enumerate(names)]
            if columns and all(c.category == "other" for c in columns):
                _infer_categories(columns, rows)
            return ResultSet(statement=stmt, columns=columns, rows=rows, row_count=len(rows),
                             truncated=truncated, returns_rows=True)
        res = await conn.exec_driver_sql(stmt)
        if res.returns_rows:  # e.g. INSERT ... RETURNING, CALL
            batch = res.fetchmany(max_rows + 1)
            names = list(res.keys())
            await conn.commit()
            rows = [[serialize_value(v) for v in r] for r in batch[:max_rows]]
            cols = [ResultColumn(name=n) for n in names]
            _infer_categories(cols, rows)
            return ResultSet(statement=stmt, columns=cols, rows=rows, row_count=len(rows),
                             truncated=len(batch) > max_rows, returns_rows=True)
        rowcount = res.rowcount
        await conn.commit()
        return ResultSet(statement=stmt, row_count=rowcount if rowcount is not None and rowcount >= 0 else None)

    def default_isolation(self) -> str:
        return "READ COMMITTED"

    # ------------------------------------------------------------------ DDL generation

    def _fk_action(self, action: str) -> str:
        if action not in ("NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"):
            raise AdapterError(f"Invalid referential action: {action}")
        return action

    def column_type(self, col: rq.ColumnDef) -> str:
        try:
            return validate_column_type(col.type, allow_enum=self.engine_name == "mysql")
        except ValueError as exc:
            raise AdapterError(str(exc)) from exc

    def column_sql(self, col: rq.ColumnDef, inline_pk: bool = False) -> str:
        parts = [self.quote(col.name), self.column_type(col)]
        if not col.nullable or col.primary_key:
            parts.append("NOT NULL")
        if col.default not in (None, ""):
            parts.append(f"DEFAULT {col.default}")
        if col.unique and not col.primary_key:
            parts.append("UNIQUE")
        return " ".join(parts)

    def ddl_create_table(self, schema: str | None, table: str, op: rq.CreateTableOp) -> list[str]:
        pk = [c.name for c in op.columns if c.primary_key]
        lines = [self.column_sql(c) for c in op.columns]
        if pk:
            lines.append(f"PRIMARY KEY ({', '.join(self.quote(c) for c in pk)})")
        ine = "IF NOT EXISTS " if op.if_not_exists else ""
        body = ",\n  ".join(lines)
        return [f"CREATE TABLE {ine}{self.qualified(schema, table)} (\n  {body}\n)"]

    def ddl_alter_column(self, tbl: str, op: rq.AlterColumnOp, current: ColumnInfo | None) -> list[str]:
        raise AdapterError(f"Altering columns is not supported for {self.engine_name}.")

    def ddl_rename_table(self, schema: str | None, table: str, new_name: str) -> str:
        return f"ALTER TABLE {self.qualified(schema, table)} RENAME TO {self.quote(new_name)}"

    def ddl_truncate(self, tbl: str) -> str:
        return f"TRUNCATE TABLE {tbl}"

    def ddl_drop_index(self, schema: str | None, table: str, name: str) -> str:
        return f"DROP INDEX {self.qualified(schema, name)}"

    def ddl_drop_constraint(self, tbl: str, op: rq.DropConstraintOp) -> str:
        return f"ALTER TABLE {tbl} DROP CONSTRAINT {self.quote(op.name)}"

    def ddl_drop_table(self, tbl: str, op: rq.DropTableOp) -> str:
        kind = {"table": "TABLE", "view": "VIEW", "materialized_view": "MATERIALIZED VIEW"}[op.kind]
        return f"DROP {kind} {tbl}" + (" CASCADE" if op.cascade else "")

    def ddl_create_index(self, schema: str | None, table: str, op: rq.CreateIndexOp) -> str:
        cols = ", ".join(self.quote(c) for c in op.columns)
        uniq = "UNIQUE " if op.unique else ""
        return f"CREATE {uniq}INDEX {self.quote(op.name)} ON {self.qualified(schema, table)} ({cols})"

    async def generate_ddl(self, database: str | None, req: rq.SchemaChangeRequest) -> list[str]:
        """Translate structured operations into SQL statements (no execution)."""
        schema, table = req.schema_name, req.table
        tbl = self.qualified(schema, table)
        out: list[str] = []
        current_cols: dict[str, ColumnInfo] | None = None
        for op in req.operations:
            match op:
                case rq.CreateTableOp():
                    out += self.ddl_create_table(schema, table, op)
                case rq.AddColumnOp():
                    out.append(f"ALTER TABLE {tbl} ADD COLUMN {self.column_sql(op.column)}")
                case rq.DropColumnOp():
                    out.append(f"ALTER TABLE {tbl} DROP COLUMN {self.quote(op.column)}")
                case rq.RenameColumnOp():
                    out.append(f"ALTER TABLE {tbl} RENAME COLUMN {self.quote(op.column)} TO {self.quote(op.new_name)}")
                case rq.AlterColumnOp():
                    if current_cols is None:
                        current_cols = self._column_map(await self.get_columns(database, schema, table))
                    out += self.ddl_alter_column(tbl, op, current_cols.get(op.column))
                case rq.RenameTableOp():
                    out.append(self.ddl_rename_table(schema, table, op.new_name))
                case rq.DropTableOp():
                    out.append(self.ddl_drop_table(tbl, op))
                case rq.TruncateTableOp():
                    out.append(self.ddl_truncate(tbl))
                case rq.CreateIndexOp():
                    out.append(self.ddl_create_index(schema, table, op))
                case rq.DropIndexOp():
                    out.append(self.ddl_drop_index(schema, table, op.name))
                case rq.AddForeignKeyOp():
                    if not self.capabilities.add_constraint:
                        raise AdapterError(f"Adding constraints to existing tables is not supported by {self.engine_name}.")
                    out.append(
                        f"ALTER TABLE {tbl} ADD CONSTRAINT {self.quote(op.name)} FOREIGN KEY "
                        f"({', '.join(self.quote(c) for c in op.columns)}) REFERENCES "
                        f"{self.qualified(op.ref_schema, op.ref_table)} ({', '.join(self.quote(c) for c in op.ref_columns)}) "
                        f"ON DELETE {self._fk_action(op.on_delete)} ON UPDATE {self._fk_action(op.on_update)}"
                    )
                case rq.AddUniqueOp():
                    if not self.capabilities.add_constraint:
                        raise AdapterError(f"Adding constraints to existing tables is not supported by {self.engine_name}; create a unique index instead.")
                    out.append(f"ALTER TABLE {tbl} ADD CONSTRAINT {self.quote(op.name)} UNIQUE ({', '.join(self.quote(c) for c in op.columns)})")
                case rq.AddCheckOp():
                    if not self.capabilities.add_constraint:
                        raise AdapterError(f"Adding constraints to existing tables is not supported by {self.engine_name}.")
                    if ";" in op.expression:
                        raise AdapterError("Check expressions may not contain ';'.")
                    out.append(f"ALTER TABLE {tbl} ADD CONSTRAINT {self.quote(op.name)} CHECK ({op.expression})")
                case rq.DropConstraintOp():
                    if not self.capabilities.add_constraint:
                        raise AdapterError(f"Dropping constraints is not supported by {self.engine_name}.")
                    out.append(self.ddl_drop_constraint(tbl, op))
        return out

    async def apply_ddl(self, database: str | None, statements: list[str]) -> None:
        if self.config.read_only:
            raise AdapterError("This connection is read-only.")

        async def go() -> None:
            if self.capabilities.transactional_ddl:
                async with self.engine_for(database).begin() as conn:
                    for s in statements:
                        await conn.exec_driver_sql(s)
            else:
                async with self.engine_for(database).connect() as conn:
                    for s in statements:
                        await conn.exec_driver_sql(s)
                        await conn.commit()

        await self._run(go())


def _escape_colons(stmt: str) -> str:
    # sa.text() treats ":name" as a bind parameter; escape every colon so SQL runs verbatim.
    return stmt.replace(":", "\\:")


async def _safe_rollback(conn: AsyncConnection) -> None:
    try:
        await conn.rollback()
    except Exception:  # connection may already be invalidated
        pass


def _infer_categories(columns: list[ResultColumn], rows: list[list[Any]]) -> None:
    for i, col in enumerate(columns):
        for r in rows[:50]:
            v = r[i] if i < len(r) else None
            if v is None:
                continue
            if isinstance(v, bool):
                col.category = "boolean"
            elif isinstance(v, int):
                col.category = "integer"
            elif isinstance(v, float):
                col.category = "float"
            elif isinstance(v, (dict, list)):
                col.category = "binary" if isinstance(v, dict) and "$binary" in v else "json"
            elif isinstance(v, str) and re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", v):
                col.category = "datetime"
            else:
                col.category = "text"
            break
