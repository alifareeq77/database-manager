"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import {
  Bookmark, Clock, Eye, History, LayoutDashboard, Moon, PanelBottom, PanelLeft, Plug, Plus, ScrollText, SquareTerminal, Table2,
} from "lucide-react";
import {
  Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut,
} from "@/components/ui/command";
import { api } from "@/lib/api";
import type { CatalogTable, SavedQuery } from "@/lib/types";
import { useConnections } from "@/stores/connections";
import { useResults } from "@/stores/results";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { modKey } from "@/hooks/use-hotkey";
import { EngineBadge } from "@/components/connections/engine-icon";

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPalette);
  const { connections, activeId } = useConnections();
  const active = connections.find((c) => c.id === activeId);
  const recentTables = useWorkspace((s) => s.recentTables);
  const { theme, setTheme } = useTheme();
  const [tables, setTables] = useState<CatalogTable[]>([]);
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const status = useConnections((s) => (activeId ? s.status[activeId] : undefined));

  useEffect(() => {
    if (!open) return;
    api.saved.list().then(setSaved).catch(() => setSaved([]));
    if (active && status === "connected") {
      useConnections.getState().loadCatalog(active.id, active.database).then(setTables).catch(() => setTables([]));
    }
  }, [open, active, status]);

  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Command palette" description="Search commands, tables and connections" className="sm:max-w-xl">
      <CommandInput placeholder="Type a command or search tables…" />
      <CommandList className="max-h-[420px]">
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Actions">
          {active && (
            <CommandItem onSelect={run(() => useWorkspace.getState().openQuery(active.id, active.database))}>
              <SquareTerminal /> New query <CommandShortcut>Alt N</CommandShortcut>
            </CommandItem>
          )}
          {active && (
            <CommandItem onSelect={run(() => useWorkspace.getState().open({ id: `dashboard:${active.id}`, kind: "dashboard", connectionId: active.id, database: active.database }))}>
              <LayoutDashboard /> Connection overview
            </CommandItem>
          )}
          <CommandItem onSelect={run(() => useUi.getState().openConnectionDialog())}><Plus /> New connection</CommandItem>
          <CommandItem onSelect={run(() => useWorkspace.getState().open({ id: "history", kind: "history" }))}><History /> Query history</CommandItem>
          <CommandItem onSelect={run(() => useWorkspace.getState().open({ id: "audit", kind: "audit" }))}><ScrollText /> Audit log</CommandItem>
          <CommandItem onSelect={run(() => setTheme(theme === "dark" ? "light" : "dark"))}><Moon /> Toggle theme</CommandItem>
          <CommandItem onSelect={run(() => useUi.getState().toggleSidebar())}><PanelLeft /> Toggle sidebar <CommandShortcut>{modKey} B</CommandShortcut></CommandItem>
          <CommandItem onSelect={run(() => useResults.getState().toggleBottom())}><PanelBottom /> Toggle results panel <CommandShortcut>{modKey} J</CommandShortcut></CommandItem>
        </CommandGroup>
        {tables.length > 0 && active && (
          <>
            <CommandSeparator />
            <CommandGroup heading={`Tables in ${active.name}`}>
              {tables.slice(0, 400).map((t) => (
                <CommandItem
                  key={`${t.schema_name}.${t.name}`}
                  value={`table ${t.schema_name ?? ""}.${t.name}`}
                  onSelect={run(() => useWorkspace.getState().openTable({ connectionId: active.id, database: active.database, schema: t.schema_name, table: t.name, objectKind: t.kind }))}
                >
                  {t.kind === "table" ? <Table2 className="text-brand/80" /> : <Eye />}
                  <span>{t.schema_name && t.schema_name !== "public" ? <span className="text-muted-foreground">{t.schema_name}.</span> : null}{t.name}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground">{t.columns.length} cols</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
        {recentTables.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Recently opened">
              {recentTables.slice(0, 8).map((r) => {
                const c = connections.find((x) => x.id === r.connectionId);
                if (!c) return null;
                return (
                  <CommandItem key={`recent:${r.connectionId}:${r.database}:${r.schema}:${r.table}`} value={`recent ${c.name} ${r.table}`}
                    onSelect={run(() => {
                      useConnections.getState().setActive(r.connectionId);
                      useWorkspace.getState().openTable(r);
                    })}>
                    <Clock /> {r.table} <span className="ml-auto text-[11px] text-muted-foreground">{c.name}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}
        {saved.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Saved queries">
              {saved.map((q) => (
                <CommandItem key={q.id} value={`saved ${q.name} ${q.sql.slice(0, 80)}`}
                  onSelect={run(() => {
                    const cid = q.connection_id && connections.some((c) => c.id === q.connection_id) ? q.connection_id : activeId;
                    if (cid) useWorkspace.getState().openQuery(cid, connections.find((c) => c.id === cid)?.database ?? null, q.sql, q.name, q.id);
                  })}>
                  <Bookmark /> {q.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
        {connections.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Switch connection">
              {connections.map((c) => (
                <CommandItem key={c.id} value={`connection ${c.name} ${c.group ?? ""}`} onSelect={run(() => {
                  useConnections.getState().setActive(c.id);
                  if (useConnections.getState().status[c.id] !== "connected") void useConnections.getState().connect(c.id);
                })}>
                  <EngineBadge engine={c.engine} color={c.color} /> {c.name}
                  {c.id === activeId && <Plug className="ml-auto text-success" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
      </Command>
    </CommandDialog>
  );
}
