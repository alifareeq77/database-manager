"""SQLite adapter (aiosqlite).

For safety, database files must live under ``settings.sqlite_root``; the connection's ``database``
field is a path relative to that directory.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import sqlalchemy as sa
from sqlalchemy import event
from sqlalchemy.engine import URL
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine
from sqlalchemy.pool import NullPool

from app.adapters import requests as rq
from app.adapters.base import AdapterError, DatabaseAdapter
from app.adapters.sqlutil import category_for_type
from app.adapters.types import (
    CatalogTable, Capabilities, ColumnInfo, ConstraintInfo, DashboardData, DbObject, ForeignKeyInfo,
    IndexInfo, MetricValue, SchemaInfo, ServerInfo, TableSize, TableStructure, TriggerInfo,
)
from app.config import get_settings


def resolve_sqlite_path(relative: str | None) -> Path:
    root = get_settings().sqlite_root.resolve()
    if not relative:
        raise AdapterError("SQLite connections need a database file name.")
    candidate = (root / relative).resolve()
    if root != candidate and root not in candidate.parents:
        raise AdapterError(f"SQLite files must be inside the configured directory ({root}).")
    if candidate.suffix.lower() not in (".db", ".sqlite", ".sqlite3", ".db3"):
        raise AdapterError("SQLite file must end in .db, .sqlite, .sqlite3 or .db3")
    return candidate


class SQLiteAdapter(DatabaseAdapter):
    engine_name = "sqlite"
    capabilities = Capabilities(
        schemas=False, multiple_databases=False, sequences=False, functions=False, procedures=False,
        triggers=True, cancel=True, transactional_ddl=True, alter_column=False, add_constraint=False,
    )

    def resolve_database(self, database: str | None) -> str | None:
        return "main"

    def build_url(self, database: str | None) -> URL:
        path = resolve_sqlite_path(self.config.database)
        if self.config.read_only:
            if not path.exists():
                raise AdapterError("Database file does not exist.")
            return URL.create("sqlite+aiosqlite", database=f"file:{path.as_posix()}?mode=ro", query={"uri": "true"})
        path.parent.mkdir(parents=True, exist_ok=True)
        return URL.create("sqlite+aiosqlite", database=path.as_posix())

    def engine_kwargs(self) -> dict[str, Any]:
        return {"poolclass": NullPool}

    def _attach_events(self, engine: AsyncEngine) -> None:
        @event.listens_for(engine.sync_engine, "connect")
        def _on_connect(dbapi_conn: Any, _rec: Any) -> None:
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA busy_timeout=5000")
            cur.close()

    def default_isolation(self) -> str:
        return "SERIALIZABLE"

    async def server_info(self, conn: AsyncConnection) -> ServerInfo:
        v = (await conn.exec_driver_sql("SELECT sqlite_version()")).scalar()
        return ServerInfo(engine="sqlite", version=f"SQLite {v}", current_database=self.config.database, latency_ms=0)

    async def backend_handle(self, conn: AsyncConnection) -> Any:
        raw = await conn.get_raw_connection()
        aio = raw.driver_connection  # aiosqlite.Connection
        return getattr(aio, "_conn", None)

    async def cancel_backend(self, database: str | None, handle: Any) -> bool:
        if handle is None:
            return False
        try:
            handle.interrupt()  # sqlite3.Connection.interrupt is thread-safe
            return True
        except Exception:
            return False

    # ---------------------------------------------------------------- introspection

    async def list_databases(self) -> list[SchemaInfo]:
        return [SchemaInfo(name="main")]

    async def list_schemas(self, database: str | None) -> list[SchemaInfo]:
        return []

    async def list_objects(self, database: str | None, schema: str | None) -> list[DbObject]:
        rows = await self.fetch_all(
            None,
            "SELECT name, type, tbl_name FROM sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
        )
        return [DbObject(name=r[0], kind=r[1], extra={"table": r[2]} if r[1] == "trigger" else {}) for r in rows]

    async def get_columns(self, database: str | None, schema: str | None, table: str) -> list[ColumnInfo]:
        rows = await self.fetch_all(None, "SELECT cid, name, type, \"notnull\", dflt_value, pk FROM pragma_table_info(:t)", {"t": table})
        pk_count = sum(1 for r in rows if r[5])
        out = []
        for r in rows:
            dtype = r[2] or ""
            out.append(ColumnInfo(
                name=r[1], data_type=dtype or "ANY", category=category_for_type(dtype) if dtype else "other",  # type: ignore[arg-type]
                nullable=not r[3] and not r[5], default=r[4], is_primary_key=bool(r[5]),
                is_auto_increment=bool(r[5]) and pk_count == 1 and dtype.upper() == "INTEGER", ordinal=r[0] + 1,
            ))
        return out

    async def get_table_structure(self, database: str | None, schema: str | None, table: str) -> TableStructure:
        meta = await self.fetch_all(None, "SELECT type, sql FROM sqlite_master WHERE name = :t AND type IN ('table','view')", {"t": table})
        if not meta:
            raise AdapterError(f"Table not found: {table}")
        kind = meta[0][0]
        columns = await self.get_columns(None, None, table)
        pk = [c.name for c in sorted([c for c in columns if c.is_primary_key], key=lambda c: c.ordinal)]
        indexes: list[IndexInfo] = []
        constraints: list[ConstraintInfo] = []
        if pk:
            constraints.append(ConstraintInfo(name="PRIMARY", type="primary_key", columns=pk, definition=f"PRIMARY KEY ({', '.join(pk)})"))
            indexes.append(IndexInfo(name="PRIMARY", columns=pk, unique=True, primary=True))
        for r in await self.fetch_all(None, "SELECT name, \"unique\", origin, partial FROM pragma_index_list(:t)", {"t": table}):
            cols = [c[0] or "(expression)" for c in await self.fetch_all(None, "SELECT name FROM pragma_index_info(:i) ORDER BY seqno", {"i": r[0]})]
            sql_row = await self.fetch_all(None, "SELECT sql FROM sqlite_master WHERE type='index' AND name=:i", {"i": r[0]})
            if r[2] == "pk":
                continue
            indexes.append(IndexInfo(name=r[0], columns=cols, unique=bool(r[1]), definition=sql_row[0][0] if sql_row else None))
            if r[2] == "u":
                constraints.append(ConstraintInfo(name=r[0], type="unique", columns=cols, definition=f"UNIQUE ({', '.join(cols)})"))
        fk_rows = await self.fetch_all(None, "SELECT id, seq, \"table\", \"from\", \"to\", on_update, on_delete FROM pragma_foreign_key_list(:t) ORDER BY id, seq", {"t": table})
        fks: dict[int, ForeignKeyInfo] = {}
        for r in fk_rows:
            fk = fks.setdefault(r[0], ForeignKeyInfo(name=f"fk_{table}_{r[0]}", columns=[], ref_schema=None, ref_table=r[2], ref_columns=[], on_update=r[5], on_delete=r[6]))
            fk.columns.append(r[3])
            fk.ref_columns.append(r[4] or "")
        for fk in fks.values():
            constraints.append(ConstraintInfo(name=fk.name, type="foreign_key", columns=fk.columns,
                                              definition=f"FOREIGN KEY ({', '.join(fk.columns)}) REFERENCES {fk.ref_table} ({', '.join(fk.ref_columns)})"))
        referenced_by: list[ForeignKeyInfo] = []
        for (other,) in await self.fetch_all(None, "SELECT name FROM sqlite_master WHERE type='table' AND name <> :t AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'", {"t": table}):
            for r in await self.fetch_all(None, "SELECT id, \"from\", \"to\", on_update, on_delete FROM pragma_foreign_key_list(:o) WHERE \"table\" = :t", {"o": other, "t": table}):
                referenced_by.append(ForeignKeyInfo(name=f"fk_{other}_{r[0]}", columns=[r[2] or ""], ref_schema=None, ref_table=other,
                                                    ref_columns=[r[1]], on_update=r[3], on_delete=r[4]))
        trg = await self.fetch_all(None, "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name=:t", {"t": table})
        return TableStructure(
            schema_name=None, name=table, kind="view" if kind == "view" else "table", columns=columns, primary_key=pk,
            indexes=indexes, foreign_keys=list(fks.values()), constraints=constraints, referenced_by=referenced_by,
            triggers=[TriggerInfo(name=r[0], definition=r[1]) for r in trg],
            view_definition=meta[0][1] if kind == "view" else None,
        )

    async def get_catalog(self, database: str | None) -> list[CatalogTable]:
        out = []
        for name, typ in await self.fetch_all(None, "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"):
            cols = await self.fetch_all(None, "SELECT name, type FROM pragma_table_info(:t)", {"t": name})
            out.append(CatalogTable(schema_name=None, name=name, kind=typ, columns=[(c[0], c[1] or "") for c in cols]))
        return out

    async def get_ddl(self, database: str | None, schema: str | None, name: str, kind: str) -> str:
        rows = await self.fetch_all(None, "SELECT sql FROM sqlite_master WHERE name = :n", {"n": name})
        if not rows or not rows[0][0]:
            return f"-- no definition stored for {name}"
        parts = [rows[0][0] + ";"]
        if kind == "table":
            parts += [r[0] + ";" for r in await self.fetch_all(None, "SELECT sql FROM sqlite_master WHERE type IN ('index','trigger') AND tbl_name = :n AND sql IS NOT NULL", {"n": name})]
        return "\n\n".join(parts)

    async def get_dashboard(self, database: str | None) -> DashboardData:
        version = (await self.fetch_all(None, "SELECT sqlite_version()"))[0][0]
        page_count, page_size, freelist = (await self.fetch_all(None, "SELECT (SELECT page_count FROM pragma_page_count()), (SELECT page_size FROM pragma_page_size()), (SELECT freelist_count FROM pragma_freelist_count())"))[0]
        journal = (await self.fetch_all(None, "SELECT journal_mode FROM pragma_journal_mode()"))[0][0]
        n_tables = (await self.fetch_all(None, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"))[0][0]
        largest: list[TableSize] = []
        note = None
        try:
            for r in await self.fetch_all(
                None,
                """SELECT m.name, SUM(d.pgsize) FROM dbstat d JOIN sqlite_master m ON m.name = d.name
                   WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' GROUP BY m.name ORDER BY 2 DESC LIMIT 10""",
            ):
                largest.append(TableSize(schema_name=None, name=r[0], total_bytes=r[1]))
        except AdapterError:
            note = "dbstat is not compiled into this SQLite build"
        insights = [
            {"label": "Journal mode", "value": journal},
            {"label": "Page size", "value": page_size, "format": "bytes"},
            {"label": "Free pages", "value": freelist, "note": "Reclaim with VACUUM" if freelist else None, "level": "warn" if freelist > 1000 else "ok"},
        ]
        if note:
            insights.append({"label": "Table sizes", "value": "unavailable", "note": note})
        return DashboardData(
            engine="sqlite", version=f"SQLite {version}", database=self.config.database,
            database_size_bytes=MetricValue(available=True, value=page_count * page_size),
            table_count=MetricValue(available=True, value=n_tables),
            schema_count=MetricValue(available=False, note="SQLite has no schemas"),
            active_connections=MetricValue(available=False, note="SQLite is an embedded engine"),
            largest_tables=largest, largest_indexes=[],
            recent_queries=MetricValue(available=False, note="SQLite does not track query statistics; see Strata query history."),
            insights=insights, latency_ms=0,
        )

    # ---------------------------------------------------------------- DDL

    def ddl_create_table(self, schema: str | None, table: str, op: rq.CreateTableOp) -> list[str]:
        pk = [c for c in op.columns if c.primary_key]
        inline = len(pk) == 1 and pk[0].auto_increment
        lines = []
        for c in op.columns:
            if inline and c is pk[0]:
                lines.append(f"{self.quote(c.name)} INTEGER PRIMARY KEY AUTOINCREMENT")
            else:
                lines.append(self.column_sql(c))
        if pk and not inline:
            lines.append(f"PRIMARY KEY ({', '.join(self.quote(c.name) for c in pk)})")
        ine = "IF NOT EXISTS " if op.if_not_exists else ""
        return [f"CREATE TABLE {ine}{self.quote(table)} (\n  " + ",\n  ".join(lines) + "\n)"]

    def ddl_truncate(self, tbl: str) -> str:
        return f"DELETE FROM {tbl}"

    def ddl_drop_index(self, schema: str | None, table: str, name: str) -> str:
        return f"DROP INDEX {self.quote(name)}"

    def ddl_drop_table(self, tbl: str, op: rq.DropTableOp) -> str:
        return f"DROP {'VIEW' if op.kind == 'view' else 'TABLE'} {tbl}"

    def qualified(self, schema: str | None, name: str) -> str:
        return self.quote(name)
