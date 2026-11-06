"""MySQL / MariaDB adapter (aiomysql).

MySQL has no schema level below the database, so ``schema`` arguments are ignored and objects are
addressed by database + name.
"""

from __future__ import annotations

import ssl
from typing import Any

import sqlalchemy as sa
from sqlalchemy.engine import URL
from sqlalchemy.ext.asyncio import AsyncConnection

from app.adapters import requests as rq
from app.adapters.base import AdapterError, DatabaseAdapter
from app.adapters.sqlutil import category_for_type
from app.adapters.types import (
    CatalogTable, Capabilities, ColumnInfo, ConstraintInfo, DashboardData, DbObject, ForeignKeyInfo,
    IndexInfo, IndexSize, MetricValue, RecentQuery, ResultColumn, SchemaInfo, ServerInfo, TableSize,
    TableStructure, TriggerInfo,
)

SYSTEM_DBS = {"information_schema", "mysql", "performance_schema", "sys"}
_ALLOWED_PARAMS = {"charset", "connect_timeout", "sql_mode", "time_zone"}

# pymysql FIELD_TYPE codes -> type name
_FIELD_TYPES = {
    0: "decimal", 1: "tinyint", 2: "smallint", 3: "int", 4: "float", 5: "double", 7: "timestamp", 8: "bigint",
    9: "mediumint", 10: "date", 11: "time", 12: "datetime", 13: "year", 15: "varchar", 16: "bit", 245: "json",
    246: "decimal", 247: "enum", 248: "set", 249: "tinyblob", 250: "mediumblob", 251: "longblob", 252: "blob",
    253: "varchar", 254: "char",
}


