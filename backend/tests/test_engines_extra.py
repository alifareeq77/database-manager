"""Introspection against the seeded sample databases, plus cancellation and timeouts."""

from __future__ import annotations

import threading
import time
import uuid

import pytest

from tests.test_api_flow import _reachable

PG = {"engine": "postgresql", "host": "127.0.0.1", "port": 54329, "username": "strata", "password": "strata_dev_pw", "database": "shop", "ssl_mode": "disable"}
MY = {"engine": "mysql", "host": "127.0.0.1", "port": 33069, "username": "strata", "password": "strata_dev_pw", "database": "blog", "ssl_mode": "disable"}
need_pg = pytest.mark.skipif(not _reachable(54329), reason="postgres not running")
need_my = pytest.mark.skipif(not _reachable(33069), reason="mysql not running")


def _conn(client, cfg, **extra):
    r = client.post("/api/connections", json={"name": f"x-{uuid.uuid4().hex[:6]}", **cfg, **extra})
    assert r.status_code == 201, r.text
    return r.json()["id"]


@need_pg
def test_pg_introspection(client):
    cid = _conn(client, PG)
    dbs = [d["name"] for d in client.get(f"/api/connections/{cid}/databases").json()]
    assert "shop" in dbs
    schemas = [s["name"] for s in client.get(f"/api/connections/{cid}/schemas", params={"database": "shop"}).json()]
    assert {"public", "inventory"} <= set(schemas)
    objs = client.get(f"/api/connections/{cid}/objects", params={"database": "shop", "schema": "public"}).json()
    kinds = {(o["name"], o["kind"]) for o in objs}
    assert ("customer_order_totals", "view") in kinds and ("order_count", "function") in kinds
    st = client.get(f"/api/connections/{cid}/structure", params={"database": "shop", "schema": "public", "table": "orders"}).json()
    assert {f["ref_table"] for f in st["foreign_keys"]} == {"customers", "products"}
    assert any(i["name"] == "orders_status_placed_idx" and i["columns"] == ["status", "placed_at"] for i in st["indexes"])
    cust = client.get(f"/api/connections/{cid}/structure", params={"database": "shop", "schema": "public", "table": "customers"}).json()
    assert any(c["type"] == "check" for c in cust["constraints"]) and cust["referenced_by"][0]["ref_table"] == "orders"
    assert next(c for c in cust["columns"] if c["name"] == "profile")["category"] == "json"
    ddl = client.get(f"/api/connections/{cid}/ddl", params={"database": "shop", "schema": "public", "name": "orders"}).json()["sql"]
    assert "CREATE TABLE" in ddl and "REFERENCES" in ddl
    cat = client.get(f"/api/connections/{cid}/catalog", params={"database": "shop"}).json()
    assert any(t["name"] == "products" and t["schema_name"] == "inventory" for t in cat)
    # JSONB filter + array value round-trip through PG casts
    page = client.post(f"/api/connections/{cid}/data?database=shop", json={
        "schema_name": "public", "table": "customers", "page_size": 5,
        "filters": [{"column": "profile", "op": "contains", "value": "\"pro\""}]}).json()
    assert page["rows"] and all("pro" in str(r[4]) for r in page["rows"])
    d = client.get(f"/api/connections/{cid}/dashboard", params={"database": "shop"}).json()
    assert d["largest_tables"][0]["name"] == "orders" and d["database_size_bytes"]["value"] > 0


@need_my
def test_mysql_introspection(client):
    cid = _conn(client, MY)
    st = client.get(f"/api/connections/{cid}/structure", params={"database": "blog", "table": "posts"}).json()
    assert st["foreign_keys"][0]["ref_table"] == "authors"
    assert any(i["name"] == "idx_posts_published" and i["columns"] == ["published", "published_at"] for i in st["indexes"])
    assert next(c for c in st["columns"] if c["name"] == "published")["category"] == "boolean"
    ddl = client.get(f"/api/connections/{cid}/ddl", params={"database": "blog", "name": "posts"}).json()["sql"]
    assert ddl.startswith("CREATE TABLE `posts`")
    objs = client.get(f"/api/connections/{cid}/objects", params={"database": "blog"}).json()
    assert ("published_posts", "view") in {(o["name"], o["kind"]) for o in objs}
    change = {"table": "posts", "operations": [{"op": "alter_column", "column": "views", "nullable": True}]}
    stmts = client.post(f"/api/connections/{cid}/schema/preview?database=blog", json=change).json()["statements"]
    assert stmts == ["ALTER TABLE `posts` MODIFY COLUMN `views` int unsigned NULL DEFAULT 0"]


@need_pg
@pytest.mark.parametrize("mode", ["cancel", "timeout"])
def test_pg_cancel_and_timeout(client, mode):
    cid = _conn(client, PG, query_timeout_s=2 if mode == "timeout" else 30)
    qid = uuid.uuid4().hex
    out: dict = {}

    def run() -> None:
        out["r"] = client.post(f"/api/connections/{cid}/query", json={"sql": "SELECT pg_sleep(20)", "database": "shop", "query_id": qid}).json()

    th = threading.Thread(target=run)
    t0 = time.time()
    th.start()
    if mode == "cancel":
        for _ in range(50):
            time.sleep(0.1)
            if any(q["query_id"] == qid for q in client.get("/api/queries/running").json()):
                break
        time.sleep(0.3)
        assert client.post(f"/api/queries/{qid}/cancel").json()["cancelled"] is True
    th.join(30)
    assert time.time() - t0 < 10
    r = out["r"]
    assert r["status"] == ("cancelled" if mode == "cancel" else "error")
    assert "cancel" in r["results"][0]["error"].lower()
