"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, Braces, ChevronRight, Columns3, Copy, Database, Download, Eye, FileCode2, FolderTree, Hash, Key,
  LayoutDashboard, Layers, Loader2, Plus, RefreshCw, Scissors, SquareFunction, SquareTerminal, Table2, Trash2, Upload, Workflow, Zap,
} from "lucide-react";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { onObjectsChanged } from "@/lib/events";
import { formatNumber } from "@/lib/format";
import type { ColumnInfo, Connection, DbObject, ObjectKind, SchemaInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useConnections } from "@/stores/connections";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import {
  copyText, dropObject, exportObject, generateSelect, openData, openDefinition, openStructure, qualified, truncateObject, type ObjectRef,
} from "./object-actions";

type Loadable<T> = { state: "loading" } | { state: "error"; error: string } | { state: "ready"; data: T };

interface TreeCtx {
  conn: Connection;
  filter: string;
  cache: Record<string, Loadable<unknown>>;
  expanded: Set<string>;
  toggle: (key: string, open?: boolean) => void;
  load: <T>(key: string, fn: () => Promise<T>, force?: boolean) => void;
  refresh: (prefix: string) => void;
}

const Ctx = createContext<TreeCtx | null>(null);
const useTree = () => useContext(Ctx)!;

const GROUPS: { kind: ObjectKind; label: string; icon: React.ElementType }[] = [
  { kind: "table", label: "Tables", icon: Table2 },
  { kind: "view", label: "Views", icon: Eye },
  { kind: "materialized_view", label: "Materialized views", icon: Layers },
  { kind: "function", label: "Functions", icon: SquareFunction },
  { kind: "procedure", label: "Procedures", icon: Workflow },
  { kind: "sequence", label: "Sequences", icon: Hash },
  { kind: "trigger", label: "Triggers", icon: Zap },
];

export function ExplorerTree({ connection, filter }: { connection: Connection; filter: string }) {
  const status = useConnections((s) => s.status[connection.id]);
  const [cache, setCache] = useState<Record<string, Loadable<unknown>>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const inflight = useRef(new Set<string>());

  const cacheRef = useRef(cache);
  const update = useCallback((fn: (c: Record<string, Loadable<unknown>>) => Record<string, Loadable<unknown>>) => {
    cacheRef.current = fn(cacheRef.current);
    setCache(cacheRef.current);
  }, []);

  const load = useCallback(<T,>(key: string, fn: () => Promise<T>, force = false) => {
    if (inflight.current.has(key) || (cacheRef.current[key] && !force)) return;
    inflight.current.add(key);
    update((c) => ({ ...c, [key]: { state: "loading" } }));
    fn()
      .then((data) => update((x) => ({ ...x, [key]: { state: "ready", data } })))
      .catch((e) => update((x) => ({ ...x, [key]: { state: "error", error: (e as Error).message } })))
      .finally(() => inflight.current.delete(key));
  }, [update]);

  const toggle = useCallback((key: string, open?: boolean) => {
    setExpanded((s) => {
      const n = new Set(s);
      const willOpen = open ?? !n.has(key);
      if (willOpen) n.add(key);
      else n.delete(key);
      return n;
    });
  }, []);

  const refresh = useCallback((prefix: string) => {
    update((c) => Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith(prefix))));
    useConnections.getState().invalidateCatalog(connection.id);
  }, [connection.id, update]);

  // DDL applied elsewhere (structure view, create table, drop): reload object lists for this connection.
  useEffect(
    () =>
      onObjectsChanged((d) => {
        if (d.connectionId !== connection.id) return;
        update((c) => Object.fromEntries(Object.entries(c).filter(([k]) => !k.endsWith("|objects") && !k.includes("|cols:"))));
      }),
    [connection.id, update],
  );

  const ctx = useMemo(() => ({ conn: connection, filter: filter.trim().toLowerCase(), cache, expanded, toggle, load, refresh }), [connection, filter, cache, expanded, toggle, load, refresh]);

  if (status === "connecting" || status === undefined) return <TreeSkeleton />;
  if (status === "error") {
    return (
      <div className="px-3 py-6 text-center">
        <AlertCircle className="mx-auto size-5 text-destructive" />
        <p className="mt-2 font-medium">Connection failed</p>
        <p className="mt-1 text-[12px] break-words text-muted-foreground">{useConnections.getState().errors[connection.id]}</p>
        <button className="mt-3 text-[12px] text-primary hover:underline" onClick={() => void useConnections.getState().connect(connection.id)}>
          Retry
        </button>
      </div>
    );
  }
  if (status === "idle") {
    return (
      <div className="px-3 py-6 text-center text-muted-foreground">
        Disconnected.{" "}
        <button className="text-primary hover:underline" onClick={() => void useConnections.getState().connect(connection.id)}>Connect</button>
      </div>
    );
  }

  return (
    <Ctx.Provider value={ctx}>
      <div role="tree" className="select-none">
        {connection.capabilities.multiple_databases ? <DatabaseList /> : <ObjectGroups database={null} schema={null} depth={0} />}
      </div>
    </Ctx.Provider>
  );
}

