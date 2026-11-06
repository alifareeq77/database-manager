"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Database, Gauge, HardDrive, Layers, RefreshCw, Table2, Users, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { formatBytes, formatDuration, formatNumber } from "@/lib/format";
import type { Connection, DashboardData, MetricValue } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useWorkspace, type Tab } from "@/stores/workspace";
import { Breadcrumb } from "@/components/data/table-tab";
import { EngineBadge } from "@/components/connections/engine-icon";

type DashboardTab = Extract<Tab, { kind: "dashboard" }>;

export function DashboardView({ tab, conn, active }: { tab: DashboardTab; conn: Connection; active: boolean }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.explorer.dashboard(conn.id, tab.database));
      setError(null);
      setLoadedAt(Date.now());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [conn.id, tab.database]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount / target change
    void load();
  }, [load]);

  // Refresh when the tab comes back into view after being stale for a while.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refetch when a stale tab is reactivated
    if (active && loadedAt && Date.now() - loadedAt > 60_000) void load();
  }, [active, loadedAt, load]);

  const openTable = (schema: string | null, name: string) =>
    useWorkspace.getState().openTable({ connectionId: conn.id, database: tab.database, schema, table: name, objectKind: "table", view: "structure" });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <Breadcrumb parts={[conn.name, tab.database, "Overview"].filter(Boolean) as string[]} color={conn.color} />
        <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
          {loadedAt && <span>Updated {new Date(loadedAt).toLocaleTimeString()}</span>}
          <Button variant="ghost" size="sm" onClick={() => void load()}><RefreshCw className={cn(loading && "animate-spin")} /> Refresh</Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && !data ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <AlertCircle className="size-5 text-destructive" />
            <p className="max-w-lg break-words text-destructive">{error}</p>
            <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
          </div>
        ) : !data ? (
          <DashboardSkeleton />
        ) : (
          <div className="mx-auto max-w-6xl space-y-5 p-4 pb-10">
            {/* Server header */}
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-lg border bg-surface">
                <EngineBadge engine={data.engine} color={conn.color} className="size-7 text-[11px]" />
              </div>
              <div className="min-w-0">
                <h2 className="truncate text-[15px] font-semibold">{conn.name}</h2>
                <p className="truncate text-[12px] text-muted-foreground" title={data.version}>
                  {data.version}
                  {data.database ? <> · <span className="font-mono">{data.database}</span></> : null}
                </p>
              </div>
            </div>

            {/* Stat tiles */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <Stat icon={HardDrive} label="Database size" metric={data.database_size_bytes} format={formatBytes} />
              <Stat icon={Table2} label="Tables" metric={data.table_count} format={formatNumber} />
              <Stat icon={Layers} label={conn.engine === "mysql" ? "Databases" : "Schemas"} metric={data.schema_count} format={formatNumber} />
              <Stat icon={Users} label="Active connections" metric={data.active_connections} format={formatNumber} />
              <Stat icon={Gauge} label="Round-trip latency" metric={{ available: true, value: data.latency_ms, note: null }} format={(v) => formatDuration(v)} />
            </div>

            {/* Insights */}
            {data.insights.length > 0 && (
              <Panel title="Health">
                <ul className="divide-y">
                  {data.insights.map((ins, i) => (
                    <li key={i} className="flex items-center gap-3 px-3 py-2 text-[12.5px]">
                      {ins.level === "warn" ? <AlertTriangle className="size-3.5 shrink-0 text-warning" /> : <CheckCircle2 className="size-3.5 shrink-0 text-success" />}
                      <span className="min-w-0 flex-1">
                        {ins.label}
                        {ins.note && <span className="block text-[11.5px] text-muted-foreground">{ins.note}</span>}
                      </span>
                      <span className="font-mono tabular-nums">{insightValue(ins.value, ins.format)}</span>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}

            <div className="grid gap-5 lg:grid-cols-2">
              {/* Largest tables */}
              <Panel title="Largest tables" empty={!data.largest_tables.length && "No tables yet."}>
                <SizeBars
                  rows={data.largest_tables.map((t) => ({
                    key: `${t.schema_name}.${t.name}`,
                    label: t.schema_name && data.engine === "postgresql" && t.schema_name !== "public" ? `${t.schema_name}.${t.name}` : t.name,
                    value: t.total_bytes,
                    split: t.table_bytes !== null && t.index_bytes !== null ? [t.table_bytes, t.index_bytes] : null,
                    meta: t.row_estimate !== null ? `~${formatNumber(t.row_estimate)} rows` : null,
                    onClick: () => openTable(t.schema_name, t.name),
                  }))}
                  legend={data.largest_tables.some((t) => t.index_bytes !== null) ? ["Data", "Indexes"] : null}
                />
              </Panel>

              {/* Largest indexes */}
              <Panel title="Largest indexes" empty={!data.largest_indexes.length && "No index size information."}>
                <SizeBars
                  rows={data.largest_indexes.map((ix) => ({
                    key: `${ix.schema_name}.${ix.table}.${ix.name}`,
                    label: ix.name,
                    value: ix.size_bytes,
                    split: null,
                    meta: ix.table,
                    onClick: () => openTable(ix.schema_name, ix.table),
                  }))}
                  legend={null}
                />
              </Panel>
            </div>

            {/* Top queries */}
            <Panel title="Top queries by total time" icon={Zap}>
              {!data.recent_queries.available || !data.recent_queries.value ? (
                <p className="px-3 py-3 text-[12px] text-muted-foreground">{data.recent_queries.note ?? "Query statistics are not available for this engine."}</p>
              ) : data.recent_queries.value.length === 0 ? (
                <p className="px-3 py-3 text-[12px] text-muted-foreground">No statements recorded yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead className="text-[11px] text-muted-foreground">
                      <tr className="[&>th]:px-3 [&>th]:py-1.5 [&>th]:text-left [&>th]:font-medium">
                        <th>Query</th><th className="text-right!">Calls</th><th className="text-right!">Total</th><th className="text-right!">Mean</th><th className="text-right!">Rows</th>
                      </tr>
                    </thead>
                    <tbody className="[&>tr]:border-t [&>tr>td]:px-3 [&>tr>td]:py-1.5">
                      {data.recent_queries.value.map((q, i) => (
                        <tr key={i} className="hover:bg-accent/40">
                          <td className="max-w-0 w-full">
                            <button
                              className="block w-full truncate text-left font-mono hover:text-primary"
                              title="Open in a new query tab"
                              onClick={() => useWorkspace.getState().openQuery(conn.id, tab.database, q.query, "Top query")}
                            >
                              {q.query}
                            </button>
                          </td>
                          <td className="text-right tabular-nums">{formatNumber(q.calls)}</td>
                          <td className="text-right whitespace-nowrap tabular-nums">{formatDuration(q.total_ms)}</td>
                          <td className="text-right whitespace-nowrap tabular-nums">{formatDuration(q.mean_ms)}</td>
                          <td className="text-right tabular-nums">{formatNumber(q.rows)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}

function insightValue(v: unknown, format?: "bytes"): string {
  if (v === null || v === undefined) return "—";
  if (format === "bytes" && typeof v === "number") return formatBytes(v);
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

function Stat<T>({ icon: Icon, label, metric, format }: { icon: React.ElementType; label: string; metric: MetricValue<T>; format: (v: number) => string }) {
  const body = (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </div>
      <div className={cn("mt-1.5 text-[20px] font-semibold tracking-tight tabular-nums", !metric.available && "text-muted-foreground")}>
        {metric.available && typeof metric.value === "number" ? format(metric.value) : "—"}
      </div>
    </div>
  );
  if (!metric.note) return body;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent className="max-w-64">{metric.note}</TooltipContent>
    </Tooltip>
  );
}

function Panel({ title, icon: Icon = Database, empty, children }: { title: string; icon?: React.ElementType; empty?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center gap-1.5 border-b px-3 py-2 text-[12px] font-semibold">
        <Icon className="size-3.5 text-muted-foreground" /> {title}
      </div>
      {empty ? <p className="px-3 py-3 text-[12px] text-muted-foreground">{empty}</p> : children}
    </section>
  );
}

interface BarRow {
  key: string;
  label: string;
  value: number | null;
  split: [number, number] | null;
  meta: string | null;
  onClick: () => void;
}

function SizeBars({ rows, legend }: { rows: BarRow[]; legend: [string, string] | null }) {
  const max = Math.max(1, ...rows.map((r) => r.value ?? 0));
  return (
    <div className="py-1">
      {legend && (
        <div className="flex gap-3 px-3 pt-1 pb-0.5 text-[10.5px] text-muted-foreground">
          <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-primary" /> {legend[0]}</span>
          <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-primary/40" /> {legend[1]}</span>
        </div>
      )}
      {rows.map((r) => {
        const total = r.value ?? 0;
        const pct = (total / max) * 100;
        const dataPct = r.split && total ? (r.split[0] / total) * 100 : 100;
        return (
          <button key={r.key} onClick={r.onClick} className="group block w-full px-3 py-1.5 text-left hover:bg-accent/40">
            <div className="flex items-baseline gap-2 text-[12px]">
              <span className="min-w-0 flex-1 truncate font-mono group-hover:text-primary">{r.label}</span>
              {r.meta && <span className="shrink-0 text-[11px] text-muted-foreground">{r.meta}</span>}
              <span className="w-16 shrink-0 text-right tabular-nums">{formatBytes(r.value)}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="flex h-full" style={{ width: `${pct}%` }}>
                <div className="h-full bg-primary" style={{ width: `${dataPct}%` }} />
                <div className="h-full flex-1 bg-primary/40" />
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4">
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-lg" />
        <div className="space-y-1.5"><Skeleton className="h-4 w-40" /><Skeleton className="h-3 w-64" /></div>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[74px] rounded-lg" />)}</div>
      <div className="grid gap-5 lg:grid-cols-2"><Skeleton className="h-56 rounded-lg" /><Skeleton className="h-56 rounded-lg" /></div>
    </div>
  );
}
