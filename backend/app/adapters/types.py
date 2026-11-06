"""Engine-neutral metadata and result types returned by every adapter.

These are the API contracts the frontend consumes; no engine-specific shapes leak past here.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

EngineName = Literal["postgresql", "mysql", "sqlite"]

# Coarse type families used by the UI for formatting/editing and by adapters for value binding.
TypeCategory = Literal[
    "integer", "float", "decimal", "boolean", "text", "json", "date", "datetime", "time",
    "uuid", "binary", "array", "other",
]


class Capabilities(BaseModel):
    schemas: bool
    multiple_databases: bool
    sequences: bool
    functions: bool
    procedures: bool
    triggers: bool
    cancel: bool
    transactional_ddl: bool
    alter_column: bool
    add_constraint: bool


class ServerInfo(BaseModel):
    engine: EngineName
    version: str
    current_database: str | None = None
    current_user: str | None = None
    latency_ms: float


class SchemaInfo(BaseModel):
    name: str
    is_system: bool = False


ObjectKind = Literal["table", "view", "materialized_view", "function", "procedure", "sequence", "trigger"]


class DbObject(BaseModel):
    name: str
    kind: ObjectKind
    schema_name: str | None = None
    comment: str | None = None
    # For tables: estimated rows (may be stale), for triggers: the owning table, etc.
    row_estimate: int | None = None
    extra: dict[str, Any] = Field(default_factory=dict)


class ColumnInfo(BaseModel):
    name: str
    data_type: str
    category: TypeCategory
    nullable: bool
    default: str | None = None
    is_primary_key: bool = False
    is_auto_increment: bool = False
    comment: str | None = None
    ordinal: int


class IndexInfo(BaseModel):
    name: str
    columns: list[str]
    unique: bool
    primary: bool = False
    method: str | None = None
    definition: str | None = None
    size_bytes: int | None = None


class ForeignKeyInfo(BaseModel):
    name: str
    columns: list[str]
    ref_schema: str | None
    ref_table: str
    ref_columns: list[str]
    on_update: str | None = None
    on_delete: str | None = None


class ConstraintInfo(BaseModel):
    name: str
    type: Literal["primary_key", "unique", "check", "foreign_key"]
    columns: list[str] = Field(default_factory=list)
    definition: str | None = None


class TriggerInfo(BaseModel):
    name: str
    timing: str | None = None
    event: str | None = None
    definition: str | None = None


class TableStructure(BaseModel):
    schema_name: str | None
    name: str
    kind: ObjectKind
    columns: list[ColumnInfo]
    primary_key: list[str]
    indexes: list[IndexInfo]
    foreign_keys: list[ForeignKeyInfo]
    constraints: list[ConstraintInfo]
    triggers: list[TriggerInfo]
    referenced_by: list[ForeignKeyInfo] = Field(default_factory=list)
    comment: str | None = None
    row_estimate: int | None = None
    total_size_bytes: int | None = None
    view_definition: str | None = None


class ResultColumn(BaseModel):
    name: str
    category: TypeCategory = "other"
    data_type: str | None = None


class ResultSet(BaseModel):
    statement: str
    columns: list[ResultColumn] = Field(default_factory=list)
    rows: list[list[Any]] = Field(default_factory=list)
    row_count: int | None = None  # rows returned, or rows affected for DML
    truncated: bool = False
    returns_rows: bool = False
    duration_ms: float = 0
    error: str | None = None
    notices: list[str] = Field(default_factory=list)


class DataPage(BaseModel):
    columns: list[ColumnInfo]
    rows: list[list[Any]]
    total: int | None
    total_is_estimate: bool = False
    page: int
    page_size: int
    primary_key: list[str]
    editable: bool
    sql: str
    duration_ms: float


class CatalogTable(BaseModel):
    schema_name: str | None
    name: str
    kind: ObjectKind
    columns: list[tuple[str, str]]  # (name, data_type)


class MetricValue(BaseModel):
    available: bool
    value: Any = None
    note: str | None = None


class TableSize(BaseModel):
    schema_name: str | None
    name: str
    total_bytes: int | None
    table_bytes: int | None = None
    index_bytes: int | None = None
    row_estimate: int | None = None


class IndexSize(BaseModel):
    schema_name: str | None
    table: str
    name: str
    size_bytes: int | None


class RecentQuery(BaseModel):
    query: str
    calls: int | None = None
    total_ms: float | None = None
    mean_ms: float | None = None
    rows: int | None = None


class DashboardData(BaseModel):
    engine: EngineName
    version: str
    database: str | None
    database_size_bytes: MetricValue
    table_count: MetricValue
    schema_count: MetricValue
    active_connections: MetricValue
    largest_tables: list[TableSize]
    largest_indexes: list[IndexSize]
    recent_queries: MetricValue  # value: list[RecentQuery]
    insights: list[dict[str, Any]]  # [{label, value, note?}] engine-specific performance metrics
    latency_ms: float
