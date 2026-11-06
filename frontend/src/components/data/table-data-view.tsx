"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Code2, Columns3, Download, Filter, Loader2, Plus, RefreshCw,
  Save, Search, Trash2, Undo2, Upload, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, downloadExport } from "@/lib/api";
import { formatDuration, formatNumber } from "@/lib/format";
import { insertStatements } from "@/lib/sql";
import { matchesTable, onDataChanged } from "@/lib/events";
import type { CellValue, Connection, DataPage, DataRequest, FilterOp, SortSpec } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useHotkey } from "@/hooks/use-hotkey";
import { confirmAction, useUi } from "@/stores/ui";
import { useResults } from "@/stores/results";
import type { Tab } from "@/stores/workspace";
import { DataGrid, type GridColumn } from "./data-grid";
import { FilterBar, type DraftFilter } from "./filter-bar";
import { InsertRowDialog } from "./insert-row-dialog";
import { copyText } from "@/components/explorer/object-actions";

type TableTabT = Extract<Tab, { kind: "table" }>;
const PAGE_SIZES = [50, 100, 250, 500, 1000];

export function TableDataView({ tab, conn, active }: { tab: TableTabT; conn: Connection; active: boolean }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [sort, setSort] = useState<SortSpec[]>([]);
  const [draftFilters, setDraftFilters] = useState<DraftFilter[]>([]);
  const [appliedFilters, setAppliedFilters] = useState<DraftFilter[]>([]);
  const [filterMode, setFilterMode] = useState<"and" | "or">("and");
  const [showFilters, setShowFilters] = useState(false);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [hidden, setHidden] = useState<string[]>([]);
  const [data, setData] = useState<DataPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<number, Record<string, CellValue>>>({});
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [inserting, setInserting] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const reqId = useRef(0);

  const request = useMemo<DataRequest>(
    () => ({
      schema_name: tab.schema,
      table: tab.table,
      page,
      page_size: pageSize,
      sort,
      filters: appliedFilters.filter((f) => f.enabled && f.column).map(({ column, op, value }) => ({ column, op, value })),
      filter_mode: filterMode,
      search: search || null,
    }),
    [tab.schema, tab.table, page, pageSize, sort, appliedFilters, filterMode, search],
  );

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const id = ++reqId.current;
    setLoading(true);
    try {
      const res = await api.data.page(conn.id, tab.database, request, ctrl.signal);
      if (id !== reqId.current) return;
      setData(res);
      setError(null);
      setEdits({});
      setDeleted(new Set());
      setSelected(new Set());
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      if (id === reqId.current) setError((e as Error).message);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [conn.id, tab.database, request]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on request change
    void load();
  }, [load]);

  const pending = Object.keys(edits).length + deleted.size;

  // Rows changed elsewhere (import, truncate, DDL): reload unless the user has unsaved edits here.
  const pendingRef = useRef(0);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  useEffect(
    () =>
      onDataChanged((d) => {
        if (!matchesTable(d, conn.id, tab.database, tab.schema, tab.table)) return;
        if (pendingRef.current) toast.info(`${tab.table} changed`, { description: "Refresh after saving or discarding your edits." });
        else void load();
      }),
    [conn.id, tab.database, tab.schema, tab.table, load],
  );
  const columns: GridColumn[] = useMemo(
    () => (data?.columns ?? []).map((c) => ({ name: c.name, category: c.category, dataType: c.data_type, isPk: c.is_primary_key, nullable: c.nullable })),
    [data],
  );

  const keyFor = useCallback(
    (row: number): Record<string, unknown> => {
      if (!data) return {};
      return Object.fromEntries(data.primary_key.map((k) => [k, data.rows[row][data.columns.findIndex((c) => c.name === k)]]));
    },
    [data],
  );

  async function guardPending(): Promise<boolean> {
    if (!pending) return true;
    return confirmAction({ title: "Discard unsaved changes?", description: `${pending} pending change(s) will be lost.`, confirmText: "Discard", destructive: true });
  }

  async function changePage(p: number) {
    if (await guardPending()) setPage(p);
  }

  async function save() {
    if (!data || !pending) return;
    if (deleted.size) {
      const ok = await confirmAction({
        title: `Delete ${deleted.size} row(s)?`,
        description: `Rows are deleted from ${tab.table} by primary key. This cannot be undone.`,
        confirmText: "Delete and save",
        destructive: true,
      });
      if (!ok) return;
    }
    setSaving(true);
    const log = useResults.getState().log;
    try {
      const updates = Object.entries(edits)
        .filter(([r]) => !deleted.has(Number(r)))
        .map(([r, values]) => ({ key: keyFor(Number(r)), values }));
      let affected = 0;
      if (updates.length) {
        const res = await api.data.update(conn.id, tab.database, tab.schema, tab.table, updates);
        affected += res.affected;
        log({ level: "success", message: `Updated ${res.affected} row(s) in ${tab.table}`, detail: res.statements.join(";\n"), connectionName: conn.name });
      }
      if (deleted.size) {
        const res = await api.data.remove(conn.id, tab.database, tab.schema, tab.table, [...deleted].map(keyFor));
        affected += res.affected;
        log({ level: "success", message: `Deleted ${res.affected} row(s) from ${tab.table}`, detail: res.statements.join(";\n"), connectionName: conn.name });
      }
      toast.success(`Saved · ${affected} row(s) affected`);
      await load();
    } catch (e) {
      toast.error("Save failed", { description: (e as Error).message });
      log({ level: "error", message: `Save failed on ${tab.table}`, detail: (e as Error).message, connectionName: conn.name });
    } finally {
      setSaving(false);
    }
  }

  useHotkey("mod+s", () => void save(), { enabled: active });
  useHotkey("mod+f", () => setShowFilters(true), { enabled: active });
  useHotkey("mod+r", () => void guardPending().then((ok) => { if (ok) void load(); }), { enabled: active });

  function addFilter(column: string, op: FilterOp, value: CellValue) {
    const f: DraftFilter = { id: Date.now(), column, op, value: typeof value === "object" && value !== null ? JSON.stringify(value) : value, enabled: true };
    const next = [...appliedFilters, f];
    setDraftFilters(next);
    setAppliedFilters(next);
    setShowFilters(true);
    setPage(1);
  }

  const total = data?.total ?? null;
  const pages = total !== null ? Math.max(1, Math.ceil(total / pageSize)) : null;
  const from = data && data.rows.length ? (page - 1) * pageSize + 1 : 0;
  const to = data ? (page - 1) * pageSize + data.rows.length : 0;
  const activeFilterCount = appliedFilters.filter((f) => f.enabled).length;
  const editable = !!data?.editable;
  const noPkNotice = data && !data.primary_key.length && tab.objectKind === "table" && !conn.read_only;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b px-2">
        <Button variant={showFilters || activeFilterCount ? "secondary" : "ghost"} size="sm" onClick={() => {
          if (!showFilters && !draftFilters.length && data?.columns.length) setDraftFilters([{ id: Date.now(), column: data.columns[0].name, op: "eq", value: "", enabled: true }]);
          setShowFilters((v) => !v);
        }}>
          <Filter /> Filter{activeFilterCount ? <span className="rounded bg-primary/20 px-1 text-[10px] text-primary">{activeFilterCount}</span> : null}
        </Button>
        <form
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(searchDraft.trim());
            setPage(1);
          }}
        >
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={searchDraft} onChange={(e) => setSearchDraft(e.target.value)} placeholder="Search all columns" className="h-7 w-52 pl-7 text-[12px]" />
          {search && (
            <button type="button" className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground" onClick={() => { setSearch(""); setSearchDraft(""); setPage(1); }} aria-label="Clear search">
              <X className="size-3.5" />
            </button>
          )}
        </form>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm"><Columns3 /> Columns{hidden.length ? <span className="text-[10px] text-muted-foreground">({columns.length - hidden.length}/{columns.length})</span> : null}</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="max-h-96 w-56 overflow-y-auto">
            <DropdownMenuLabel className="flex items-center justify-between text-[11px]">
              Visible columns
              <button className="text-primary hover:underline" onClick={() => setHidden([])}>Show all</button>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {columns.map((c) => (
              <DropdownMenuCheckboxItem key={c.name} className="font-mono text-[12px]" checked={!hidden.includes(c.name)} onSelect={(e) => e.preventDefault()}
                onCheckedChange={(v) => setHidden((h) => (v ? h.filter((x) => x !== c.name) : [...h, c.name]))}>
                {c.name}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={() => void guardPending().then((ok) => { if (ok) void load(); })} aria-label="Refresh">
              <RefreshCw className={cn(loading && "animate-spin")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh <span className="kbd ml-1">Ctrl R</span></TooltipContent>
        </Tooltip>

        <div className="mx-1 h-4 w-px bg-border" />

        {editable && (
          <>
            <Button variant="ghost" size="sm" onClick={() => setInserting(true)}><Plus /> Row</Button>
            <Button variant="ghost" size="sm" disabled={!selected.size} onClick={() => {
              setDeleted((d) => new Set([...d, ...selected]));
              setSelected(new Set());
            }}>
              <Trash2 /> Delete{selected.size ? ` (${selected.size})` : ""}
            </Button>
          </>
        )}
        {pending > 0 && (
          <div className="flex items-center gap-1 rounded-md border border-warning/40 bg-warning/10 py-0.5 pr-0.5 pl-2 text-[12px]">
            <span>{pending} pending</span>
            <Button variant="ghost" size="xs" onClick={() => { setEdits({}); setDeleted(new Set()); }}><Undo2 /> Discard</Button>
            <Button size="xs" onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="animate-spin" /> : <Save />} Save <span className="opacity-70">Ctrl S</span>
            </Button>
          </div>
        )}

        <div className="ml-auto flex items-center gap-1">
          {!conn.read_only && tab.objectKind === "table" && (
            <Button variant="ghost" size="sm" onClick={() => useUi.getState().setImportDialog({ connectionId: conn.id, database: tab.database, schema: tab.schema, table: tab.table })}>
              <Upload /> Import
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm"><Download /> Export</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel className="text-[11px] text-muted-foreground">All rows matching current filters</DropdownMenuLabel>
              {(["csv", "json", "sql"] as const).map((f) => (
                <DropdownMenuItem key={f} onSelect={() => downloadExport({ connection_id: conn.id, database: tab.database, format: f, table: request }).catch((e) => toast.error((e as Error).message))}>
                  {f === "sql" ? "SQL INSERT statements" : f.toUpperCase()}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant={showSql ? "secondary" : "ghost"} size="icon-sm" onClick={() => setShowSql((v) => !v)} aria-label="Show SQL"><Code2 /></Button>
            </TooltipTrigger>
            <TooltipContent>Show generated SQL</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {showFilters && data && (
        <FilterBar
          columns={data.columns}
          filters={draftFilters}
          mode={filterMode}
          onChange={setDraftFilters}
          onModeChange={(m) => { setFilterMode(m); setPage(1); }}
          onApply={() => { setAppliedFilters(draftFilters); setPage(1); }}
          onClose={() => setShowFilters(false)}
        />
      )}
      {showSql && data && (
        <div className="flex items-start gap-2 border-b bg-surface px-3 py-1.5">
          <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">{data.sql}</pre>
          <Button variant="ghost" size="icon-xs" onClick={() => copyText(data.sql)} aria-label="Copy SQL"><Code2 /></Button>
        </div>
      )}
      {noPkNotice && (
        <div className="flex items-center gap-2 border-b bg-warning/8 px-3 py-1 text-[12px] text-muted-foreground">
          <AlertCircle className="size-3.5 text-warning" /> This table has no primary key, so rows are read-only here. Use the SQL editor to modify data.
        </div>
      )}

      {/* Grid */}
      <div className="relative min-h-0 flex-1">
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <AlertCircle className="size-5 text-destructive" />
            <p className="max-w-lg break-words text-destructive">{error}</p>
            <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
          </div>
        ) : !data ? (
          <GridSkeleton />
        ) : (
          <>
            <DataGrid
              columns={columns}
              rows={data.rows}
              rowNumberOffset={(page - 1) * pageSize}
              editable={editable}
              edits={edits}
              deleted={deleted}
              onEdit={(r, col, v) =>
                setEdits((e) => {
                  const rowEdits = { ...(e[r] ?? {}) };
                  if (v === undefined) delete rowEdits[col];
                  else rowEdits[col] = v;
                  const next = { ...e, [r]: rowEdits };
                  if (!Object.keys(rowEdits).length) delete next[r];
                  return next;
                })
              }
              selected={selected}
              onSelectedChange={setSelected}
              sort={sort}
              onSortChange={async (s) => { if (await guardPending()) { setSort(s); setPage(1); } }}
              onFilterValue={addFilter}
              onDeleteRows={(rows) => setDeleted((d) => new Set([...d, ...rows]))}
              onRevertRows={(rows) => {
                setEdits((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !rows.includes(Number(k)))));
                setDeleted((d) => new Set([...d].filter((x) => !rows.includes(x))));
              }}
              insertSql={(rows) => insertStatements(conn, tab.schema, tab.table, data.columns, rows.map((r) => data.rows[r]))}
              hidden={hidden}
              onHide={(c) => setHidden((h) => [...h, c])}
              storageKey={`${conn.id}:${tab.database}:${tab.schema}:${tab.table}`}
              empty={activeFilterCount || search ? "No rows match the current filters" : "This table is empty"}
            />
            {loading && <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 animate-pulse bg-primary/60" />}
          </>
        )}
      </div>

      {/* Footer / pagination */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-t bg-surface px-2 text-[11.5px] text-muted-foreground">
        <span className="tabular-nums">
          {data ? (
            <>
              {formatNumber(from)}–{formatNumber(to)} of {total !== null ? `${data.total_is_estimate ? "~" : ""}${formatNumber(total)}` : "?"} rows
            </>
          ) : (
            "Loading…"
          )}
        </span>
        {data && <span>· {formatDuration(data.duration_ms)}</span>}
        <div className="ml-auto flex items-center gap-1">
          <Select value={String(pageSize)} onValueChange={async (v) => { if (await guardPending()) { setPageSize(Number(v)); setPage(1); } }}>
            <SelectTrigger size="sm" className="h-6 w-[92px] text-[11px]"><SelectValue /></SelectTrigger>
            <SelectContent>{PAGE_SIZES.map((s) => <SelectItem key={s} value={String(s)} className="text-[12px]">{s} / page</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="ghost" size="icon-xs" disabled={page <= 1} onClick={() => void changePage(1)} aria-label="First page"><ChevronsLeft /></Button>
          <Button variant="ghost" size="icon-xs" disabled={page <= 1} onClick={() => void changePage(page - 1)} aria-label="Previous page"><ChevronLeft /></Button>
          <PageInput page={page} pages={pages} onChange={(p) => void changePage(p)} />
          <Button variant="ghost" size="icon-xs" disabled={pages !== null ? page >= pages : (data?.rows.length ?? 0) < pageSize} onClick={() => void changePage(page + 1)} aria-label="Next page"><ChevronRight /></Button>
          <Button variant="ghost" size="icon-xs" disabled={pages === null || page >= pages} onClick={() => pages && void changePage(pages)} aria-label="Last page"><ChevronsRight /></Button>
        </div>
      </div>

      <InsertRowDialog
        open={inserting}
        onOpenChange={setInserting}
        columns={data?.columns ?? []}
        title={`Insert into ${tab.table}`}
        onSubmit={async (row) => {
          try {
            const res = await api.data.insert(conn.id, tab.database, tab.schema, tab.table, [row]);
            toast.success(`Inserted ${res.affected} row`);
            useResults.getState().log({ level: "success", message: `Inserted row into ${tab.table}`, detail: res.statements.join("\n"), connectionName: conn.name });
            await load();
          } catch (e) {
            toast.error("Insert failed", { description: (e as Error).message });
            throw e;
          }
        }}
      />
    </div>
  );
}

function PageInput({ page, pages, onChange }: { page: number; pages: number | null; onChange: (p: number) => void }) {
  const [v, setV] = useState(String(page));
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mirror external page into the input
    setV(String(page));
  }, [page]);
  return (
    <span className="flex items-center gap-1">
      <input
        value={v}
        onChange={(e) => setV(e.target.value.replace(/\D/g, ""))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const n = Math.max(1, Math.min(pages ?? Infinity, Number(v) || 1));
            onChange(n);
          }
        }}
        className="h-5 w-10 rounded border bg-background text-center text-[11px] tabular-nums outline-none focus:ring-1 focus:ring-ring"
        aria-label="Page"
      />
      {pages !== null && <span>/ {formatNumber(pages)}</span>}
    </span>
  );
}

export function GridSkeleton() {
  return (
    <div className="space-y-px p-0">
      <Skeleton className="h-[30px] rounded-none" />
      {Array.from({ length: 14 }).map((_, i) => (
        <div key={i} className="flex gap-px">
          {[52, 140, 200, 120, 220, 160].map((w, j) => <Skeleton key={j} className="h-[25px] rounded-none opacity-50" style={{ width: w }} />)}
        </div>
      ))}
    </div>
  );
}
