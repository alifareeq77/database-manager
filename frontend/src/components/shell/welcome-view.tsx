"use client";

import { Clock, Plus, SquareTerminal, Table2 } from "lucide-react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/lib/format";
import { useConnections } from "@/stores/connections";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { modKey } from "@/hooks/use-hotkey";

const SHORTCUTS: [string, string][] = [
  [`${modKey} K`, "Command palette"],
  [`${modKey} Enter`, "Run query / statement"],
  ["Alt N", "New query tab"],
  ["Alt W", "Close tab"],
  [`${modKey} B`, "Toggle sidebar"],
  [`${modKey} J`, "Toggle results panel"],
  [`${modKey} S`, "Save query"],
  ["Alt [ / ]", "Previous / next tab"],
];

export function WelcomeView() {
  const connections = useConnections((s) => s.connections);
  const active = useConnections((s) => s.connections.find((c) => c.id === s.activeId));
  const recent = useWorkspace((s) => s.recentTables).filter((r) => connections.some((c) => c.id === r.connectionId)).slice(0, 6);

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-8">
      <div className="grid w-full max-w-3xl gap-10 md:grid-cols-[1fr_260px]">
        <div>
          <Logo className="size-8" />
          <h1 className="mt-4 text-xl font-semibold tracking-tight">{active ? active.name : "Welcome to Strata"}</h1>
          <p className="mt-1 text-muted-foreground">
            {active ? "Open a table from the explorer, or start a query." : "Connect to PostgreSQL, MySQL/MariaDB or SQLite to get started."}
          </p>
          <div className="mt-5 flex gap-2">
            {active && (
              <Button size="sm" onClick={() => useWorkspace.getState().openQuery(active.id, active.database)}>
                <SquareTerminal /> New query
              </Button>
            )}
            <Button size="sm" variant={active ? "outline" : "default"} onClick={() => useUi.getState().openConnectionDialog()}>
              <Plus /> New connection
            </Button>
          </div>
          {recent.length > 0 && (
            <div className="mt-8">
              <div className="panel-title mb-2 flex items-center gap-1.5"><Clock className="size-3" /> Recently opened</div>
              <div className="divide-y rounded-md border">
                {recent.map((r) => {
                  const c = connections.find((x) => x.id === r.connectionId)!;
                  return (
                    <button
                      key={`${r.connectionId}:${r.database}:${r.schema}:${r.table}`}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent/50"
                      onClick={() => useWorkspace.getState().openTable({ ...r })}
                    >
                      <Table2 className="size-3.5 text-brand/80" />
                      <span className="truncate">{r.schema ? `${r.schema}.` : ""}{r.table}</span>
                      <span className="ml-auto truncate text-[11px] text-muted-foreground">{c.name} · {relativeTime(new Date(r.at).toISOString())}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <div>
          <div className="panel-title mb-2">Keyboard</div>
          <dl className="space-y-1.5">
            {SHORTCUTS.map(([k, label]) => (
              <div key={k} className="flex items-center justify-between gap-3 text-[12px]">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="kbd">{k}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}
