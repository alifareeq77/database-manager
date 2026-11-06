// Tiny cross-component signals for things that live in separate trees (explorer, data tabs, dialogs).

export interface ObjectChangedDetail {
  connectionId: string;
  database?: string | null;
  schema?: string | null;
  table?: string | null;
}

const OBJECTS = "strata:objects-changed";
const DATA = "strata:data-changed";

/** Structure changed (DDL applied): explorer trees and structure views reload. */
export function emitObjectsChanged(detail: ObjectChangedDetail) {
  window.dispatchEvent(new CustomEvent<ObjectChangedDetail>(OBJECTS, { detail }));
}

/** Rows changed outside a data tab (e.g. import): matching data tabs reload. */
export function emitDataChanged(detail: ObjectChangedDetail) {
  window.dispatchEvent(new CustomEvent<ObjectChangedDetail>(DATA, { detail }));
}

function listen(name: string, fn: (d: ObjectChangedDetail) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<ObjectChangedDetail>).detail);
  window.addEventListener(name, h);
  return () => window.removeEventListener(name, h);
}

export const onObjectsChanged = (fn: (d: ObjectChangedDetail) => void) => listen(OBJECTS, fn);
export const onDataChanged = (fn: (d: ObjectChangedDetail) => void) => listen(DATA, fn);

/** True when `d` targets the given table (missing fields in `d` act as wildcards). */
export function matchesTable(d: ObjectChangedDetail, connectionId: string, database: string | null, schema: string | null, table: string): boolean {
  if (d.connectionId !== connectionId) return false;
  if (d.database !== undefined && d.database !== database) return false;
  if (d.schema !== undefined && d.schema !== schema) return false;
  if (d.table !== undefined && d.table !== null && d.table !== table) return false;
  return true;
}
