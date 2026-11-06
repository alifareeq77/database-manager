// Contextual actions shared by the explorer tree, tab toolbars and the command palette.

import { toast } from "sonner";
import { api, downloadExport } from "@/lib/api";
import { qualifiedName, selectStatement } from "@/lib/sql";
import type { Connection, ObjectKind } from "@/lib/types";
import { useConnections } from "@/stores/connections";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";

export interface ObjectRef {
  conn: Connection;
  database: string | null;
  schema: string | null;
  name: string;
  kind: ObjectKind;
}

export async function copyText(text: string, what = "Copied to clipboard") {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(what);
  } catch {
    toast.error("Clipboard is not available");
  }
}

export function openData(o: ObjectRef) {
  useWorkspace.getState().openTable({ connectionId: o.conn.id, database: o.database, schema: o.schema, table: o.name, objectKind: o.kind, view: "data" });
}

export function openStructure(o: ObjectRef) {
  useWorkspace.getState().openTable({ connectionId: o.conn.id, database: o.database, schema: o.schema, table: o.name, objectKind: o.kind, view: "structure" });
}

export function generateSelect(o: ObjectRef) {
  useWorkspace.getState().openQuery(o.conn.id, o.database, selectStatement(o.conn, o.schema, o.name), `SELECT ${o.name}`);
}

export async function openDefinition(o: ObjectRef) {
  try {
    const { sql } = await api.explorer.ddl(o.conn.id, o.database, o.schema, o.name, o.kind);
    useWorkspace.getState().openQuery(o.conn.id, o.database, sql, `DDL ${o.name}`);
  } catch (e) {
    toast.error("Could not load definition", { description: (e as Error).message });
  }
}

export function exportObject(o: ObjectRef, format: "csv" | "json" | "sql") {
  downloadExport({
    connection_id: o.conn.id,
    database: o.database,
    format,
    table: { schema_name: o.schema, table: o.name, page: 1, page_size: 1, sort: [], filters: [], filter_mode: "and", search: null },
  }).catch((e) => toast.error("Export failed", { description: (e as Error).message }));
}

export function truncateObject(o: ObjectRef, onDone?: () => void) {
  useUi.getState().requestSchemaChange({
    connectionId: o.conn.id,
    database: o.database,
    title: `Truncate ${o.name}`,
    change: { schema_name: o.schema, table: o.name, operations: [{ op: "truncate_table" }] },
    onApplied: onDone,
  });
}

export function dropObject(o: ObjectRef, onDone?: () => void) {
  const kind = o.kind === "view" ? "view" : o.kind === "materialized_view" ? "materialized_view" : "table";
  useUi.getState().requestSchemaChange({
    connectionId: o.conn.id,
    database: o.database,
    title: `Drop ${kind.replace("_", " ")} ${o.name}`,
    change: { schema_name: o.schema, table: o.name, operations: [{ op: "drop_table", kind }] },
    onApplied: () => {
      useWorkspace.getState().close(`table:${o.conn.id}:${o.database ?? ""}:${o.schema ?? ""}:${o.name}`);
      useConnections.getState().invalidateCatalog(o.conn.id);
      onDone?.();
    },
  });
}

export function qualified(o: ObjectRef) {
  return qualifiedName(o.conn, o.schema, o.name);
}