class MySQLAdapter(DatabaseAdapter):
    engine_name = "mysql"
    default_port = 3306
    identifier_quote = "`"
    capabilities = Capabilities(
        schemas=False, multiple_databases=True, sequences=False, functions=True, procedures=True,
        triggers=True, cancel=True, transactional_ddl=False, alter_column=True, add_constraint=True,
    )

    def build_url(self, database: str | None) -> URL:
        c = self.config
        return URL.create(
            "mysql+aiomysql", username=c.username, password=c.password, host=c.host or "localhost",
            port=c.port or self.default_port, database=database or None,
        )

    def connect_args(self, database: str | None) -> dict[str, Any]:
        args: dict[str, Any] = {"connect_timeout": 10, "local_infile": False, "charset": "utf8mb4"}
        for k, v in (self.config.params or {}).items():
            if k not in _ALLOWED_PARAMS:
                raise AdapterError(f"Unsupported MySQL connection parameter: {k} (allowed: {', '.join(sorted(_ALLOWED_PARAMS))})")
            if k in ("sql_mode", "time_zone"):
                continue
            args[k] = int(v) if k == "connect_timeout" else str(v)
        init = []
        if self.config.read_only:
            init.append("SET SESSION TRANSACTION READ ONLY")
        if "sql_mode" in self.config.params:
            init.append("SET SESSION sql_mode = " + _mysql_literal(str(self.config.params["sql_mode"])))
        if "time_zone" in self.config.params:
            init.append("SET SESSION time_zone = " + _mysql_literal(str(self.config.params["time_zone"])))
        if init:
            args["init_command"] = "; ".join(init)
            args["client_flag"] = 1 << 16  # CLIENT.MULTI_STATEMENTS for the init command only
        mode = self.config.ssl_mode
        if mode in ("require", "verify-ca", "verify-full"):
            ctx = ssl.create_default_context(cadata=self.config.ssl_ca) if self.config.ssl_ca else ssl.create_default_context()
            if mode == "require":
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
            elif mode == "verify-ca":
                ctx.check_hostname = False
            args["ssl"] = ctx
        return args

    def _attach_events(self, engine: Any) -> None:
        pass

    def default_isolation(self) -> str:
        return "REPEATABLE READ"

    async def server_info(self, conn: AsyncConnection) -> ServerInfo:
        row = (await conn.execute(sa.text("SELECT VERSION(), DATABASE(), CURRENT_USER()"))).one()
        flavour = "MariaDB" if "mariadb" in row[0].lower() else "MySQL"
        return ServerInfo(engine="mysql", version=f"{flavour} {row[0]}", current_database=row[1], current_user=row[2], latency_ms=0)

    async def prepare_session(self, conn: AsyncConnection, timeout_s: int) -> None:
        try:
            await conn.exec_driver_sql(f"SET SESSION max_execution_time = {int(timeout_s) * 1000}")
        except Exception:  # MariaDB uses max_statement_time (seconds)
            await conn.rollback()
            await conn.exec_driver_sql(f"SET SESSION max_statement_time = {int(timeout_s)}")

    async def backend_handle(self, conn: AsyncConnection) -> int:
        return int((await conn.exec_driver_sql("SELECT CONNECTION_ID()")).scalar())

    async def cancel_backend(self, database: str | None, handle: Any) -> bool:
        if not handle:
            return False
        try:
            async with self.engine_for(database).connect() as conn:
                await conn.exec_driver_sql(f"KILL QUERY {int(handle)}")
            return True
        except Exception:
            return False

    def result_column(self, name: str, cursor_desc: Any) -> ResultColumn:
        type_name = _FIELD_TYPES.get(cursor_desc[1]) if cursor_desc else None
        return ResultColumn(name=name, data_type=type_name, category=category_for_type(type_name) if type_name else "other")  # type: ignore[arg-type]

    def as_text(self, col: sa.ColumnElement[Any]) -> sa.ColumnElement[Any]:
        return sa.cast(col, sa.String().with_variant(sa.CHAR(), "mysql"))

    def insert_default_values(self, t: sa.TableClause) -> sa.Executable:
        return sa.text(f"INSERT INTO {self.qualified(t.schema, t.name)} () VALUES ()")

    # ---------------------------------------------------------------- introspection

    def _db(self, database: str | None) -> str:
        db = self.resolve_database(database)
        if not db:
            raise AdapterError("Select a database first.")
        return db

    async def list_databases(self) -> list[SchemaInfo]:
        rows = await self.fetch_all(None, "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME")
        return [SchemaInfo(name=r[0], is_system=r[0] in SYSTEM_DBS) for r in rows]

    async def list_schemas(self, database: str | None) -> list[SchemaInfo]:
        return []

    async def list_objects(self, database: str | None, schema: str | None) -> list[DbObject]:
        db = self._db(database)
        rows = await self.fetch_all(
            db,
            "SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = :db ORDER BY TABLE_NAME",
            {"db": db},
        )
        out = [DbObject(name=r[0], kind="view" if r[1] == "VIEW" else "table", comment=r[2] or None,
                        row_estimate=r[3] if r[1] != "VIEW" else None) for r in rows]
        routines = await self.fetch_all(
            db,
            "SELECT ROUTINE_NAME, ROUTINE_TYPE, DTD_IDENTIFIER FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = :db ORDER BY ROUTINE_NAME",
            {"db": db},
        )
        out += [DbObject(name=r[0], kind="procedure" if r[1] == "PROCEDURE" else "function", extra={"returns": r[2]}) for r in routines]
        trig = await self.fetch_all(
            db,
            "SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = :db ORDER BY TRIGGER_NAME",
            {"db": db},
        )
        out += [DbObject(name=r[0], kind="trigger", extra={"table": r[1]}) for r in trig]
        return out

    async def get_columns(self, database: str | None, schema: str | None, table: str) -> list[ColumnInfo]:
        db = self._db(database)
        rows = await self.fetch_all(
            db,
            """SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT, ORDINAL_POSITION
               FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = :db AND TABLE_NAME = :t ORDER BY ORDINAL_POSITION""",
            {"db": db, "t": table},
        )
        return [
            ColumnInfo(name=r[0], data_type=r[1], category=category_for_type(r[1]), nullable=r[2] == "YES", default=r[3],  # type: ignore[arg-type]
                       is_primary_key=r[4] == "PRI", is_auto_increment="auto_increment" in (r[5] or ""),
                       comment=r[6] or None, ordinal=r[7])
            for r in rows
        ]

    async def estimate_rows(self, conn: AsyncConnection, schema: str | None, table: str) -> int | None:
        res = await conn.execute(
            sa.text("SELECT TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t"), {"t": table}
        )
        v = res.scalar()
        return int(v) if v is not None else None

    async def get_table_structure(self, database: str | None, schema: str | None, table: str) -> TableStructure:
        db = self._db(database)
        meta = await self.fetch_all(
            db,
            "SELECT TABLE_TYPE, TABLE_COMMENT, TABLE_ROWS, DATA_LENGTH + INDEX_LENGTH FROM information_schema.TABLES WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:t",
            {"db": db, "t": table},
        )
        if not meta:
            raise AdapterError(f"Table not found: {table}")
        is_view = meta[0][0] == "VIEW"
        columns = await self.get_columns(db, None, table)
        idx_rows = await self.fetch_all(
            db,
            """SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, INDEX_TYPE, SEQ_IN_INDEX FROM information_schema.STATISTICS
               WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:t ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX""",
            {"db": db, "t": table},
        )
        sizes: dict[str, int] = {}
        try:
            for r in await self.fetch_all(
                db,
                """SELECT index_name, stat_value * @@innodb_page_size FROM mysql.innodb_index_stats
                   WHERE database_name=:db AND table_name=:t AND stat_name='size'""",
                {"db": db, "t": table},
            ):
                sizes[r[0]] = int(r[1])
        except AdapterError:
            pass  # no privilege on mysql.* — sizes stay unknown
        idx_map: dict[str, IndexInfo] = {}
        for r in idx_rows:
            ix = idx_map.get(r[0])
            if ix is None:
                ix = idx_map[r[0]] = IndexInfo(name=r[0], columns=[], unique=not r[1], primary=r[0] == "PRIMARY",
                                               method=r[3], size_bytes=sizes.get(r[0]))
            ix.columns.append(r[2] or "(expression)")

        fk_rows = await self.fetch_all(
            db,
            """SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
                      r.UPDATE_RULE, r.DELETE_RULE
               FROM information_schema.KEY_COLUMN_USAGE k
               JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
               WHERE k.TABLE_SCHEMA=:db AND k.TABLE_NAME=:t AND k.REFERENCED_TABLE_NAME IS NOT NULL
               ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION""",
            {"db": db, "t": table},
        )
        fks = _group_fks(fk_rows)
        ref_rows = await self.fetch_all(
            db,
            """SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.TABLE_SCHEMA, k.TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE
               FROM information_schema.KEY_COLUMN_USAGE k
               JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
               WHERE k.REFERENCED_TABLE_SCHEMA=:db AND k.REFERENCED_TABLE_NAME=:t ORDER BY k.TABLE_NAME, k.ORDINAL_POSITION""",
            {"db": db, "t": table},
        )
        # For referenced_by, `columns` are the referenced (this table's) columns and ref_columns the referencing ones.
        referenced_by = [ForeignKeyInfo(name=f.name, columns=f.ref_columns, ref_schema=f.ref_schema, ref_table=f.ref_table,
                                        ref_columns=f.columns, on_update=f.on_update, on_delete=f.on_delete) for f in _group_fks(ref_rows)]

        constraints: list[ConstraintInfo] = []
        tc = await self.fetch_all(
            db,
            "SELECT CONSTRAINT_NAME, CONSTRAINT_TYPE FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:t",
            {"db": db, "t": table},
        )
        checks: dict[str, str] = {}
        try:
            for r in await self.fetch_all(
                db,
                """SELECT cc.CONSTRAINT_NAME, cc.CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS cc
                   JOIN information_schema.TABLE_CONSTRAINTS t ON t.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA AND t.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
                   WHERE t.TABLE_SCHEMA=:db AND t.TABLE_NAME=:t""",
                {"db": db, "t": table},
            ):
                checks[r[0]] = r[1]
        except AdapterError:
            pass  # MySQL < 8.0.16
        type_map = {"PRIMARY KEY": "primary_key", "UNIQUE": "unique", "FOREIGN KEY": "foreign_key", "CHECK": "check"}
        for r in tc:
            ctype = type_map.get(r[1])
            if not ctype:
                continue
            cols: list[str] = []
            definition = None
            if ctype in ("primary_key", "unique"):
                ix = idx_map.get("PRIMARY" if ctype == "primary_key" else r[0])
                cols = ix.columns if ix else []
                definition = f"{r[1]} ({', '.join(cols)})"
            elif ctype == "foreign_key":
                fk = next((f for f in fks if f.name == r[0]), None)
                if fk:
                    cols = fk.columns
                    definition = f"FOREIGN KEY ({', '.join(fk.columns)}) REFERENCES {fk.ref_table} ({', '.join(fk.ref_columns)})"
            else:
                definition = f"CHECK ({checks.get(r[0], '?')})"
            constraints.append(ConstraintInfo(name=r[0], type=ctype, columns=cols, definition=definition))  # type: ignore[arg-type]

        trg = await self.fetch_all(
            db,
            """SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT FROM information_schema.TRIGGERS
               WHERE EVENT_OBJECT_SCHEMA=:db AND EVENT_OBJECT_TABLE=:t ORDER BY TRIGGER_NAME""",
            {"db": db, "t": table},
        )
        view_def = None
        if is_view:
            v = await self.fetch_all(db, "SELECT VIEW_DEFINITION FROM information_schema.VIEWS WHERE TABLE_SCHEMA=:db AND TABLE_NAME=:t", {"db": db, "t": table})
            view_def = v[0][0] if v else None
        return TableStructure(
            schema_name=None, name=table, kind="view" if is_view else "table", columns=columns,
            primary_key=[c.name for c in columns if c.is_primary_key], indexes=list(idx_map.values()), foreign_keys=fks,
            constraints=constraints, referenced_by=referenced_by,
            triggers=[TriggerInfo(name=r[0], timing=r[1], event=r[2], definition=r[3]) for r in trg],
            comment=meta[0][1] or None, row_estimate=meta[0][2], total_size_bytes=meta[0][3], view_definition=view_def,
        )

    async def get_catalog(self, database: str | None) -> list[CatalogTable]:
        db = self._db(database)
        rows = await self.fetch_all(
            db,
            """SELECT c.TABLE_NAME, t.TABLE_TYPE, c.COLUMN_NAME, c.COLUMN_TYPE FROM information_schema.COLUMNS c
               JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
               WHERE c.TABLE_SCHEMA = :db ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION LIMIT 50000""",
            {"db": db},
        )
        tables: dict[str, CatalogTable] = {}
        for r in rows:
            ct = tables.setdefault(r[0], CatalogTable(schema_name=None, name=r[0], kind="view" if r[1] == "VIEW" else "table", columns=[]))
            ct.columns.append((r[2], r[3]))
        return list(tables.values())

    async def get_ddl(self, database: str | None, schema: str | None, name: str, kind: str) -> str:
        db = self._db(database)
        target = self.qualified(db, name)
        stmt = {"view": "SHOW CREATE VIEW", "function": "SHOW CREATE FUNCTION", "procedure": "SHOW CREATE PROCEDURE",
                "trigger": "SHOW CREATE TRIGGER"}.get(kind, "SHOW CREATE TABLE")

        async def go() -> str:
            async with self.engine_for(db).connect() as conn:
                res = await conn.exec_driver_sql(f"{stmt} {target}")
                row = res.one()
                keys = list(res.keys())
                for col in ("Create Table", "Create View", "Create Function", "Create Procedure", "SQL Original Statement"):
                    if col in keys and row[keys.index(col)]:
                        return str(row[keys.index(col)]) + ";"
                return str(row[1]) + ";"

        return await self._run(go())

    async def get_dashboard(self, database: str | None) -> DashboardData:
        db = self.resolve_database(database)
        version = (await self.fetch_all(db, "SELECT VERSION()"))[0][0]
        flavour = "MariaDB" if "mariadb" in version.lower() else "MySQL"
        n_schemas = (await self.fetch_all(db, "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema','mysql','performance_schema','sys')"))[0][0]
        size = tables_n = None
        tables: list[TableSize] = []
        indexes: list[IndexSize] = []
        if db:
            r = (await self.fetch_all(db, "SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH),0), COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=:db AND TABLE_TYPE='BASE TABLE'", {"db": db}))[0]
            size, tables_n = int(r[0]), int(r[1])
            for t in await self.fetch_all(
                db,
                """SELECT TABLE_NAME, DATA_LENGTH + INDEX_LENGTH, DATA_LENGTH, INDEX_LENGTH, TABLE_ROWS FROM information_schema.TABLES
                   WHERE TABLE_SCHEMA=:db AND TABLE_TYPE='BASE TABLE' ORDER BY DATA_LENGTH + INDEX_LENGTH DESC LIMIT 10""",
                {"db": db},
            ):
                tables.append(TableSize(schema_name=None, name=t[0], total_bytes=t[1], table_bytes=t[2], index_bytes=t[3], row_estimate=t[4]))
            try:
                for i in await self.fetch_all(
                    db,
                    """SELECT table_name, index_name, stat_value * @@innodb_page_size FROM mysql.innodb_index_stats
                       WHERE database_name=:db AND stat_name='size' ORDER BY stat_value DESC LIMIT 10""",
                    {"db": db},
                ):
                    indexes.append(IndexSize(schema_name=None, table=i[0], name=i[1], size_bytes=int(i[2])))
            except AdapterError:
                pass
        status = {r[0]: r[1] for r in await self.fetch_all(db, "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running','Uptime','Questions','Slow_queries','Innodb_buffer_pool_read_requests','Innodb_buffer_pool_reads','Aborted_connects')")}
        variables = {r[0]: r[1] for r in await self.fetch_all(db, "SHOW GLOBAL VARIABLES WHERE Variable_name IN ('max_connections','long_query_time')")}
        reqs, reads = int(status.get("Innodb_buffer_pool_read_requests", 0)), int(status.get("Innodb_buffer_pool_reads", 0))
        hit = (1 - reads / reqs) * 100 if reqs else None
        uptime = int(status.get("Uptime", 0))
        insights = [
            {"label": "Buffer pool hit ratio", "value": f"{hit:.2f}%" if hit is not None else "n/a", "level": "warn" if hit is not None and hit < 95 else "ok"},
            {"label": "Slow queries", "value": status.get("Slow_queries", "n/a"), "note": f"long_query_time = {variables.get('long_query_time', '?')}s"},
            {"label": "Queries since start", "value": f"{int(status.get('Questions', 0)):,}"},
            {"label": "Aborted connects", "value": status.get("Aborted_connects", "n/a")},
            {"label": "Server uptime", "value": f"{uptime // 86400}d {uptime % 86400 // 3600}h {uptime % 3600 // 60}m"},
            {"label": "Max connections", "value": variables.get("max_connections", "n/a")},
        ]
        recent = MetricValue(available=False, note="performance_schema digest table is not accessible for this user.")
        try:
            rows = await self.fetch_all(
                db,
                """SELECT DIGEST_TEXT, COUNT_STAR, SUM_TIMER_WAIT / 1e9, AVG_TIMER_WAIT / 1e9, SUM_ROWS_SENT
                   FROM performance_schema.events_statements_summary_by_digest
                   WHERE SCHEMA_NAME = :db AND DIGEST_TEXT IS NOT NULL ORDER BY SUM_TIMER_WAIT DESC LIMIT 10""",
                {"db": db},
            )
            recent = MetricValue(available=True, value=[RecentQuery(query=r[0], calls=r[1], total_ms=float(r[2]), mean_ms=float(r[3]), rows=r[4]).model_dump() for r in rows])
        except AdapterError:
            pass
        return DashboardData(
            engine="mysql", version=f"{flavour} {version}", database=db,
            database_size_bytes=MetricValue(available=size is not None, value=size, note=None if size is not None else "Select a database"),
            table_count=MetricValue(available=tables_n is not None, value=tables_n),
            schema_count=MetricValue(available=True, value=n_schemas, note="databases (MySQL has no separate schemas)"),
            active_connections=MetricValue(available="Threads_connected" in status, value=int(status.get("Threads_connected", 0)),
                                           note=f"{status.get('Threads_running', '?')} running, max {variables.get('max_connections', '?')}"),
            largest_tables=tables, largest_indexes=indexes, recent_queries=recent, insights=insights, latency_ms=0,
        )

    # ---------------------------------------------------------------- DDL

    def column_sql(self, col: rq.ColumnDef, inline_pk: bool = False) -> str:
        s = super().column_sql(col)
        if col.auto_increment:
            s += " AUTO_INCREMENT"
        if col.comment:
            s += " COMMENT " + _mysql_literal(col.comment)
        return s

    def ddl_alter_column(self, tbl: str, op: rq.AlterColumnOp, current: ColumnInfo | None) -> list[str]:
        if current is None:
            raise AdapterError(f"Unknown column: {op.column}")
        coltype = self.column_type(rq.ColumnDef(name=op.column, type=op.type)) if op.type else current.data_type
        nullable = current.nullable if op.nullable is None else op.nullable
        parts = [f"ALTER TABLE {tbl} MODIFY COLUMN {self.quote(op.column)} {coltype}", "NULL" if nullable else "NOT NULL"]
        if not op.drop_default:
            if op.default not in (None, ""):
                parts.append(f"DEFAULT {op.default}")
            elif current.default is not None:
                d = current.default
                is_expr = d.upper().startswith(("CURRENT_TIMESTAMP", "NOW(")) or current.category in ("integer", "float", "decimal")
                parts.append(f"DEFAULT {d if is_expr else _mysql_literal(d)}")
        if current.is_auto_increment:
            parts.append("AUTO_INCREMENT")
        if current.comment:
            parts.append("COMMENT " + _mysql_literal(current.comment))
        return [" ".join(parts)]

    def ddl_rename_table(self, schema: str | None, table: str, new_name: str) -> str:
        return f"RENAME TABLE {self.quote(table)} TO {self.quote(new_name)}"

    def ddl_drop_index(self, schema: str | None, table: str, name: str) -> str:
        return f"DROP INDEX {self.quote(name)} ON {self.quote(table)}"

    def ddl_drop_constraint(self, tbl: str, op: rq.DropConstraintOp) -> str:
        if op.constraint_type == "foreign_key":
            return f"ALTER TABLE {tbl} DROP FOREIGN KEY {self.quote(op.name)}"
        if op.constraint_type == "primary_key":
            return f"ALTER TABLE {tbl} DROP PRIMARY KEY"
        if op.constraint_type == "unique":
            return f"ALTER TABLE {tbl} DROP INDEX {self.quote(op.name)}"
        return f"ALTER TABLE {tbl} DROP CHECK {self.quote(op.name)}"

    def ddl_drop_table(self, tbl: str, op: rq.DropTableOp) -> str:
        return f"DROP {'VIEW' if op.kind == 'view' else 'TABLE'} {tbl}"

    def qualified(self, schema: str | None, name: str) -> str:
        return self.quote(name) if schema is None else f"{self.quote(schema)}.{self.quote(name)}"


def _group_fks(rows: list[Any]) -> list[ForeignKeyInfo]:
    out: dict[str, ForeignKeyInfo] = {}
    for r in rows:
        fk = out.get(r[0])
        if fk is None:
            fk = out[r[0]] = ForeignKeyInfo(name=r[0], columns=[], ref_schema=r[2], ref_table=r[3], ref_columns=[], on_update=r[5], on_delete=r[6])
        fk.columns.append(r[1])
        fk.ref_columns.append(r[4])
    return list(out.values())


def _mysql_literal(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "''") + "'"
