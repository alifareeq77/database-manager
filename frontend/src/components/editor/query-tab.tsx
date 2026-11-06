"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { useTheme } from "next-themes";
import { format as formatSql } from "sql-formatter";
import { toast } from "sonner";
import { Bookmark, ChevronDown, Database, Loader2, Play, Save, Sparkles, Square, TextQuote, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { statementAt } from "@/lib/sql";
import type { CatalogTable, Connection, SavedQuery, SchemaInfo } from "@/lib/types";
import { useConnections } from "@/stores/connections";
import { useResults } from "@/stores/results";
import { useUi } from "@/stores/ui";
import { useWorkspace, type Tab } from "@/stores/workspace";
import { modKey } from "@/hooks/use-hotkey";
import { Breadcrumb } from "@/components/data/table-tab";
import { monaco, registerSqlCompletion, setCompletionContext } from "./monaco-setup";
import { cancelQuery, runQuery } from "./run-query";
import { SaveQueryDialog } from "./save-query-dialog";

type QueryTabT = Extract<Tab, { kind: "query" }>;
const DIALECT: Record<string, "postgresql" | "mysql" | "sqlite"> = { postgresql: "postgresql", mysql: "mysql", sqlite: "sqlite" };

export function QueryTab({ tab, conn, active }: { tab: QueryTabT; conn: Connection; active: boolean }) {
  const { resolvedTheme } = useTheme();
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const running = useResults((s) => !!s.runs[tab.id]?.running);
  const [maxRows, setMaxRows] = useState(1000);
  const [databases, setDatabases] = useState<SchemaInfo[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [snippets, setSnippets] = useState<SavedQuery[]>([]);
  const catalogRef = useRef<CatalogTable[] | undefined>(undefined);
  const status = useConnections((s) => s.status[conn.id]);
  const path = `inmemory://strata/${tab.id}.sql`;

  // Load the schema catalog for autocomplete.
  useEffect(() => {
    if (status !== "connected") return;
    let alive = true;
    useConnections.getState().loadCatalog(conn.id, tab.database).then((c) => alive && (catalogRef.current = c)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [conn.id, tab.database, status]);
  // Refresh catalog when it gets invalidated (e.g. after DDL).
  const catalogs = useConnections((s) => s.catalogs);
  useEffect(() => {
    const key = `${conn.id}:${tab.database ?? ""}`;
    if (catalogs[key]) catalogRef.current = catalogs[key];
    else if (status === "connected") useConnections.getState().loadCatalog(conn.id, tab.database).then((c) => (catalogRef.current = c)).catch(() => undefined);
  }, [catalogs, conn.id, tab.database, status]);

  useEffect(() => {
    if (!conn.capabilities.multiple_databases || status !== "connected") return;
    api.explorer.databases(conn.id).then(setDatabases).catch(() => setDatabases([]));
  }, [conn.id, conn.capabilities.multiple_databases, status]);

  useEffect(() => {
    setCompletionContext(path, { catalog: () => catalogRef.current, quote: conn.identifier_quote });
    return () => setCompletionContext(path, null);
  }, [path, conn.identifier_quote]);

  const getSql = useCallback((mode: "smart" | "all"): string => {
    const ed = editorRef.current;
    if (!ed) return tab.sql;
    const model = ed.getModel()!;
    const sel = ed.getSelection();
    if (mode === "smart" && sel && !sel.isEmpty()) return model.getValueInRange(sel);
    if (mode === "all") return model.getValue();
    const offset = model.getOffsetAt(ed.getPosition()!);
    const stmt = statementAt(model.getValue(), offset);
    // Briefly highlight what is about to run.
    const start = model.getPositionAt(stmt.start);
    const end = model.getPositionAt(stmt.end);
    const deco = ed.createDecorationsCollection([{ range: new monaco.Range(start.lineNumber, 1, end.lineNumber, model.getLineMaxColumn(end.lineNumber)), options: { className: "bg-primary/10", isWholeLine: true } }]);
    setTimeout(() => deco.clear(), 400);
    return stmt.sql;
  }, [tab.sql]);

  const execute = useCallback(async (mode: "smart" | "all", prefix = "") => {
    const sql = getSql(mode).trim();
    if (!sql) return toast.info("Nothing to run");
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (model) monaco.editor.setModelMarkers(model, "strata", []);
    const res = await runQuery(tab.id, conn, tab.database, prefix + sql, maxRows);
    const failed = res?.results.find((r) => r.error);
    if (failed && model) {
      // Mark the failing statement in the editor.
      const idx = model.getValue().indexOf(failed.statement.slice(0, 200));
      if (idx >= 0) {
        const s = model.getPositionAt(idx);
        const e = model.getPositionAt(idx + failed.statement.length);
        monaco.editor.setModelMarkers(model, "strata", [{ severity: monaco.MarkerSeverity.Error, message: failed.error!, startLineNumber: s.lineNumber, startColumn: s.column, endLineNumber: e.lineNumber, endColumn: e.column }]);
      }
    }
  }, [getSql, tab.id, tab.database, conn, maxRows]);

  const doFormat = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    try {
      const formatted = formatSql(ed.getValue(), { language: DIALECT[conn.engine], keywordCase: "upper", tabWidth: 2 });
      ed.executeEdits("format", [{ range: ed.getModel()!.getFullModelRange(), text: formatted }]);
    } catch (e) {
      toast.error("Could not format SQL", { description: (e as Error).message });
    }
  }, [conn.engine]);

  const save = useCallback(async () => {
    if (!tab.savedId) return setSaveOpen(true);
    try {
      const existing = (await api.saved.list()).find((s) => s.id === tab.savedId);
      if (!existing) return setSaveOpen(true);
      await api.saved.update(tab.savedId, { ...existing, sql: editorRef.current?.getValue() ?? tab.sql });
      useWorkspace.getState().update(tab.id, { dirty: false });
      window.dispatchEvent(new Event("strata:saved-changed"));
      toast.success(`Saved “${existing.name}”`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [tab.savedId, tab.id, tab.sql]);

  // Keep latest callbacks for Monaco command bindings.
  const handlers = useRef({ execute, doFormat, save });
  useEffect(() => {
    handlers.current = { execute, doFormat, save };
  }, [execute, doFormat, save]);

  const onMount: OnMount = (ed) => {
    editorRef.current = ed;
    registerSqlCompletion();
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void handlers.current.execute("smart"));
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => void handlers.current.execute("all"));
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void handlers.current.save());
    ed.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, () => handlers.current.doFormat());
    // Ctrl+K must reach the command palette instead of Monaco's chord handler.
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => useUi.getState().setPalette(true));
    if (active) ed.focus();
  };

  useEffect(() => {
    if (active) editorRef.current?.focus();
  }, [active]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b px-2">
        {running ? (
          <Button size="sm" variant="destructive" onClick={() => void cancelQuery(tab.id)}>
            <Square className="fill-current" /> Cancel
          </Button>
        ) : (
          <div className="flex">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="sm" className="rounded-r-none" onClick={() => void execute("smart")} disabled={status !== "connected"}>
                  <Play className="fill-current" /> Run
                </Button>
              </TooltipTrigger>
              <TooltipContent>Run selection or current statement <span className="kbd ml-1">{modKey} Enter</span></TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" className="rounded-l-none border-l border-primary-foreground/20 px-1.5" disabled={status !== "connected"} aria-label="More run options"><ChevronDown /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuItem onSelect={() => void execute("all")}>Run all statements <span className="ml-auto kbd">{modKey} ⇧ Enter</span></DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void execute("smart", conn.engine === "sqlite" ? "EXPLAIN QUERY PLAN " : "EXPLAIN ")}>Explain current statement</DropdownMenuItem>
                {conn.engine === "postgresql" && (
                  <DropdownMenuItem onSelect={() => void execute("smart", "EXPLAIN (ANALYZE, BUFFERS) ")}>Explain analyze (executes the query)</DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        {running && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        <div className="mx-1 h-4 w-px bg-border" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={doFormat}><Wand2 /> Format</Button>
          </TooltipTrigger>
          <TooltipContent>Format SQL <span className="kbd ml-1">⇧ Alt F</span></TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={() => void save()}><Save /> Save</Button>
          </TooltipTrigger>
          <TooltipContent>Save query <span className="kbd ml-1">{modKey} S</span></TooltipContent>
        </Tooltip>
        <DropdownMenu onOpenChange={(o) => o && api.saved.list().then((s) => setSnippets(s.filter((x) => x.is_snippet))).catch(() => undefined)}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm"><TextQuote /> Snippets</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-64">
            <DropdownMenuLabel className="text-[11px] text-muted-foreground">Insert at cursor</DropdownMenuLabel>
            {snippets.length === 0 && <div className="px-2 py-1.5 text-[12px] text-muted-foreground">No snippets yet. Save a query as a snippet to reuse it here.</div>}
            {snippets.map((s) => (
              <DropdownMenuItem key={s.id} onSelect={() => {
                const ed = editorRef.current;
                if (!ed) return;
                ed.executeEdits("snippet", [{ range: ed.getSelection()!, text: s.sql }]);
                ed.focus();
              }}>
                <Sparkles /> <span className="truncate">{s.name}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setSaveOpen(true)}><Bookmark /> Save current as…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="ml-auto flex items-center gap-1.5">
          <Breadcrumb parts={[conn.name]} color={conn.color} />
          {conn.capabilities.multiple_databases && (
            <Select value={tab.database ?? "__none"} onValueChange={(v) => useWorkspace.getState().update(tab.id, { database: v === "__none" ? null : v })}>
              <SelectTrigger size="sm" className="h-7 max-w-44 text-[12px]">
                <Database className="size-3.5" />
                <SelectValue placeholder="Database" />
              </SelectTrigger>
              <SelectContent>
                {conn.engine === "mysql" && <SelectItem value="__none" className="text-[12px]">(none)</SelectItem>}
                {databases.map((d) => <SelectItem key={d.name} value={d.name} className="text-[12px]">{d.name}</SelectItem>)}
                {tab.database && !databases.some((d) => d.name === tab.database) && <SelectItem value={tab.database} className="text-[12px]">{tab.database}</SelectItem>}
              </SelectContent>
            </Select>
          )}
          <Select value={String(maxRows)} onValueChange={(v) => setMaxRows(Number(v))}>
            <SelectTrigger size="sm" className="h-7 w-[112px] text-[12px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[100, 500, 1000, 5000, 10000, 50000].map((n) => <SelectItem key={n} value={String(n)} className="text-[12px]">Limit {n.toLocaleString()}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <Editor
          path={path}
          defaultLanguage="sql"
          defaultValue={tab.sql}
          theme={resolvedTheme === "light" ? "strata-light" : "strata-dark"}
          onMount={onMount}
          onChange={(v) => useWorkspace.getState().update(tab.id, { sql: v ?? "", dirty: true })}
          loading={<Loader2 className="size-4 animate-spin text-muted-foreground" />}
          options={{
            fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
            fontSize: 13,
            lineHeight: 20,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            renderLineHighlight: "line",
            padding: { top: 10 },
            tabSize: 2,
            wordWrap: "on",
            automaticLayout: true,
            quickSuggestions: { other: true, strings: false, comments: false },
            suggestOnTriggerCharacters: true,
            fixedOverflowWidgets: true,
            smoothScrolling: true,
            cursorBlinking: "smooth",
            overviewRulerBorder: false,
            scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
          }}
        />
      </div>
      <SaveQueryDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        defaultName={tab.title.startsWith("Query ") ? "" : tab.title}
        onSave={async (name, description, isSnippet) => {
          const sql = editorRef.current?.getValue() ?? tab.sql;
          const saved = await api.saved.create({ name, description, sql, connection_id: conn.id, is_snippet: isSnippet });
          if (!isSnippet) useWorkspace.getState().update(tab.id, { savedId: saved.id, title: name, dirty: false });
          window.dispatchEvent(new Event("strata:saved-changed"));
          toast.success(isSnippet ? "Snippet saved" : "Query saved");
        }}
      />
    </div>
  );
}
