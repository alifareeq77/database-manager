// Engine-neutral SQL text helpers. Engine specifics come from the connection's
// `identifier_quote` capability rather than from engine checks in components.

import type { CellValue, ColumnInfo, Connection } from "./types";
import { csvEscape, isBinary } from "./format";

export function quoteIdent(name: string, q: string): string {
  const close = q === "[" ? "]" : q;
  return `${q}${name.split(close).join(close + close)}${close}`;
}

export function qualifiedName(conn: Pick<Connection, "identifier_quote">, schema: string | null, name: string): string {
  const q = conn.identifier_quote;
  return schema ? `${quoteIdent(schema, q)}.${quoteIdent(name, q)}` : quoteIdent(name, q);
}

export function sqlLiteral(v: CellValue): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (isBinary(v)) return "NULL /* binary */";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return `'${s.replace(/'/g, "''")}'`;
}

export function selectStatement(conn: Connection, schema: string | null, table: string, columns?: string[], limit = 100): string {
  const cols = columns?.length ? columns.map((c) => quoteIdent(c, conn.identifier_quote)).join(",\n  ") : "*";
  return `SELECT${cols === "*" ? " *" : `\n  ${cols}`}\nFROM ${qualifiedName(conn, schema, table)}\nLIMIT ${limit};`;
}

export function insertStatements(conn: Connection, schema: string | null, table: string, columns: ColumnInfo[] | string[], rows: CellValue[][]): string {
  const names = columns.map((c) => (typeof c === "string" ? c : c.name));
  const head = `INSERT INTO ${qualifiedName(conn, schema, table)} (${names.map((n) => quoteIdent(n, conn.identifier_quote)).join(", ")}) VALUES`;
  return rows.map((r) => `${head} (${r.map(sqlLiteral).join(", ")});`).join("\n");
}

export function rowsToJson(columns: string[], rows: CellValue[][]): string {
  return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))), null, 2);
}

export function rowsToCsv(columns: string[], rows: CellValue[][]): string {
  const cell = (v: CellValue) => (v === null || v === undefined ? "" : csvEscape(typeof v === "object" ? JSON.stringify(v) : String(v)));
  return [columns.map(csvEscape).join(","), ...rows.map((r) => r.map(cell).join(","))].join("\n");
}

/** Find the statement under the cursor in a multi-statement script (by blank-line/semicolon boundaries). */
export function statementAt(text: string, offset: number): { start: number; end: number; sql: string } {
  // Lightweight scanner aware of quotes and comments.
  const bounds: number[] = [0];
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = text[i + 1] === quote ? (i++, quote) : null;
    } else if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    } else if (ch === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      i = e === -1 ? text.length : e + 2;
      continue;
    } else if (ch === ";") bounds.push(i + 1);
    i++;
  }
  bounds.push(text.length);
  for (let b = 0; b < bounds.length - 1; b++) {
    const start = bounds[b];
    const end = bounds[b + 1];
    if (offset >= start && offset <= end) {
      const sql = text.slice(start, end).trim();
      if (sql.replace(/;$/, "").trim()) return { start, end, sql };
      // cursor right after a ';' — use the previous statement
      if (b > 0) return { start: bounds[b - 1], end: start, sql: text.slice(bounds[b - 1], start).trim() };
    }
  }
  return { start: 0, end: text.length, sql: text.trim() };
}
