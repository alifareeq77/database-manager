import type { ColumnDef, Engine, FkAction } from "@/lib/types";

/** Common type names per engine, offered as suggestions (any type string is still accepted). */
export const COLUMN_TYPES: Record<Engine, string[]> = {
  postgresql: [
    "bigint", "integer", "smallint", "numeric(12,2)", "real", "double precision", "boolean", "text", "varchar(255)", "char(1)",
    "uuid", "jsonb", "json", "date", "timestamp", "timestamptz", "time", "interval", "bytea", "inet", "text[]", "integer[]",
  ],
  mysql: [
    "bigint", "int", "smallint", "tinyint", "decimal(12,2)", "float", "double", "boolean", "varchar(255)", "char(36)", "text",
    "mediumtext", "longtext", "json", "date", "datetime", "timestamp", "time", "year", "blob", "binary(16)", "enum('a','b')",
  ],
  sqlite: ["integer", "real", "text", "blob", "numeric", "boolean", "date", "datetime"],
};

export const FK_ACTIONS: FkAction[] = ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"];

export function defaultIdColumn(engine: Engine): ColumnDef {
  return { name: "id", type: engine === "sqlite" ? "integer" : "bigint", nullable: false, primary_key: true, auto_increment: true, unique: false, default: null };
}

export function blankColumn(engine: Engine): ColumnDef {
  return { name: "", type: engine === "postgresql" ? "text" : engine === "mysql" ? "varchar(255)" : "text", nullable: true, primary_key: false, auto_increment: false, unique: false, default: null };
}

/** Clean up a column definition before sending it: trims, empty default -> null. */
export function normalizeColumn(c: ColumnDef): ColumnDef {
  return {
    ...c,
    name: c.name.trim(),
    type: c.type.trim(),
    default: c.default?.trim() ? c.default.trim() : null,
    comment: c.comment?.trim() ? c.comment.trim() : null,
    nullable: c.primary_key ? false : c.nullable,
  };
}

export const IDENT_HINT = "Letters, digits, and underscores are safest; other names are quoted automatically.";
