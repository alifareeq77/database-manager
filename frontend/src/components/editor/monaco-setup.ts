// Monaco is bundled locally (no CDN) and configured once for the whole app.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import type { CatalogTable } from "@/lib/types";

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

window.MonacoEnvironment = {
  getWorker() {
    return new Worker(new URL("monaco-editor/editor/editor.worker.js", import.meta.url), { type: "module" });
  },
};

loader.config({ monaco });

monaco.editor.defineTheme("strata-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "keyword", foreground: "8fa8ff" },
    { token: "string", foreground: "9fd7a8" },
    { token: "number", foreground: "8fd3ff" },
    { token: "comment", foreground: "6b7080", fontStyle: "italic" },
    { token: "operator", foreground: "c8cbd4" },
    { token: "predefined", foreground: "d6a6ff" },
  ],
  colors: {
    "editor.background": "#16171a",
    "editor.lineHighlightBackground": "#1e2025",
    "editorLineNumber.foreground": "#4a4d57",
    "editorLineNumber.activeForeground": "#9a9eaa",
    "editor.selectionBackground": "#2d3a5e",
    "editorGutter.background": "#16171a",
    "editorWidget.background": "#1d1f23",
    "editorSuggestWidget.background": "#1d1f23",
    "editorSuggestWidget.border": "#2a2c32",
    "editorSuggestWidget.selectedBackground": "#2a3350",
  },
});

monaco.editor.defineTheme("strata-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "keyword", foreground: "3451c9" },
    { token: "string", foreground: "2c7a3f" },
    { token: "number", foreground: "0b6fa8" },
    { token: "comment", foreground: "8a8f99", fontStyle: "italic" },
    { token: "predefined", foreground: "8a3fc2" },
  ],
  colors: {
    "editor.background": "#fdfdfd",
    "editor.lineHighlightBackground": "#f3f4f7",
    "editorLineNumber.foreground": "#b5b8c0",
  },
});

// ---- schema-aware completion ---------------------------------------------------------

export interface CompletionContext {
  catalog: () => CatalogTable[] | undefined;
  quote: string;
}

const contexts = new Map<string, CompletionContext>();
export function setCompletionContext(modelUri: string, ctx: CompletionContext | null) {
  if (ctx) contexts.set(modelUri, ctx);
  else contexts.delete(modelUri);
}

const KEYWORDS = [
  "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "IN", "IS", "NULL", "LIKE", "ILIKE", "BETWEEN", "EXISTS", "JOIN", "LEFT JOIN", "RIGHT JOIN",
  "INNER JOIN", "FULL OUTER JOIN", "CROSS JOIN", "ON", "USING", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "DISTINCT", "AS", "CASE",
  "WHEN", "THEN", "ELSE", "END", "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE FROM", "RETURNING", "CREATE TABLE", "ALTER TABLE", "DROP TABLE",
  "CREATE INDEX", "PRIMARY KEY", "FOREIGN KEY", "REFERENCES", "DEFAULT", "UNIQUE", "CHECK", "WITH", "UNION", "UNION ALL", "EXCEPT", "INTERSECT",
  "EXPLAIN", "EXPLAIN ANALYZE", "BEGIN", "COMMIT", "ROLLBACK", "ASC", "DESC", "NULLS FIRST", "NULLS LAST", "COUNT", "SUM", "AVG", "MIN", "MAX",
  "COALESCE", "NULLIF", "CAST", "NOW()", "CURRENT_TIMESTAMP", "TRUE", "FALSE", "OVER", "PARTITION BY", "ROW_NUMBER()",
];

function needsQuote(name: string) {
  return !/^[a-z_][a-z0-9_]*$/.test(name);
}

