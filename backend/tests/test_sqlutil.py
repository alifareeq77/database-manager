import datetime as dt
import decimal
import uuid

import pytest

from app.adapters.sqlutil import category_for_type, serialize_value, split_statements, validate_type_name


def test_split_basic_and_quotes():
    sql = "select 1; select 'a;b'; select \"x;y\" from t; -- c;\nselect 2"
    assert split_statements(sql) == ["select 1", "select 'a;b'", 'select "x;y" from t', "-- c;\nselect 2"]


def test_split_block_comment_and_trailing():
    assert split_statements("/* a; b */ select 1;;  ; ") == ["/* a; b */ select 1"]
    assert split_statements("-- only a comment") == []


def test_split_dollar_quotes():
    sql = "create function f() returns int as $$ begin return 1; end $$ language plpgsql; select 1"
    out = split_statements(sql, dollar_quotes=True)
    assert len(out) == 2 and out[0].endswith("language plpgsql")
    tagged = "do $body$ begin perform 1; end $body$; select 2"
    assert len(split_statements(tagged, dollar_quotes=True)) == 2


def test_split_mysql_delimiter():
    sql = "DELIMITER //\ncreate procedure p() begin select 1; select 2; end//\nDELIMITER ;\nselect 3;"
    out = split_statements(sql)
    assert out[0].startswith("create procedure") and out[0].endswith("end") and out[1] == "select 3"


def test_split_escaped_quotes():
    assert split_statements("select 'it''s; fine'; select 2") == ["select 'it''s; fine'", "select 2"]


def test_serialize_values():
    assert serialize_value(decimal.Decimal("1.50")) == "1.50"
    assert serialize_value(dt.datetime(2024, 1, 2, 3, 4, 5)) == "2024-01-02T03:04:05"
    u = uuid.uuid4()
    assert serialize_value(u) == str(u)
    assert serialize_value(2**60) == str(2**60)
    assert serialize_value(b"\x00\x01")["length"] == 2
    assert serialize_value({"a": [1, decimal.Decimal("2")]}) == {"a": [1, "2"]}
    assert serialize_value(float("nan")) == "nan"


@pytest.mark.parametrize("t,cat", [
    ("integer", "integer"), ("bigint", "integer"), ("tinyint(1)", "boolean"), ("character varying(20)", "text"),
    ("timestamp with time zone", "datetime"), ("jsonb", "json"), ("numeric(10,2)", "decimal"), ("text[]", "array"),
    ("uuid", "uuid"), ("bytea", "binary"), ("double precision", "float"), ("date", "date"),
])
def test_categories(t, cat):
    assert category_for_type(t) == cat


@pytest.mark.parametrize("ok", ["integer", "varchar(255)", "numeric(10, 2)", "timestamp with time zone", "int unsigned", "text[]"])
def test_valid_types(ok):
    assert validate_type_name(ok)


@pytest.mark.parametrize("bad", ["int; drop table x", "text) --", "varchar(10)'", "a" * 100])
def test_invalid_types(bad):
    with pytest.raises(ValueError):
        validate_type_name(bad)
