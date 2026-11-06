"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Copy, Download, Info, Loader2, ScrollText, Table2, Trash2, X, History,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { downloadExport } from "@/lib/api";
import { formatDuration, formatNumber } from "@/lib/format";
import { rowsToCsv, rowsToJson } from "@/lib/sql";
import type { ResultSet } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useConnections } from "@/stores/connections";
import { useResults, type LogEntry, type QueryRun } from "@/stores/results";
import { useWorkspace } from "@/stores/workspace";
import { modKey } from "@/hooks/use-hotkey";
import { DataGrid, type GridColumn } from "@/components/data/data-grid";
import { copyText } from "@/components/explorer/object-actions";
import { HistoryList } from "@/components/history/history-view";

export function BottomPanel() {
  const bottomTab = useResults((s) => s.bottomTab);
  const logCount = useResults((s) => s.logs.length);
  const errorCount = useResults((s) => s.logs.filter((l) => l.level === "error").length);
  const tab = useWorkspace((s) => s.tabs.find((t) => t.id === s.activeId));
  const run = useResults((s) => (tab ? s.runs[tab.id] : undefined));
  const setTab = useResults((s) => s.setBottomTab);

  const tabs = [
    { id: "results" as const, label: "Results", icon: Table2 },
    { id: "history" as const, label: "History", icon: History },
    { id: "log" as const, label: "Log", icon: ScrollText, badge: logCount ? (errorCount ? `${errorCount} err` : String(logCount)) : null, err: errorCount > 0 },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col border-t bg-background">
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b px-1.5">
        {tabs.map(({ id, label, icon: Icon, ...rest }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors",
              bottomTab === id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" /> {label}
            {"badge" in rest && rest.badge && (
              <span className={cn("rounded px-1 text-[10px] tabular-nums", rest.err ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground")}>{rest.badge}</span>
            )}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-0.5">
          {bottomTab === "log" && logCount > 0 && (
            <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => useResults.getState().clearLogs()}><Trash2 /> Clear</Button>
          )}
          <Button variant="ghost" size="icon-xs" className="text-muted-foreground" onClick={() => useResults.getState().toggleBottom()} aria-label="Hide panel" title={`Hide panel (${modKey} J)`}>
            <X />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {bottomTab === "results" && (tab?.kind === "query" ? <ResultsPane tabId={tab.id} run={run} /> : <Hint>Results of queries you run in a query tab appear here.</Hint>)}
        {bottomTab === "history" && <RecentHistory />}
        {bottomTab === "log" && <LogPane />}
      </div>
    </div>
  );
}

// ---------- Results

function ResultsPane({ tabId, run }: { tabId: string; run: QueryRun | undefined }) {
  const activeIdx = useResults((s) => s.activeResult[tabId] ?? 0);
  const elapsed = useElapsed(run?.running ? run.startedAt : null);

  if (!run) return <Hint>Press <span className="kbd">{modKey} Enter</span> to run the current statement, or <span className="kbd">{modKey} ⇧ Enter</span> to run everything.</Hint>;
  if (run.running && !run.result) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Running… <span className="tabular-nums">{formatDuration(elapsed)}</span>
      </div>
    );
  }
  if (run.error && !run.result) return <ErrorBox message={run.error} />;
  const result = run.result!;
  const sets = result.results;
  const idx = Math.min(activeIdx, sets.length - 1);
  const rs = sets[idx];

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {run.running && (
        <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-2 bg-background/70 py-1 text-[12px] text-muted-foreground backdrop-blur-[1px]">
          <Loader2 className="size-3.5 animate-spin" /> Running… {formatDuration(elapsed)}
        </div>
      )}
      {sets.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b px-1.5 py-1">
          {sets.map((s, i) => (
            <button
              key={i}
              onClick={() => useResults.getState().setActiveResult(tabId, i)}
              title={s.statement}
              className={cn(
                "flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11.5px]",
                i === idx ? "border-primary/50 bg-primary/10 text-foreground" : "text-muted-foreground hover:text-foreground",
                s.error && "border-destructive/40 text-destructive",
              )}
            >
              {s.error ? <AlertCircle className="size-3" /> : s.returns_rows ? <Table2 className="size-3" /> : <CheckCircle2 className="size-3" />}
              {i + 1}. {s.error ? "Error" : s.returns_rows ? `${formatNumber(s.row_count ?? s.rows.length)} rows` : s.row_count !== null ? `${formatNumber(s.row_count)} affected` : "OK"}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1">
        {rs ? <ResultSetView key={`${run.queryId}:${idx}`} rs={rs} /> : <Hint>No statements were executed.</Hint>}
      </div>
      {rs && <ResultFooter rs={rs} run={run} tabId={tabId} />}
    </div>
  );
}

function ResultSetView({ rs }: { rs: ResultSet }) {
  const columns: GridColumn[] = useMemo(() => rs.columns.map((c) => ({ name: c.name, category: c.category, dataType: c.data_type })), [rs]);
  if (rs.error) return <ErrorBox message={rs.error} statement={rs.statement} />;
  if (!rs.returns_rows) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
        <CheckCircle2 className="size-5 text-success" />
        <p>{rs.row_count !== null && rs.row_count >= 0 ? `${formatNumber(rs.row_count)} row(s) affected` : "Statement executed"}</p>
        <Notices notices={rs.notices} />
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      {rs.notices.length > 0 && <div className="shrink-0 border-b px-2 py-1"><Notices notices={rs.notices} /></div>}
      <div className="min-h-0 flex-1">
        <DataGrid columns={columns} rows={rs.rows} empty="Query returned no rows" />
      </div>
    </div>
  );
}

function ResultFooter({ rs, run, tabId }: { rs: ResultSet; run: QueryRun; tabId: string }) {
  const tab = useWorkspace((s) => s.tabs.find((t) => t.id === tabId));
  const conn = useConnections((s) => (tab && "connectionId" in tab ? s.connections.find((c) => c.id === tab.connectionId) : undefined));
  const names = rs.columns.map((c) => c.name);
  const database = tab && "database" in tab ? tab.database : null;

  const exportFull = (format: "csv" | "json" | "sql") => {
    if (!conn) return;
    downloadExport({ connection_id: conn.id, database, format, sql: rs.statement }).catch((e) => toast.error("Export failed", { description: (e as Error).message }));
  };

  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-t bg-surface px-2 text-[11.5px] text-muted-foreground">
      {rs.returns_rows && !rs.error && (
        <span className="tabular-nums">
          {formatNumber(rs.rows.length)} row{rs.rows.length === 1 ? "" : "s"}
          {rs.truncated && <span className="ml-1 text-warning">(truncated, more available)</span>}
        </span>
      )}
      <span className="tabular-nums">· {formatDuration(rs.duration_ms)}</span>
      {run.result && run.result.results.length > 1 && <span className="tabular-nums">· total {formatDuration(run.result.duration_ms)}</span>}
      {rs.returns_rows && !rs.error && (
        <div className="ml-auto flex items-center gap-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="xs"><Copy /> Copy <ChevronDown className="opacity-60" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onSelect={() => void copyText(rowsToCsv(names, rs.rows), "Copied as CSV")}>As CSV</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void copyText(rowsToJson(names, rs.rows), "Copied as JSON")}>As JSON</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void copyText(rs.statement, "SQL copied")}>Statement SQL</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="xs" disabled={!conn}><Download /> Export <ChevronDown className="opacity-60" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">Re-runs the statement on the server and streams every row (no row limit).</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => exportFull("csv")}>CSV</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => exportFull("json")}>JSON</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => exportFull("sql")}>SQL INSERT statements</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}

function Notices({ notices }: { notices: string[] }) {
  if (!notices.length) return null;
  return (
    <ul className="space-y-0.5 text-left text-[11.5px] text-muted-foreground">
      {notices.map((n, i) => <li key={i} className="flex items-start gap-1.5"><Info className="mt-0.5 size-3 shrink-0" /> <span className="font-mono">{n}</span></li>)}
    </ul>
  );
}

function ErrorBox({ message, statement }: { message: string; statement?: string }) {
  return (
    <div className="h-full overflow-auto p-3">
      <div className="rounded-md border border-destructive/40 bg-destructive/8 p-3">
        <div className="flex items-start gap-2 text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <pre className="min-w-0 flex-1 font-mono text-[12px] break-words whitespace-pre-wrap">{message}</pre>
          <Button variant="ghost" size="icon-xs" onClick={() => void copyText(message, "Error copied")} aria-label="Copy error"><Copy /></Button>
        </div>
        {statement && <pre className="mt-2 max-h-32 overflow-auto border-t border-destructive/20 pt-2 font-mono text-[11.5px] whitespace-pre-wrap text-muted-foreground">{statement}</pre>}
      </div>
    </div>
  );
}

// ---------- History (recent, compact)

function RecentHistory() {
  // Re-fetch whenever a query finishes.
  const lastHistoryId = useResults((s) => Math.max(0, ...Object.values(s.runs).map((r) => r.result?.history_id ?? 0)));
  const connectionId = useConnections((s) => s.activeId);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <HistoryList key={`${lastHistoryId}:${connectionId}`} compact connectionId={connectionId ?? undefined} />
    </div>
  );
}

// ---------- Execution log

function LogPane() {
  const logs = useResults((s) => s.logs);
  const [open, setOpen] = useState<Set<number>>(new Set());
  if (!logs.length) return <Hint>Statements, saves, imports and schema changes are logged here for this session.</Hint>;
  const toggle = (id: number) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  return (
    <div className="h-full overflow-y-auto font-mono text-[11.5px]">
      {[...logs].reverse().map((l) => (
        <div key={l.id} className="border-b border-border/60">
          <button className="flex w-full items-start gap-2 px-2 py-1 text-left hover:bg-accent/40" onClick={() => l.detail && toggle(l.id)}>
            <span className="w-3 shrink-0 pt-px text-muted-foreground">{l.detail ? (open.has(l.id) ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />) : null}</span>
            <span className="shrink-0 text-muted-foreground tabular-nums">{new Date(l.at).toLocaleTimeString()}</span>
            <LevelIcon level={l.level} />
            <span className={cn("min-w-0 flex-1 break-words", l.level === "error" && "text-destructive")}>{l.message}</span>
            {l.connectionName && <span className="shrink-0 font-sans text-muted-foreground">{l.connectionName}</span>}
            {l.durationMs !== undefined && <span className="w-16 shrink-0 text-right text-muted-foreground tabular-nums">{formatDuration(l.durationMs)}</span>}
          </button>
          {l.detail && open.has(l.id) && (
            <div className="group relative mx-2 mb-1.5 ml-7">
              <pre className="max-h-48 overflow-auto rounded border bg-surface p-2 whitespace-pre-wrap text-muted-foreground">{l.detail}</pre>
              <Button variant="ghost" size="icon-xs" className="absolute top-1 right-1 opacity-0 group-hover:opacity-100" onClick={() => void copyText(l.detail!)} aria-label="Copy"><Copy /></Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function LevelIcon({ level }: { level: LogEntry["level"] }) {
  const cls = "mt-px size-3.5 shrink-0";
  if (level === "success") return <CheckCircle2 className={cn(cls, "text-success")} />;
  if (level === "error") return <AlertCircle className={cn(cls, "text-destructive")} />;
  if (level === "warning") return <AlertTriangle className={cn(cls, "text-warning")} />;
  return <Info className={cn(cls, "text-muted-foreground")} />;
}

// ---------- helpers

function Hint({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center p-4 text-center text-[12px] text-muted-foreground">{children}</div>;
}

function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [since]);
  return since === null ? 0 : Math.max(0, now - since);
}
