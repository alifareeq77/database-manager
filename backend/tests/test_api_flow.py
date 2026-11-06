"""End-to-end API tests. SQLite always runs; PostgreSQL/MySQL run when the docker-compose
sample databases are reachable (``docker compose up -d postgres mysql``)."""

from __future__ import annotations

import json
import socket
import uuid

import pytest


def _reachable(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


ENGINES = [
    pytest.param({"engine": "sqlite", "database": "flow.db"}, None, id="sqlite"),
    pytest.param(
        {"engine": "postgresql", "host": "127.0.0.1", "port": 54329, "username": "strata", "password": "strata_dev_pw",
         "database": "shop", "ssl_mode": "disable"},
        "public", id="postgresql",
        marks=pytest.mark.skipif(not _reachable(54329), reason="postgres not running"),
    ),
    pytest.param(
        {"engine": "mysql", "host": "127.0.0.1", "port": 33069, "username": "strata", "password": "strata_dev_pw",
         "database": "blog", "ssl_mode": "disable"},
        None, id="mysql",
        marks=pytest.mark.skipif(not _reachable(33069), reason="mysql not running"),
    ),
]


def test_csrf_and_auth_required(client):
    token = client.headers.pop("x-csrf-token")
    try:
        r = client.post("/api/connections", json={"name": "x", "engine": "sqlite", "database": "x.db"})
        assert r.status_code == 403
    finally:
        client.headers["x-csrf-token"] = token
    anon = client.__class__(client.app)
    assert anon.get("/api/connections").status_code == 401


def test_sqlite_path_escape_rejected(client):
    r = client.post("/api/connections", json={"name": "evil", "engine": "sqlite", "database": "../../etc/passwd.db"})
    assert r.status_code == 422


@pytest.mark.parametrize("cfg,schema", ENGINES)
def test_full_flow(client, cfg, schema):
    # --- connection CRUD: password must never be echoed
    r = client.post("/api/connections", json={"name": f"t-{cfg['engine']}", "color": "#22c55e", "group": "tests", **cfg})
    assert r.status_code == 201, r.text
    conn = r.json()
    assert "password" not in conn and conn["has_password"] == ("password" in cfg)
    cid = conn["id"]
    assert cfg.get("password", "zzz-not-there") not in json.dumps(client.get("/api/connections").json())

    r = client.post(f"/api/connections/{cid}/connect")
    assert r.status_code == 200, r.text
    db = cfg.get("database") if cfg["engine"] != "sqlite" else None
    q = f"?database={db}" if db else ""

    table = f"t_{uuid.uuid4().hex[:8]}"
    change = {
        "schema_name": schema, "table": table,
        "operations": [{"op": "create_table", "columns": [
            {"name": "id", "type": "integer", "primary_key": True, "auto_increment": True, "nullable": False},
            {"name": "name", "type": "varchar(100)", "nullable": False},
            {"name": "score", "type": "integer"},
            {"name": "meta", "type": "text"},
        ]}],
    }
    r = client.post(f"/api/connections/{cid}/schema/preview{q}", json=change)
    assert r.status_code == 200, r.text
    stmts = r.json()["statements"]
    assert stmts and "CREATE TABLE" in stmts[0]
    r = client.post(f"/api/connections/{cid}/schema/apply{q}", json={"change": change, "expected_statements": stmts})
    assert r.status_code == 200, r.text

    # --- explorer sees the table
    objs = client.get(f"/api/connections/{cid}/objects", params={k: v for k, v in {"database": db, "schema": schema}.items() if v}).json()
    assert any(o["name"] == table and o["kind"] == "table" for o in objs)
    st = client.get(f"/api/connections/{cid}/structure", params={k: v for k, v in {"database": db, "schema": schema, "table": table}.items() if v}).json()
    assert st["primary_key"] == ["id"] and [c["name"] for c in st["columns"]] == ["id", "name", "score", "meta"]

    # --- CRUD with type coercion (strings for ints exercise PG casting)
    rows = [{"name": "alice", "score": "10"}, {"name": "bob", "score": 20}, {"name": "o'hara; drop", "score": None}]
    r = client.post(f"/api/connections/{cid}/data/insert{q}", json={"schema_name": schema, "table": table, "rows": rows})
    assert r.status_code == 200, r.text
    assert r.json()["affected"] == 3

    req = {"schema_name": schema, "table": table, "page": 1, "page_size": 2, "sort": [{"column": "name", "direction": "asc"}]}
    page = client.post(f"/api/connections/{cid}/data{q}", json=req).json()
    assert page["total"] == 3 and len(page["rows"]) == 2 and page["editable"] is True
    assert page["rows"][0][1] == "alice"

    req_f = {**req, "page_size": 50, "filters": [{"column": "score", "op": "gte", "value": "15"}]}
    page = client.post(f"/api/connections/{cid}/data{q}", json=req_f).json()
    assert [r[1] for r in page["rows"]] == ["bob"]
    page = client.post(f"/api/connections/{cid}/data{q}", json={**req, "page_size": 50, "filters": [{"column": "score", "op": "is_null"}]}).json()
    assert [r[1] for r in page["rows"]] == ["o'hara; drop"]
    page = client.post(f"/api/connections/{cid}/data{q}", json={**req, "page_size": 50, "search": "ALI"}).json()
    assert [r[1] for r in page["rows"]] == ["alice"]
    bad = client.post(f"/api/connections/{cid}/data{q}", json={**req, "sort": [{"column": "nope); drop table x; --"}]})
    assert bad.status_code == 400

    all_rows = client.post(f"/api/connections/{cid}/data{q}", json={**req, "page_size": 50}).json()["rows"]
    alice_id = next(r[0] for r in all_rows if r[1] == "alice")
    r = client.post(f"/api/connections/{cid}/data/update{q}", json={"schema_name": schema, "table": table,
                    "updates": [{"key": {"id": alice_id}, "values": {"score": "99", "meta": "{\"k\": 1}"}}]})
    assert r.status_code == 200 and r.json()["affected"] == 1, r.text
    r = client.post(f"/api/connections/{cid}/data/delete{q}", json={"schema_name": schema, "table": table, "keys": [{"id": alice_id}]})
    assert r.json()["affected"] == 1

    # --- SQL editor: multiple result sets, DML counts, errors stop execution
    qt = f"{schema}.{table}" if schema else table
    sql = f"SELECT name, score FROM {qt} ORDER BY name; UPDATE {qt} SET score = 1 WHERE name = 'bob'; SELECT COUNT(*) AS n FROM {qt}"
    r = client.post(f"/api/connections/{cid}/query", json={"sql": sql, "database": db})
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["status"] == "success" and len(res["results"]) == 3
    assert res["results"][0]["returns_rows"] and res["results"][0]["columns"][0]["name"] == "name"
    assert res["results"][1]["row_count"] == 1
    assert res["results"][2]["rows"][0][0] == 2

    r = client.post(f"/api/connections/{cid}/query", json={"sql": "SELECT 1 AS a; SELECT * FROM no_such_table_xyz; SELECT 2", "database": db}).json()
    assert r["status"] == "error" and len(r["results"]) == 2 and r["results"][1]["error"]

    r = client.post(f"/api/connections/{cid}/query", json={"sql": f"SELECT * FROM {qt}", "database": db, "max_rows": 1}).json()
    assert r["results"][0]["truncated"] is True and len(r["results"][0]["rows"]) == 1

    # Colons and percent signs must pass through verbatim
    r = client.post(f"/api/connections/{cid}/query", json={"sql": "SELECT '10:30' AS t, 'a%b' AS p", "database": db}).json()
    assert r["results"][0]["rows"][0] == ["10:30", "a%b"], r

    hist = client.get("/api/history", params={"connection_id": cid}).json()
    assert hist["total"] >= 4 and any(h["status"] == "error" for h in hist["items"])

    # --- export (two-step ticket) and import
    t = client.post("/api/exports", json={"connection_id": cid, "database": db, "format": "csv",
                                          "table": {"schema_name": schema, "table": table}}).json()
    csv_body = client.get(t["url"]).text
    assert csv_body.lstrip("﻿").splitlines()[0] == "id,name,score,meta"
    assert client.get(t["url"]).status_code == 404  # tickets are single use
    t = client.post("/api/exports", json={"connection_id": cid, "database": db, "format": "json", "sql": f"SELECT name FROM {qt} ORDER BY name"}).json()
    assert [r["name"] for r in client.get(t["url"]).json()] == ["bob", "o'hara; drop"]
    t = client.post("/api/exports", json={"connection_id": cid, "database": db, "format": "sql", "table": {"schema_name": schema, "table": table}}).json()
    assert "INSERT INTO" in client.get(t["url"]).text

    files = {"file": ("people.csv", b"name,score\ncarol,5\ndave,\n", "text/csv")}
    data = {"format": "csv", "table": table, **({"schema_name": schema} if schema else {}), **({"database": db} if db else {})}
    r = client.post(f"/api/connections/{cid}/import", files=files, data=data)
    assert r.status_code == 200 and r.json()["rows"] == 2, r.text

    # --- dashboard returns real metadata
    d = client.get(f"/api/connections/{cid}/dashboard", params={"database": db} if db else {}).json()
    assert d["table_count"]["available"] and d["table_count"]["value"] >= 1

    # --- destructive DDL needs confirmation
    drop = {"schema_name": schema, "table": table, "operations": [{"op": "drop_table"}]}
    stmts = client.post(f"/api/connections/{cid}/schema/preview{q}", json=drop).json()["statements"]
    assert client.post(f"/api/connections/{cid}/schema/apply{q}", json={"change": drop, "expected_statements": stmts}).status_code == 400
    r = client.post(f"/api/connections/{cid}/schema/apply{q}", json={"change": drop, "expected_statements": stmts, "confirm_destructive": True})
    assert r.status_code == 200, r.text

    # --- read-only connections reject writes at the database/session level
    ro = client.post("/api/connections", json={"name": "ro", **cfg, "read_only": True}).json()
    r = client.post(f"/api/connections/{ro['id']}/query", json={"sql": "CREATE TABLE should_fail (id int)", "database": db}).json()
    assert r["status"] == "error", r
    assert client.delete(f"/api/connections/{ro['id']}").status_code == 204
    assert client.delete(f"/api/connections/{cid}").status_code == 204

    audit = client.get("/api/audit").json()
    assert any(a["action"] == "schema.apply" for a in audit["items"])
    assert cfg.get("password", "zzz-not-there") not in json.dumps(audit)


def test_saved_queries(client):
    r = client.post("/api/saved-queries", json={"name": "Top", "sql": "select 1", "is_snippet": True})
    assert r.status_code == 201
    sid = r.json()["id"]
    assert any(s["id"] == sid for s in client.get("/api/saved-queries").json())
    assert client.put(f"/api/saved-queries/{sid}", json={"name": "Top2", "sql": "select 2"}).json()["name"] == "Top2"
    assert client.delete(f"/api/saved-queries/{sid}").status_code == 204
