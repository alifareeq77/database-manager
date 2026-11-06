"""PostgreSQL adapter (asyncpg)."""

from __future__ import annotations

import re
import ssl
from typing import Any

import sqlalchemy as sa
from sqlalchemy.engine import URL
from sqlalchemy.ext.asyncio import AsyncConnection

from app.adapters import requests as rq
from app.adapters.base import AdapterError, DatabaseAdapter, RawType
from app.adapters.sqlutil import category_for_type
from app.adapters.types import (
    CatalogTable, Capabilities, ColumnInfo, ConstraintInfo, DashboardData, DbObject, ForeignKeyInfo,
    IndexInfo, IndexSize, MetricValue, RecentQuery, ResultColumn, SchemaInfo, ServerInfo, TableSize,
    TableStructure, TriggerInfo,
)

SYSTEM_SCHEMAS = ("pg_catalog", "information_schema")
_FK_ACTIONS = {"a": "NO ACTION", "r": "RESTRICT", "c": "CASCADE", "n": "SET NULL", "d": "SET DEFAULT"}
_GUC_NAME = re.compile(r"^[a-z_][a-z0-9_.]*$")

# Common type OIDs, used to label result-set columns of ad-hoc queries.
_OID_TYPES = {
    16: "boolean", 17: "bytea", 18: "char", 19: "name", 20: "bigint", 21: "smallint", 23: "integer",
    25: "text", 26: "oid", 114: "json", 700: "real", 701: "double precision", 790: "money",
    1042: "character", 1043: "character varying", 1082: "date", 1083: "time", 1114: "timestamp",
    1184: "timestamptz", 1186: "interval", 1266: "timetz", 1700: "numeric", 2950: "uuid", 3802: "jsonb",
    1000: "boolean[]", 1005: "smallint[]", 1007: "integer[]", 1016: "bigint[]", 1009: "text[]", 1015: "varchar[]",
    869: "inet", 650: "cidr", 829: "macaddr",
}

_NON_TX = re.compile(
    r"^\s*(vacuum|create\s+database|drop\s+database|alter\s+system|create\s+tablespace|drop\s+tablespace|"
    r"reindex\s+(database|system)|create\s+(unique\s+)?index\s+concurrently|drop\s+index\s+concurrently|"
    r"refresh\s+materialized\s+view\s+concurrently)\b",
    re.I,
)


