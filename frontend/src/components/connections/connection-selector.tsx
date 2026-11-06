"use client";

import { useEffect, useMemo } from "react";
import { toast } from "sonner";
import { Check, ChevronsUpDown, Pencil, Plug, PlugZap, Plus, RotateCw, Trash2 } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import type { Connection } from "@/lib/types";
import { useConnections } from "@/stores/connections";
import { confirmAction, useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { EngineBadge, ENGINE_NAME, StatusDot } from "./engine-icon";

export function ConnectionSelector() {
  const { connections, loaded, activeId, status, serverInfo, errors, recent } = useConnections();
  const active = connections.find((c) => c.id === activeId) ?? null;

  // Connect on selection so the explorer can load immediately.
  useEffect(() => {
    if (active && !status[active.id]) void useConnections.getState().connect(active.id);
  }, [active, status]);

  const groups = useMemo(() => {
    const g = new Map<string, Connection[]>();
    for (const c of connections) {
      const k = c.group || "";
      g.set(k, [...(g.get(k) ?? []), c]);
    }
    return [...g.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  }, [connections]);
  const recentConns = recent.map((id) => connections.find((c) => c.id === id)).filter(Boolean).slice(0, 3) as Connection[];

  if (!loaded) return <Skeleton className="h-9 w-full" />;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex h-9 w-full items-center gap-2 rounded-md border bg-background px-2 text-left transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          {active ? (
            <>
              <EngineBadge engine={active.engine} color={active.color} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{active.name}</span>
                  <StatusDot status={status[active.id]} />
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {status[active.id] === "error"
                    ? errors[active.id]
                    : serverInfo[active.id]?.version ?? (active.engine === "sqlite" ? active.database : `${active.host}:${active.port ?? "default"}`)}
                </div>
              </div>
            </>
          ) : (
            <span className="flex-1 text-muted-foreground">{connections.length ? "Select a connection" : "No connections yet"}</span>
          )}
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[--radix-dropdown-menu-trigger-width] min-w-64">
        {recentConns.length > 1 && (
          <>
            <DropdownMenuLabel className="panel-title">Recent</DropdownMenuLabel>
            {recentConns.map((c) => (
              <ConnectionItem key={`r-${c.id}`} c={c} active={c.id === activeId} status={status[c.id]} />
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        {groups.map(([group, items]) => (
          <DropdownMenuGroup key={group || "_"}>
            <DropdownMenuLabel className="panel-title">{group || (groups.length > 1 ? "Ungrouped" : "Connections")}</DropdownMenuLabel>
            {items.map((c) => (
              <ConnectionItem key={c.id} c={c} active={c.id === activeId} status={status[c.id]} />
            ))}
          </DropdownMenuGroup>
        ))}
        {connections.length > 0 && <DropdownMenuSeparator />}
        {active && (
          <>
            <DropdownMenuItem onSelect={() => void useConnections.getState().connect(active.id)}>
              <RotateCw /> Reconnect
            </DropdownMenuItem>
            {status[active.id] === "connected" && (
              <DropdownMenuItem
                onSelect={async () => {
                  await useConnections.getState().disconnect(active.id);
                  toast.success(`Disconnected from ${active.name}`);
                }}
              >
                <Plug /> Disconnect
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => useUi.getState().openConnectionDialog(active.id)}>
              <Pencil /> Edit connection
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => void deleteConnection(active)}>
              <Trash2 /> Delete connection
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onSelect={() => useUi.getState().openConnectionDialog()}>
          <Plus /> New connection…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ConnectionItem({ c, active, status }: { c: Connection; active: boolean; status?: string }) {
  return (
    <DropdownMenuItem
      onSelect={() => {
        useConnections.getState().setActive(c.id);
        if (status !== "connected") void useConnections.getState().connect(c.id);
      }}
      className="gap-2"
    >
      <EngineBadge engine={c.engine} color={c.color} />
      <div className="min-w-0 flex-1">
        <div className="truncate">{c.name}</div>
        <div className="truncate text-[11px] text-muted-foreground">
          {ENGINE_NAME[c.engine]}
          {c.read_only && " · read-only"}
        </div>
      </div>
      {status === "connected" ? <PlugZap className="text-success" /> : <StatusDot status={status} />}
      {active && <Check className="size-3.5" />}
    </DropdownMenuItem>
  );
}

export async function deleteConnection(c: Connection) {
  const ok = await confirmAction({
    title: `Delete connection “${c.name}”?`,
    description: "The saved settings and encrypted credentials are removed. The database itself is not touched.",
    confirmText: "Delete connection",
    destructive: true,
  });
  if (!ok) return;
  try {
    await api.connections.remove(c.id);
    useConnections.getState().remove(c.id);
    useWorkspace.getState().closeForConnection(c.id);
    toast.success("Connection deleted");
  } catch (e) {
    toast.error((e as Error).message);
  }
}