function TreeSkeleton() {
  return (
    <div className="space-y-1.5 px-3 py-2">
      {[70, 55, 80, 45, 60].map((w, i) => <Skeleton key={i} className="h-4" style={{ width: `${w}%` }} />)}
    </div>
  );
}

function DatabaseList() {
  const { conn, cache, load, toggle, expanded } = useTree();
  const key = "dbs";
  // Re-runs when the entry is evicted by a refresh, not only on mount.
  const missing = !cache[key];
  useEffect(() => {
    if (missing) load(key, () => api.explorer.databases(conn.id));
  }, [conn.id, load, missing]);
  const entry = cache[key] as Loadable<SchemaInfo[]> | undefined;

  // Expand the connection's default database once loaded.
  const didAuto = useRef(false);
  useEffect(() => {
    if (didAuto.current || entry?.state !== "ready") return;
    didAuto.current = true;
    const def = conn.database ?? (entry.data.find((d) => !d.is_system) ?? entry.data[0])?.name;
    if (def && !expanded.has(`db:${def}`)) toggle(`db:${def}`, true);
  }, [entry, conn.database, toggle, expanded]);

  if (!entry || entry.state === "loading") return <TreeSkeleton />;
  if (entry.state === "error") return <TreeError error={entry.error} onRetry={() => load(key, () => api.explorer.databases(conn.id), true)} />;
  const user = entry.data.filter((d) => !d.is_system);
  const system = entry.data.filter((d) => d.is_system);
  return (
    <>
      {[...user, ...system].map((d) => <DatabaseNode key={d.name} db={d} />)}
    </>
  );
}

function DatabaseNode({ db }: { db: SchemaInfo }) {
  const { conn, expanded, toggle, refresh } = useTree();
  const key = `db:${db.name}`;
  const open = expanded.has(key);
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Row depth={0} open={open} expandable onClick={() => toggle(key)} icon={<Database className={cn("text-muted-foreground", db.is_system && "opacity-50")} />}>
            <span className={cn(db.is_system && "text-muted-foreground")}>{db.name}</span>
          </Row>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem onSelect={() => useWorkspace.getState().openQuery(conn.id, db.name)}><SquareTerminal /> New query</ContextMenuItem>
          <ContextMenuItem onSelect={() => useWorkspace.getState().open({ id: `dashboard:${conn.id}:${db.name}`, kind: "dashboard", connectionId: conn.id, database: db.name })}>
            <LayoutDashboard /> Overview
          </ContextMenuItem>
          {!conn.capabilities.schemas && (
            <ContextMenuItem onSelect={() => useUi.getState().setCreateTable({ connectionId: conn.id, database: db.name, schema: null })}><Plus /> Create table…</ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => copyText(db.name)}><Copy /> Copy name</ContextMenuItem>
          <ContextMenuItem onSelect={() => refresh(`${key}`)}><RefreshCw /> Refresh</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {open && (conn.capabilities.schemas ? <SchemaList database={db.name} /> : <ObjectGroups database={db.name} schema={null} depth={1} />)}
    </>
  );
}