class PostgresAdapter(DatabaseAdapter):
    engine_name = "postgresql"
    default_port = 5432
    dollar_quotes = True
    capabilities = Capabilities(
        schemas=True, multiple_databases=True, sequences=True, functions=True, procedures=True,
        triggers=True, cancel=True, transactional_ddl=True, alter_column=True, add_constraint=True,
    )

    # ---------------------------------------------------------------- connection

    def resolve_database(self, database: str | None) -> str | None:
        return database or self.config.database or "postgres"

    def build_url(self, database: str | None) -> URL:
        c = self.config
        return URL.create(
            "postgresql+asyncpg", username=c.username, password=c.password, host=c.host or "localhost",
            port=c.port or self.default_port, database=database,
        )

    def _ssl(self) -> Any:
        mode = self.config.ssl_mode
        if mode in ("disable", "allow", "prefer", "require") and not self.config.ssl_ca:
            return mode
        if mode == "disable":
            return "disable"
        ctx = ssl.create_default_context(cadata=self.config.ssl_ca) if self.config.ssl_ca else ssl.create_default_context()
        if mode in ("require", "prefer", "allow"):
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        elif mode == "verify-ca":
            ctx.check_hostname = False
        return ctx

    def connect_args(self, database: str | None) -> dict[str, Any]:
        server_settings: dict[str, str] = {"application_name": "strata"}
        for k, v in (self.config.params or {}).items():
            if not _GUC_NAME.match(str(k)):
                raise AdapterError(f"Invalid connection parameter name: {k}")
            server_settings[str(k)] = str(v)
        if self.config.read_only:
            server_settings["default_transaction_read_only"] = "on"
        return {"ssl": self._ssl(), "timeout": 10, "server_settings": server_settings, "command_timeout": None}

    async def server_info(self, conn: AsyncConnection) -> ServerInfo:
        row = (await conn.execute(sa.text("SELECT current_setting('server_version'), current_database(), current_user"))).one()
        return ServerInfo(engine="postgresql", version=f"PostgreSQL {row[0]}", current_database=row[1], current_user=row[2], latency_ms=0)

    async def prepare_session(self, conn: AsyncConnection, timeout_s: int) -> None:
        await conn.exec_driver_sql(f"SET statement_timeout = {int(timeout_s) * 1000}")

    async def backend_handle(self, conn: AsyncConnection) -> int:
        return int((await conn.exec_driver_sql("SELECT pg_backend_pid()")).scalar())

    async def cancel_backend(self, database: str | None, handle: Any) -> bool:
        if not handle:
            return False
        try:
            async with self.engine_for(database).connect() as conn:
                return bool((await conn.execute(sa.text("SELECT pg_cancel_backend(:pid)"), {"pid": int(handle)})).scalar())
        except Exception:
            return False

    def needs_autocommit(self, stmt: str) -> bool:
        return bool(_NON_TX.match(stmt))

    def result_column(self, name: str, cursor_desc: Any) -> ResultColumn:
        type_name = _OID_TYPES.get(cursor_desc[1]) if cursor_desc else None
        return ResultColumn(name=name, data_type=type_name, category=category_for_type(type_name) if type_name else "other")  # type: ignore[arg-type]

    # ---------------------------------------------------------------- value binding

    def bind_value(self, value: Any, col: ColumnInfo) -> sa.ColumnElement[Any]:
        # asyncpg is strict about parameter types; send text and let PostgreSQL cast to the column type.
        if value is None:
            return sa.null()
        if isinstance(value, bool):
            text = "true" if value else "false"
        elif isinstance(value, (dict, list)):
            import json

            text = json.dumps(value) if col.category == "json" else _pg_array_literal(value) if col.category == "array" else json.dumps(value)
        else:
            text = str(value)
        return sa.cast(sa.literal(text, sa.String), RawType(col.data_type))

    # ---------------------------------------------------------------- introspection

    async def list_databases(self) -> list[SchemaInfo]:
        rows = await self.fetch_all(
            None,
            "SELECT datname FROM pg_database WHERE NOT datistemplate AND has_database_privilege(datname, 'CONNECT') ORDER BY datname",
        )
        return [SchemaInfo(name=r[0], is_system=r[0] == "postgres") for r in rows]

    async def list_schemas(self, database: str | None) -> list[SchemaInfo]:
        rows = await self.fetch_all(
            database,
            "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp%' "
            "ORDER BY nspname IN ('pg_catalog','information_schema'), nspname",
        )
        return [SchemaInfo(name=r[0], is_system=r[0] in SYSTEM_SCHEMAS) for r in rows]

    async def list_objects(self, database: str | None, schema: str | None) -> list[DbObject]:
        schema = schema or "public"
        rels = await self.fetch_all(
            database,
            """SELECT c.relname, c.relkind::text, obj_description(c.oid, 'pg_class'), c.reltuples::bigint
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = :s AND c.relkind IN ('r','p','v','m','f','S') ORDER BY c.relname""",
            {"s": schema},
        )
        kinds = {"r": "table", "p": "table", "f": "table", "v": "view", "m": "materialized_view", "S": "sequence"}
        out = [
            DbObject(name=r[0], kind=kinds[r[1]], schema_name=schema, comment=r[2],
                     row_estimate=r[3] if r[1] in ("r", "p", "m") and r[3] is not None and r[3] >= 0 else None,
                     extra={"partitioned": r[1] == "p", "foreign": r[1] == "f"})
            for r in rels
        ]
        procs = await self.fetch_all(
            database,
            """SELECT p.proname, p.prokind::text, pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid)
               FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = :s AND p.prokind IN ('f','p')
                 AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
               ORDER BY p.proname""",
            {"s": schema},
        )
        out += [
            DbObject(name=r[0], kind="procedure" if r[1] == "p" else "function", schema_name=schema,
                     extra={"arguments": r[2], "returns": r[3]})
            for r in procs
        ]
        trig = await self.fetch_all(
            database,
            """SELECT t.tgname, c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = :s AND NOT t.tgisinternal ORDER BY t.tgname""",
            {"s": schema},
        )
        out += [DbObject(name=r[0], kind="trigger", schema_name=schema, extra={"table": r[1]}) for r in trig]
        return out

    async def _relation(self, database: str | None, schema: str | None, table: str) -> sa.Row[Any]:
        rows = await self.fetch_all(
            database,
            """SELECT c.oid, c.relkind::text, obj_description(c.oid, 'pg_class'), c.reltuples::bigint,
                      CASE WHEN c.relkind IN ('r','p','m') THEN pg_total_relation_size(c.oid) END
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = :s AND c.relname = :t""",
            {"s": schema or "public", "t": table},
        )
        if not rows:
            raise AdapterError(f"Relation not found: {schema or 'public'}.{table}")
        return rows[0]

    async def get_columns(self, database: str | None, schema: str | None, table: str) -> list[ColumnInfo]:
        rows = await self.fetch_all(
            database,
            """SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
                      pg_get_expr(d.adbin, d.adrelid), NULLIF(a.attidentity::text, ''), col_description(a.attrelid, a.attnum),
                      a.attnum, t.typcategory::text,
                      EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
               FROM pg_attribute a
               JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
               JOIN pg_type t ON t.oid = a.atttypid
               LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
               WHERE n.nspname = :s AND c.relname = :t AND a.attnum > 0 AND NOT a.attisdropped
               ORDER BY a.attnum""",
            {"s": schema or "public", "t": table},
        )
        cols = []
        for r in rows:
            cat = category_for_type(r[1])
            if cat == "other":
                cat = {"A": "array", "E": "text", "B": "boolean", "N": "decimal", "S": "text", "D": "datetime"}.get(r[7], "other")
            cols.append(ColumnInfo(
                name=r[0], data_type=r[1], category=cat, nullable=r[2], default=r[3],
                is_auto_increment=bool(r[4]) or (r[3] or "").startswith("nextval("),
                comment=r[5], ordinal=r[6], is_primary_key=r[8],
            ))
        return cols

    async def estimate_rows(self, conn: AsyncConnection, schema: str | None, table: str) -> int | None:
        res = await conn.execute(
            sa.text("SELECT c.reltuples::bigint FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=:s AND c.relname=:t"),
            {"s": schema or "public", "t": table},
        )
        v = res.scalar()
        return int(v) if v is not None and v >= 0 else None

    async def get_table_structure(self, database: str | None, schema: str | None, table: str) -> TableStructure:
        schema = schema or "public"
        rel = await self._relation(database, schema, table)
        oid = int(rel[0])
        kind = {"r": "table", "p": "table", "f": "table", "v": "view", "m": "materialized_view"}.get(rel[1], "table")
        columns = await self.get_columns(database, schema, table)

        idx_rows = await self.fetch_all(
            database,
            """SELECT ic.relname, i.indisunique, i.indisprimary, am.amname, pg_get_indexdef(i.indexrelid),
                      pg_relation_size(i.indexrelid),
                      ARRAY(SELECT pg_get_indexdef(i.indexrelid, k, true) FROM generate_series(1, i.indnkeyatts) k)
               FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_am am ON am.oid = ic.relam
               WHERE i.indrelid = :oid ORDER BY i.indisprimary DESC, ic.relname""",
            {"oid": oid},
        )
        indexes = [IndexInfo(name=r[0], unique=r[1], primary=r[2], method=r[3], definition=r[4], size_bytes=r[5], columns=list(r[6])) for r in idx_rows]

        con_rows = await self.fetch_all(
            database,
            """SELECT con.conname, con.contype::text, pg_get_constraintdef(con.oid, true),
                      ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, ord)
                            JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.ord),
                      rn.nspname, rc.relname,
                      ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, ord)
                            JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.ord),
                      con.confupdtype::text, con.confdeltype::text
               FROM pg_constraint con
               LEFT JOIN pg_class rc ON rc.oid = con.confrelid LEFT JOIN pg_namespace rn ON rn.oid = rc.relnamespace
               WHERE con.conrelid = :oid ORDER BY con.contype, con.conname""",
            {"oid": oid},
        )
        constraints: list[ConstraintInfo] = []
        fks: list[ForeignKeyInfo] = []
        ctype = {"p": "primary_key", "u": "unique", "c": "check", "f": "foreign_key"}
        for r in con_rows:
            if r[1] not in ctype:
                continue
            constraints.append(ConstraintInfo(name=r[0], type=ctype[r[1]], columns=list(r[3] or []), definition=r[2]))  # type: ignore[arg-type]
            if r[1] == "f":
                fks.append(ForeignKeyInfo(name=r[0], columns=list(r[3]), ref_schema=r[4], ref_table=r[5], ref_columns=list(r[6]),
                                          on_update=_FK_ACTIONS.get(r[7]), on_delete=_FK_ACTIONS.get(r[8])))

        ref_rows = await self.fetch_all(
            database,
            """SELECT con.conname, sn.nspname, sc.relname,
                      ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, ord)
                            JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.ord),
                      ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, ord)
                            JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.ord),
                      con.confupdtype::text, con.confdeltype::text
               FROM pg_constraint con JOIN pg_class sc ON sc.oid = con.conrelid JOIN pg_namespace sn ON sn.oid = sc.relnamespace
               WHERE con.confrelid = :oid AND con.contype = 'f' ORDER BY sc.relname""",
            {"oid": oid},
        )
        referenced_by = [ForeignKeyInfo(name=r[0], ref_schema=r[1], ref_table=r[2], columns=list(r[4]), ref_columns=list(r[3]),
                                        on_update=_FK_ACTIONS.get(r[5]), on_delete=_FK_ACTIONS.get(r[6])) for r in ref_rows]

        trg_rows = await self.fetch_all(
            database,
            "SELECT tgname, pg_get_triggerdef(oid, true) FROM pg_trigger WHERE tgrelid = :oid AND NOT tgisinternal ORDER BY tgname",
            {"oid": oid},
        )
        triggers = []
        for r in trg_rows:
            m = re.search(r"\b(BEFORE|AFTER|INSTEAD OF)\s+(.+?)\s+ON\s", r[1] or "", re.I)
            triggers.append(TriggerInfo(name=r[0], definition=r[1], timing=m.group(1) if m else None, event=m.group(2) if m else None))

        view_def = None
        if kind in ("view", "materialized_view"):
            view_def = (await self.fetch_all(database, "SELECT pg_get_viewdef(:oid, true)", {"oid": oid}))[0][0]

        return TableStructure(
            schema_name=schema, name=table, kind=kind, columns=columns,  # type: ignore[arg-type]
            primary_key=[c.name for c in columns if c.is_primary_key], indexes=indexes, foreign_keys=fks,
            constraints=constraints, triggers=triggers, referenced_by=referenced_by, comment=rel[2],
            row_estimate=int(rel[3]) if rel[3] is not None and rel[3] >= 0 else None, total_size_bytes=rel[4],
            view_definition=view_def,
        )

    async def get_catalog(self, database: str | None) -> list[CatalogTable]:
        rows = await self.fetch_all(
            database,
            """SELECT n.nspname, c.relname, c.relkind::text,
                      COALESCE(json_agg(json_build_array(a.attname, format_type(a.atttypid, a.atttypmod)) ORDER BY a.attnum)
                               FILTER (WHERE a.attnum IS NOT NULL), '[]')
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
               WHERE c.relkind IN ('r','p','v','m','f')
                 AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
               GROUP BY n.nspname, c.relname, c.relkind ORDER BY n.nspname, c.relname LIMIT 5000""",
        )
        import json

        out = []
        for r in rows:
            cols = r[3] if isinstance(r[3], list) else json.loads(r[3])
            out.append(CatalogTable(schema_name=r[0], name=r[1], kind="view" if r[2] in ("v", "m") else "table",
                                    columns=[(c[0], c[1]) for c in cols]))
        return out

    async def get_ddl(self, database: str | None, schema: str | None, name: str, kind: str) -> str:
        schema = schema or "public"
        if kind in ("view", "materialized_view"):
            s = await self.get_table_structure(database, schema, name)
            mat = "MATERIALIZED " if kind == "materialized_view" else ""
            return f"CREATE {mat}VIEW {self.qualified(schema, name)} AS\n{(s.view_definition or '').rstrip()}"
        if kind in ("function", "procedure"):
            rows = await self.fetch_all(
                database,
                "SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=:s AND p.proname=:n",
                {"s": schema, "n": name},
            )
            return "\n\n".join(r[0] for r in rows) or f"-- {kind} not found"
        if kind == "sequence":
            rows = await self.fetch_all(
                database,
                "SELECT data_type, start_value, increment, minimum_value, maximum_value, cycle_option FROM information_schema.sequences WHERE sequence_schema=:s AND sequence_name=:n",
                {"s": schema, "n": name},
            )
            if not rows:
                return "-- sequence not found"
            r = rows[0]
            return (f"CREATE SEQUENCE {self.qualified(schema, name)} AS {r[0]}\n  START WITH {r[1]}\n  INCREMENT BY {r[2]}\n"
                    f"  MINVALUE {r[3]}\n  MAXVALUE {r[4]}\n  {'CYCLE' if r[5] == 'YES' else 'NO CYCLE'};")
        if kind == "trigger":
            rows = await self.fetch_all(
                database,
                "SELECT pg_get_triggerdef(t.oid, true) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=:s AND t.tgname=:n",
                {"s": schema, "n": name},
            )
            return (rows[0][0] + ";") if rows else "-- trigger not found"
        s = await self.get_table_structure(database, schema, name)
        lines = []
        for c in s.columns:
            line = f"  {self.quote(c.name)} {c.data_type}"
            if c.default is not None:
                line += f" DEFAULT {c.default}"
            if not c.nullable:
                line += " NOT NULL"
            lines.append(line)
        for con in s.constraints:
            lines.append(f"  CONSTRAINT {self.quote(con.name)} {con.definition}")
        out = [f"CREATE TABLE {self.qualified(schema, name)} (\n" + ",\n".join(lines) + "\n);"]
        for idx in s.indexes:
            if not idx.primary and not any(con.name == idx.name for con in s.constraints):
                out.append(f"{idx.definition};")
        for t in s.triggers:
            out.append(f"{t.definition};")
        if s.comment:
            out.append(f"COMMENT ON TABLE {self.qualified(schema, name)} IS '{s.comment.replace(chr(39), chr(39) * 2)}';")
        return "\n\n".join(out)

    async def get_dashboard(self, database: str | None) -> DashboardData:
        db = self.resolve_database(database)
        base = await self.fetch_all(
            db,
            """SELECT current_setting('server_version'), current_database(), pg_database_size(current_database()),
                      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                        WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'),
                      (SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema')
                         AND nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp%'),
                      (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()),
                      (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'active'),
                      current_setting('max_connections')::int,
                      now() - pg_postmaster_start_time()""",
        )
        r = base[0]
        tables = await self.fetch_all(
            db,
            """SELECT n.nspname, c.relname, pg_total_relation_size(c.oid), pg_relation_size(c.oid), pg_indexes_size(c.oid), c.reltuples::bigint
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE c.relkind IN ('r','p','m') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
               ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 10""",
        )
        idx = await self.fetch_all(
            db,
            """SELECT n.nspname, t.relname, ic.relname, pg_relation_size(ic.oid)
               FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
               JOIN pg_namespace n ON n.oid = t.relnamespace
               WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
               ORDER BY pg_relation_size(ic.oid) DESC LIMIT 10""",
        )
        stats = (await self.fetch_all(
            db,
            """SELECT blks_hit, blks_read, xact_commit, xact_rollback, deadlocks, temp_bytes, tup_returned, tup_fetched,
                      (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND now() - query_start > interval '1 minute'),
                      (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock')
               FROM pg_stat_database WHERE datname = current_database()""",
        ))[0]
        hit_ratio = (stats[0] / (stats[0] + stats[1]) * 100) if (stats[0] + stats[1]) else None
        insights = [
            {"label": "Cache hit ratio", "value": f"{hit_ratio:.2f}%" if hit_ratio is not None else "n/a",
             "note": "Share of block reads served from shared buffers", "level": "warn" if hit_ratio is not None and hit_ratio < 95 else "ok"},
            {"label": "Commits / rollbacks", "value": f"{stats[2]:,} / {stats[3]:,}"},
            {"label": "Deadlocks", "value": f"{stats[4]:,}", "level": "warn" if stats[4] else "ok"},
            {"label": "Temp bytes written", "value": stats[5], "format": "bytes"},
            {"label": "Long-running queries (>1m)", "value": stats[8], "level": "warn" if stats[8] else "ok"},
            {"label": "Sessions waiting on locks", "value": stats[9], "level": "warn" if stats[9] else "ok"},
            {"label": "Server uptime", "value": str(r[8]).split(".")[0]},
            {"label": "Max connections", "value": r[7]},
        ]
        dead = await self.fetch_all(
            db,
            "SELECT schemaname, relname, n_dead_tup, n_live_tup FROM pg_stat_user_tables WHERE n_dead_tup > 1000 ORDER BY n_dead_tup DESC LIMIT 5",
        )
        for d in dead:
            insights.append({"label": f"Dead tuples in {d[0]}.{d[1]}", "value": f"{d[2]:,}", "note": f"{d[3]:,} live rows; consider VACUUM", "level": "warn"})

        recent = MetricValue(available=False, note="Install the pg_stat_statements extension to see query statistics.")
        has_pgss = await self.fetch_all(db, "SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'")
        if has_pgss:
            try:
                rq_rows = await self.fetch_all(
                    db,
                    """SELECT query, calls, total_exec_time, mean_exec_time, rows FROM pg_stat_statements
                       WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
                       ORDER BY total_exec_time DESC LIMIT 10""",
                )
                recent = MetricValue(available=True, value=[RecentQuery(query=q[0], calls=q[1], total_ms=q[2], mean_ms=q[3], rows=q[4]).model_dump() for q in rq_rows])
            except AdapterError as exc:
                recent = MetricValue(available=False, note=str(exc))

        return DashboardData(
            engine="postgresql", version=f"PostgreSQL {r[0]}", database=r[1],
            database_size_bytes=MetricValue(available=True, value=r[2]),
            table_count=MetricValue(available=True, value=r[3]),
            schema_count=MetricValue(available=True, value=r[4]),
            active_connections=MetricValue(available=True, value=r[5], note=f"{r[6]} executing, max {r[7]}"),
            largest_tables=[TableSize(schema_name=t[0], name=t[1], total_bytes=t[2], table_bytes=t[3], index_bytes=t[4], row_estimate=t[5] if t[5] >= 0 else None) for t in tables],
            largest_indexes=[IndexSize(schema_name=i[0], table=i[1], name=i[2], size_bytes=i[3]) for i in idx],
            recent_queries=recent, insights=insights, latency_ms=0,
        )

    # ---------------------------------------------------------------- DDL

    def ddl_create_table(self, schema: str | None, table: str, op: rq.CreateTableOp) -> list[str]:
        pk = [c.name for c in op.columns if c.primary_key]
        lines = []
        for c in op.columns:
            line = self.column_sql(c)
            if c.auto_increment:
                line = line.replace(" NOT NULL", "") + " GENERATED BY DEFAULT AS IDENTITY"
            lines.append(line)
        if pk:
            lines.append(f"PRIMARY KEY ({', '.join(self.quote(c) for c in pk)})")
        ine = "IF NOT EXISTS " if op.if_not_exists else ""
        stmts = [f"CREATE TABLE {ine}{self.qualified(schema, table)} (\n  " + ",\n  ".join(lines) + "\n)"]
        for c in op.columns:
            if c.comment:
                stmts.append(f"COMMENT ON COLUMN {self.qualified(schema, table)}.{self.quote(c.name)} IS '{c.comment.replace(chr(39), chr(39) * 2)}'")
        return stmts

    def ddl_alter_column(self, tbl: str, op: rq.AlterColumnOp, current: ColumnInfo | None) -> list[str]:
        col = self.quote(op.column)
        out = []
        if op.type:
            t = self.column_type(rq.ColumnDef(name=op.column, type=op.type))
            out.append(f"ALTER TABLE {tbl} ALTER COLUMN {col} TYPE {t} USING {col}::{t}")
        if op.nullable is not None:
            out.append(f"ALTER TABLE {tbl} ALTER COLUMN {col} {'DROP' if op.nullable else 'SET'} NOT NULL")
        if op.drop_default:
            out.append(f"ALTER TABLE {tbl} ALTER COLUMN {col} DROP DEFAULT")
        elif op.default not in (None, ""):
            out.append(f"ALTER TABLE {tbl} ALTER COLUMN {col} SET DEFAULT {op.default}")
        return out

    def ddl_drop_table(self, tbl: str, op: rq.DropTableOp) -> str:
        return super().ddl_drop_table(tbl, op)


def _pg_array_literal(values: list[Any]) -> str:
    def item(v: Any) -> str:
        if v is None:
            return "NULL"
        if isinstance(v, list):
            return _pg_array_literal(v)
        s = str(v).replace("\\", "\\\\").replace('"', '\\"')
        return f'"{s}"'

    return "{" + ",".join(item(v) for v in values) + "}"