/** Map aliases and table names referenced in the statement to catalog tables. */
function referencedTables(text: string, catalog: CatalogTable[]): Map<string, CatalogTable> {
  const out = new Map<string, CatalogTable>();
  const re = /\b(?:from|join|update|into)\s+((?:["`]?[\w$]+["`]?\.)?["`]?[\w$]+["`]?)(?:\s+(?:as\s+)?([a-z_][\w$]*))?/gi;
  let m: RegExpExecArray | null;
  const reserved = new Set(["where", "on", "join", "left", "right", "inner", "outer", "full", "cross", "group", "order", "limit", "set", "values", "using", "natural"]);
  while ((m = re.exec(text))) {
    const raw = m[1].replace(/["`]/g, "");
    const [schema, name] = raw.includes(".") ? raw.split(".") : [null, raw];
    const t = catalog.find((c) => c.name.toLowerCase() === name.toLowerCase() && (!schema || c.schema_name?.toLowerCase() === schema.toLowerCase()));
    if (!t) continue;
    out.set(t.name.toLowerCase(), t);
    if (m[2] && !reserved.has(m[2].toLowerCase())) out.set(m[2].toLowerCase(), t);
  }
  return out;
}

let registered = false;
export function registerSqlCompletion() {
  if (registered) return;
  registered = true;
  monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: [".", " "],
    provideCompletionItems(model, position) {
      const ctx = contexts.get(model.uri.toString());
      const catalog = ctx?.catalog() ?? [];
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const linePrefix = model.getValueInRange(new monaco.Range(position.lineNumber, 1, position.lineNumber, word.startColumn));
      const text = model.getValue();
      const q = ctx?.quote ?? '"';
      const ident = (n: string) => (needsQuote(n) ? `${q}${n}${q}` : n);
      const K = monaco.languages.CompletionItemKind;
      const suggestions: monaco.languages.CompletionItem[] = [];

      // "alias." or "table." → columns of that table; "schema." → tables in schema
      const dot = linePrefix.match(/(["`]?[\w$]+["`]?)\.$/);
      if (dot) {
        const qualifier = dot[1].replace(/["`]/g, "").toLowerCase();
        const refs = referencedTables(text, catalog);
        const t = refs.get(qualifier) ?? catalog.find((c) => c.name.toLowerCase() === qualifier);
        if (t) {
          for (const [col, type] of t.columns) suggestions.push({ label: col, kind: K.Field, detail: type, insertText: ident(col), range, sortText: "0" });
        }
        for (const c of catalog.filter((x) => x.schema_name?.toLowerCase() === qualifier)) {
          suggestions.push({ label: c.name, kind: c.kind === "table" ? K.Struct : K.Interface, detail: c.kind, insertText: ident(c.name), range, sortText: "1" });
        }
        return { suggestions };
      }

      const afterTableKeyword = /\b(from|join|update|into|table)\s+[\w."`]*$/i.test(linePrefix);
      const refs = referencedTables(text, catalog);
      const seenCols = new Set<string>();
      if (!afterTableKeyword) {
        for (const t of new Set(refs.values())) {
          for (const [col, type] of t.columns) {
            if (seenCols.has(col)) continue;
            seenCols.add(col);
            suggestions.push({ label: col, kind: K.Field, detail: `${t.name} · ${type}`, insertText: ident(col), range, sortText: "0" });
          }
        }
      }
      const schemas = new Set<string>();
      for (const t of catalog) {
        const defaultSchema = !t.schema_name || t.schema_name === "public";
        const insert = defaultSchema ? ident(t.name) : `${ident(t.schema_name!)}.${ident(t.name)}`;
        suggestions.push({
          label: defaultSchema ? t.name : `${t.schema_name}.${t.name}`,
          kind: t.kind === "table" ? K.Struct : K.Interface,
          detail: `${t.kind} · ${t.columns.length} columns`,
          insertText: insert,
          range,
          sortText: afterTableKeyword ? "0" : "2",
        });
        if (t.schema_name) schemas.add(t.schema_name);
      }
      for (const s of schemas) suggestions.push({ label: s, kind: K.Module, detail: "schema", insertText: ident(s), range, sortText: "3" });
      if (!afterTableKeyword) {
        for (const k of KEYWORDS) suggestions.push({ label: k, kind: K.Keyword, insertText: k, range, sortText: "4" });
      }
      return { suggestions };
    },
  });
}

export { monaco };