function SchemaList({ database }: { database: string }) {
  const { conn, cache, load, toggle, expanded, filter } = useTree();
  const key = `db:${database}|schemas`;
  // Re-runs when the entry is evicted by a refresh, not only on mount.
  const missing = !cache[key];
  useEffect(() => {
    if (missing) load(key, () => api.explorer.schemas(conn.id, database));
  }, [conn.id, database, key, load, missing]);
  const entry = cache[key] as Loadable<SchemaInfo[]> | undefined;
  const didAuto = useRef(false);
  useEffect(() => {
    if (didAuto.current || entry?.state !== "ready") return;
    didAuto.current = true;
    const def = entry.data.find((s) => s.name === "public") ?? entry.data.find((s) => !s.is_system);
    if (def) toggle(`db:${database}|sc:${def.name}`, true);
  }, [entry, database, toggle]);
  const [showSystem, setShowSystem] = useState(false);

  if (!entry || entry.state === "loading") return <LoadingRow depth={1} />;
  if (entry.state === "error") return <TreeError depth={1} error={entry.error} onRetry={() => load(key, () => api.explorer.schemas(conn.id, database), true)} />;
  const user = entry.data.filter((s) => !s.is_system);
  const system = entry.data.filter((s) => s.is_system);
  return (
    <>
      {user.map((s) => <SchemaNode key={s.name} database={database} schema={s} open={expanded.has(`db:${database}|sc:${s.name}`) || !!filter} />)}
      {system.length > 0 && (
        <>
          <Row depth={1} onClick={() => setShowSystem((v) => !v)} expandable open={showSystem} icon={<FolderTree className="text-muted-foreground/60" />}>
            <span className="text-muted-foreground">System schemas</span>
          </Row>
          {showSystem && system.map((s) => <SchemaNode key={s.name} database={database} schema={s} depth={2} open={expanded.has(`db:${database}|sc:${s.name}`)} />)}
        </>
      )}
    </>
  );
}

function SchemaNode({ database, schema, open, depth = 1 }: { database: string; schema: SchemaInfo; open: boolean; depth?: number }) {
  const { conn, toggle, refresh } = useTree();
  const key = `db:${database}|sc:${schema.name}`;
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Row depth={depth} open={open} expandable onClick={() => toggle(key)} icon={<Braces className="text-muted-foreground" />}>
            {schema.name}
          </Row>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem onSelect={() => useWorkspace.getState().openQuery(conn.id, database, `SET search_path TO ${schema.name};\n\n`)}><SquareTerminal /> New query</ContextMenuItem>
          <ContextMenuItem onSelect={() => useUi.getState().setCreateTable({ connectionId: conn.id, database, schema: schema.name })}><Plus /> Create table…</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => copyText(schema.name)}><Copy /> Copy name</ContextMenuItem>
          <ContextMenuItem onSelect={() => refresh(key)}><RefreshCw /> Refresh</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {open && <ObjectGroups database={database} schema={schema.name} depth={depth + 1} />}
    </>
  );
}

function ObjectGroups({ database, schema, depth }: { database: string | null; schema: string | null; depth: number }) {
  const { conn, cache, load, filter } = useTree();
  const key = `db:${database ?? ""}|sc:${schema ?? ""}|objects`;
  const fetcher = useCallback(() => api.explorer.objects(conn.id, database, schema), [conn.id, database, schema]);
  // Re-runs when the entry is evicted by a refresh, not only on mount.
  const missing = !cache[key];
  useEffect(() => {
    if (missing) load(key, fetcher);
  }, [key, fetcher, load, missing]);
  const entry = cache[key] as Loadable<DbObject[]> | undefined;
  if (!entry || entry.state === "loading") return <LoadingRow depth={depth} />;
  if (entry.state === "error") return <TreeError depth={depth} error={entry.error} onRetry={() => load(key, fetcher, true)} />;
  const objects = filter ? entry.data.filter((o) => o.name.toLowerCase().includes(filter)) : entry.data;
  const groups = GROUPS.filter((g) => objects.some((o) => o.kind === g.kind) || (!filter && g.kind === "table"));
  if (filter && !objects.length) return <div className="py-1 text-[12px] text-muted-foreground" style={{ paddingLeft: 12 + depth * 12 }}>No matches</div>;
  return (
    <>
      {groups.map((g) => (
        <ObjectGroup key={g.kind} database={database} schema={schema} depth={depth} group={g} objects={objects.filter((o) => o.kind === g.kind)} />
      ))}
    </>
  );
}

function ObjectGroup({ database, schema, depth, group, objects }: { database: string | null; schema: string | null; depth: number; group: (typeof GROUPS)[number]; objects: DbObject[] }) {
  const { expanded, toggle, filter } = useTree();
  const key = `db:${database ?? ""}|sc:${schema ?? ""}|grp:${group.kind}`;
  // Tables start expanded; other groups start collapsed. Explicit user choices win; filtering expands matches.
  const userOpen = expanded.has(key) ? true : expanded.has(`${key}:closed`) ? false : group.kind === "table";
  const isOpen = userOpen || (!!filter && objects.length > 0);
  const Icon = group.icon;
  return (
    <>
      <Row
        depth={depth}
        open={isOpen}
        expandable
        onClick={() => {
          if (isOpen) {
            toggle(key, false);
            toggle(`${key}:closed`, true);
          } else {
            toggle(key, true);
            toggle(`${key}:closed`, false);
          }
        }}
        icon={<Icon className="text-muted-foreground" />}
        trailing={<span className="text-[11px] text-muted-foreground tabular-nums">{objects.length}</span>}
      >
        <span className="text-muted-foreground">{group.label}</span>
      </Row>
      {isOpen && (objects.length ? objects.map((o) => <ObjectNode key={`${o.kind}:${o.name}:${String(o.extra?.arguments ?? "")}`} obj={o} database={database} schema={schema} depth={depth + 1} />) : (
        <div className="py-1 text-[12px] text-muted-foreground/70 italic" style={{ paddingLeft: 26 + (depth + 1) * 12 }}>None</div>
      ))}
    </>
  );
}

