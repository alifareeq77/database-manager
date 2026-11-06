"""Engine-neutral request contracts for data browsing and structural changes."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, field_validator

FilterOp = Literal[
    "eq", "neq", "gt", "gte", "lt", "lte", "contains", "not_contains", "starts_with", "ends_with",
    "is_null", "not_null", "in", "not_in",
]


class SortSpec(BaseModel):
    column: str
    direction: Literal["asc", "desc"] = "asc"


class FilterSpec(BaseModel):
    column: str
    op: FilterOp
    value: Any = None


class DataRequest(BaseModel):
    schema_name: str | None = None
    table: str
    page: int = Field(1, ge=1)
    page_size: int = Field(100, ge=1)
    sort: list[SortSpec] = Field(default_factory=list, max_length=8)
    filters: list[FilterSpec] = Field(default_factory=list, max_length=32)
    filter_mode: Literal["and", "or"] = "and"
    search: str | None = Field(None, max_length=500)
    with_total: bool = True


class TableRef(BaseModel):
    schema_name: str | None = None
    table: str


class InsertRequest(TableRef):
    rows: list[dict[str, Any]] = Field(min_length=1, max_length=1000)


class UpdateItem(BaseModel):
    key: dict[str, Any]  # primary-key column -> current value
    values: dict[str, Any] = Field(min_length=1)


class UpdateRequest(TableRef):
    updates: list[UpdateItem] = Field(min_length=1, max_length=1000)


class DeleteRequest(TableRef):
    keys: list[dict[str, Any]] = Field(min_length=1, max_length=5000)


# ---- Structural changes -------------------------------------------------------------------

FkAction = Literal["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"]


class ColumnDef(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    type: str = Field(min_length=1, max_length=128)
    nullable: bool = True
    default: str | None = Field(None, max_length=500)  # raw SQL expression, shown in preview
    primary_key: bool = False
    auto_increment: bool = False
    unique: bool = False
    comment: str | None = Field(None, max_length=1000)


class CreateTableOp(BaseModel):
    op: Literal["create_table"]
    columns: list[ColumnDef] = Field(min_length=1, max_length=500)
    if_not_exists: bool = False


class AddColumnOp(BaseModel):
    op: Literal["add_column"]
    column: ColumnDef


class DropColumnOp(BaseModel):
    op: Literal["drop_column"]
    column: str


class RenameColumnOp(BaseModel):
    op: Literal["rename_column"]
    column: str
    new_name: str = Field(min_length=1, max_length=128)


class AlterColumnOp(BaseModel):
    op: Literal["alter_column"]
    column: str
    type: str | None = None
    nullable: bool | None = None
    default: str | None = None
    drop_default: bool = False


class RenameTableOp(BaseModel):
    op: Literal["rename_table"]
    new_name: str = Field(min_length=1, max_length=128)


class DropTableOp(BaseModel):
    op: Literal["drop_table"]
    cascade: bool = False
    kind: Literal["table", "view", "materialized_view"] = "table"


class TruncateTableOp(BaseModel):
    op: Literal["truncate_table"]


class CreateIndexOp(BaseModel):
    op: Literal["create_index"]
    name: str = Field(min_length=1, max_length=128)
    columns: list[str] = Field(min_length=1, max_length=32)
    unique: bool = False
    method: str | None = None


class DropIndexOp(BaseModel):
    op: Literal["drop_index"]
    name: str


class AddForeignKeyOp(BaseModel):
    op: Literal["add_foreign_key"]
    name: str = Field(min_length=1, max_length=128)
    columns: list[str] = Field(min_length=1)
    ref_schema: str | None = None
    ref_table: str
    ref_columns: list[str] = Field(min_length=1)
    on_delete: FkAction = "NO ACTION"
    on_update: FkAction = "NO ACTION"


class AddUniqueOp(BaseModel):
    op: Literal["add_unique"]
    name: str = Field(min_length=1, max_length=128)
    columns: list[str] = Field(min_length=1)


class AddCheckOp(BaseModel):
    op: Literal["add_check"]
    name: str = Field(min_length=1, max_length=128)
    expression: str = Field(min_length=1, max_length=2000)


class DropConstraintOp(BaseModel):
    op: Literal["drop_constraint"]
    name: str
    constraint_type: Literal["foreign_key", "unique", "check", "primary_key"] = "check"


SchemaOp = Annotated[
    CreateTableOp | AddColumnOp | DropColumnOp | RenameColumnOp | AlterColumnOp | RenameTableOp
    | DropTableOp | TruncateTableOp | CreateIndexOp | DropIndexOp | AddForeignKeyOp | AddUniqueOp
    | AddCheckOp | DropConstraintOp,
    Field(discriminator="op"),
]

DESTRUCTIVE_OPS = {"drop_column", "drop_table", "truncate_table", "drop_index", "drop_constraint"}


class SchemaChangeRequest(BaseModel):
    schema_name: str | None = None
    table: str = Field(min_length=1, max_length=128)
    operations: list[SchemaOp] = Field(min_length=1, max_length=100)

    @field_validator("operations", mode="before")
    @classmethod
    def _ensure_list(cls, v: Any) -> Any:
        return v if isinstance(v, list) else [v]