function ObjectNode({ obj, database, schema, depth }: { obj: DbObject; database: string | null; schema: string | null; depth: number }) {
  const { conn, expanded, toggle, refresh, filter } = useTree();
  const ref: ObjectRef = { conn, database, schema, name: obj.name, kind: obj.kind };
  const isRelation = obj.kind === "table" || obj.kind === "view" || obj.kind === "materialized_view";
  const key = `db:${database ?? ""}|sc:${schema ?? ""}|obj:${obj.kind}:${obj.name}`;
  const open = expanded.has(key);
  const group = GROUPS.find((g) => g.kind === obj.kind)!;
  const Icon = group.icon;
  const refreshParent = () => refresh(`db:${database ?? ""}|sc:${schema ?? ""}|objects`);
  const label = filter ? highlight(obj.name, filter) : obj.name;

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Row
            depth={depth}
            expandable={isRelation}
            open={open}
            onChevron={() => toggle(key)}
            onClick={() => (isRelation ? openData(ref) : void openDefinition(ref))}
            icon={<Icon className={cn(obj.kind === "table" ? "text-brand/80" : "text-muted-foreground")} />}
            title={obj.comment ?? (obj.extra?.arguments !== undefined ? `${obj.name}(${String(obj.extra.arguments)})` : obj.name)}
            trailing={obj.row_estimate !== null && obj.row_estimate !== undefined ? <span className="text-[10px] text-muted-foreground/70 tabular-nums">{compact(obj.row_estimate)}</span> : null}
          >
            {label}
            {obj.kind === "function" && obj.extra?.arguments !== undefined && <span className="text-muted-foreground/70">({String(obj.extra.arguments)})</span>}
          </Row>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          {isRelation ? (
            <>
              <ContextMenuItem onSelect={() => openData(ref)}><Table2 /> Open data</ContextMenuItem>
              <ContextMenuItem onSelect={() => openStructure(ref)}><Columns3 /> View structure</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => generateSelect(ref)}><SquareTerminal /> Generate SELECT</ContextMenuItem>
              <ContextMenuItem onSelect={() => void openDefinition(ref)}><FileCode2 /> Generate CREATE</ContextMenuItem>
              <ContextMenuItem onSelect={() => copyText(obj.name)}><Copy /> Copy name</ContextMenuItem>
              <ContextMenuItem onSelect={() => copyText(qualified(ref))}><Copy /> Copy qualified name</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuSub>
                <ContextMenuSubTrigger><Download /> Export</ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  <ContextMenuItem onSelect={() => exportObject(ref, "csv")}>CSV</ContextMenuItem>
                  <ContextMenuItem onSelect={() => exportObject(ref, "json")}>JSON</ContextMenuItem>
                  <ContextMenuItem onSelect={() => exportObject(ref, "sql")}>SQL INSERT statements</ContextMenuItem>
                </ContextMenuSubContent>
              </ContextMenuSub>
              {obj.kind === "table" && !conn.read_only && (
                <ContextMenuItem onSelect={() => useUi.getState().setImportDialog({ connectionId: conn.id, database, schema, table: obj.name })}><Upload /> Import data…</ContextMenuItem>
              )}
              <ContextMenuItem onSelect={refreshParent}><RefreshCw /> Refresh</ContextMenuItem>
              {!conn.read_only && (
                <>
                  <ContextMenuSeparator />
                  {obj.kind === "table" && <ContextMenuItem variant="destructive" onSelect={() => truncateObject(ref)}><Scissors /> Truncate…</ContextMenuItem>}
                  <ContextMenuItem variant="destructive" onSelect={() => dropObject(ref, refreshParent)}><Trash2 /> Drop…</ContextMenuItem>
                </>
              )}
            </>
          ) : (
            <>
              <ContextMenuItem onSelect={() => void openDefinition(ref)}><FileCode2 /> View definition</ContextMenuItem>
              <ContextMenuItem onSelect={() => copyText(obj.name)}><Copy /> Copy name</ContextMenuItem>
              {obj.kind === "trigger" && typeof obj.extra?.table === "string" && (
                <ContextMenuItem onSelect={() => openStructure({ ...ref, name: obj.extra.table as string, kind: "table" })}><Table2 /> Open table {String(obj.extra.table)}</ContextMenuItem>
              )}
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {open && isRelation && <ColumnList database={database} schema={schema} table={obj.name} depth={depth + 1} />}
    </>
  );
}

function ColumnList({ database, schema, table, depth }: { database: string | null; schema: string | null; table: string; depth: number }) {
  const { conn, cache, load } = useTree();
  const key = `db:${database ?? ""}|sc:${schema ?? ""}|cols:${table}`;
  const fetcher = useCallback(() => api.explorer.structure(conn.id, database, schema, table).then((s) => s.columns), [conn.id, database, schema, table]);
  // Re-runs when the entry is evicted by a refresh, not only on mount.
  const missing = !cache[key];
  useEffect(() => {
    if (missing) load(key, fetcher);
  }, [key, fetcher, load, missing]);
  const entry = cache[key] as Loadable<ColumnInfo[]> | undefined;
  if (!entry || entry.state === "loading") return <LoadingRow depth={depth} />;
  if (entry.state === "error") return <TreeError depth={depth} error={entry.error} onRetry={() => load(key, fetcher, true)} />;
  return (
    <>
      {entry.data.map((c) => (
        <Row key={c.name} depth={depth} icon={c.is_primary_key ? <Key className="text-warning" /> : <span className="size-3.5" />}
          onClick={() => copyText(c.name, `Copied ${c.name}`)} title={`${c.name} ${c.data_type}${c.nullable ? "" : " NOT NULL"}`}
          trailing={<span className="max-w-24 truncate font-mono text-[10px] text-muted-foreground/80">{c.data_type}</span>}>
          <span className={cn(c.nullable ? "" : "font-medium")}>{c.name}</span>
        </Row>
      ))}
    </>
  );
}

function Row({
  depth, open, expandable, onClick, onChevron, icon, trailing, title, children, ...rest
}: {
  depth: number; open?: boolean; expandable?: boolean; onClick?: () => void; onChevron?: () => void; icon?: React.ReactNode; trailing?: React.ReactNode; title?: string; children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "onClick" | "title">) {
  return (
    <div
      {...rest}
      role="treeitem"
      aria-selected={false}
      aria-expanded={expandable ? !!open : undefined}
      tabIndex={0}
      title={title}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter") onClick?.();
        if (e.key === "ArrowRight" && expandable && !open) (onChevron ?? onClick)?.();
        if (e.key === "ArrowLeft" && expandable && open) (onChevron ?? onClick)?.();
      }}
      className="group/row flex h-[24px] cursor-default items-center gap-1 pr-2 text-[12.5px] outline-none hover:bg-accent/60 focus-visible:bg-accent data-[state=open]:bg-accent"
      style={{ paddingLeft: 6 + depth * 12 }}
    >
      <span
        className={cn("flex size-4 shrink-0 items-center justify-center text-muted-foreground", !expandable && "invisible")}
        onClick={(e) => {
          if (onChevron) {
            e.stopPropagation();
            onChevron();
          }
        }}
      >
        <ChevronRight className={cn("size-3 transition-transform duration-150", open && "rotate-90")} />
      </span>
      <span className="flex shrink-0 items-center [&_svg]:size-3.5">{icon}</span>
      <span className="min-w-0 flex-1 truncate pl-0.5">{children}</span>
      {trailing}
    </div>
  );
}

function LoadingRow({ depth }: { depth: number }) {
  return (
    <div className="flex h-[24px] items-center gap-1.5 text-[12px] text-muted-foreground" style={{ paddingLeft: 26 + depth * 12 }}>
      <Loader2 className="size-3 animate-spin" /> Loading…
    </div>
  );
}

function TreeError({ error, onRetry, depth = 0 }: { error: string; onRetry: () => void; depth?: number }) {
  return (
    <div className="py-1 pr-2 text-[12px]" style={{ paddingLeft: 26 + depth * 12 }}>
      <span className="text-destructive">{error}</span>{" "}
      <button className="text-primary hover:underline" onClick={onRetry}>Retry</button>
    </div>
  );
}

function highlight(text: string, q: string) {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-[2px] bg-warning/30 text-foreground">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return formatNumber(Math.round(n / 100_000) / 10) + "M";
}
