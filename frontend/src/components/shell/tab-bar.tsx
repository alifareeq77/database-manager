"use client";

import { useRef, useState } from "react";
import { History, LayoutDashboard, Plus, ScrollText, SquareTerminal, Table2, Eye, X, PanelLeftOpen } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useConnections } from "@/stores/connections";
import { useResults } from "@/stores/results";
import { useUi } from "@/stores/ui";
import { tabTitle, useWorkspace, type Tab } from "@/stores/workspace";
import { confirmAction } from "@/stores/ui";

function TabIcon({ tab }: { tab: Tab }) {
  const cls = "size-3.5 shrink-0";
  switch (tab.kind) {
    case "table":
      return tab.objectKind === "table" ? <Table2 className={cn(cls, "text-brand/80")} /> : <Eye className={cls} />;
    case "query":
      return <SquareTerminal className={cls} />;
    case "dashboard":
      return <LayoutDashboard className={cls} />;
    case "history":
      return <History className={cls} />;
    case "audit":
      return <ScrollText className={cls} />;
  }
}

export async function closeTab(tab: Tab) {
  if (tab.kind === "query" && tab.dirty && tab.sql.trim()) {
    const ok = await confirmAction({ title: `Close “${tab.title}”?`, description: "This query has unsaved changes.", confirmText: "Close without saving", destructive: true });
    if (!ok) return;
  }
  useWorkspace.getState().close(tab.id);
}

export function TabBar() {
  const { tabs, activeId, activate, closeOthers, closeAll, move } = useWorkspace();
  const connections = useConnections((s) => s.connections);
  const running = useResults((s) => s.runs);
  const sidebarCollapsed = useUi((s) => s.sidebarCollapsed);
  const dragFrom = useRef<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const active = useConnections((s) => s.connections.find((c) => c.id === s.activeId));

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b bg-surface">
      {sidebarCollapsed && (
        <button className="flex w-9 items-center justify-center border-r text-muted-foreground hover:text-foreground" onClick={() => useUi.getState().toggleSidebar()} aria-label="Show sidebar">
          <PanelLeftOpen className="size-4" />
        </button>
      )}
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none]" role="tablist">
        {tabs.map((t, i) => {
          const conn = "connectionId" in t ? connections.find((c) => c.id === t.connectionId) : undefined;
          const isActive = t.id === activeId;
          const isRunning = running[t.id]?.running;
          return (
            <ContextMenu key={t.id}>
              <ContextMenuTrigger asChild>
                <div
                  role="tab"
                  aria-selected={isActive}
                  draggable
                  onDragStart={() => (dragFrom.current = i)}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDropAt(i);
                  }}
                  onDragEnd={() => setDropAt(null)}
                  onDrop={() => {
                    if (dragFrom.current !== null && dragFrom.current !== i) move(dragFrom.current, i);
                    dragFrom.current = null;
                    setDropAt(null);
                  }}
                  onMouseDown={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      void closeTab(t);
                    }
                  }}
                  onClick={() => activate(t.id)}
                  title={"connectionId" in t ? `${conn?.name ?? "?"}${"database" in t && t.database ? ` · ${t.database}` : ""}${t.kind === "table" && t.schema ? ` · ${t.schema}` : ""}` : undefined}
                  className={cn(
                    "group relative flex max-w-[220px] min-w-[110px] cursor-default items-center gap-1.5 border-r px-2.5 text-[12.5px] transition-colors",
                    isActive ? "bg-background text-foreground" : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
                    dropAt === i && "bg-accent",
                  )}
                >
                  {isActive && <span className="absolute inset-x-0 top-0 h-[2px]" style={{ background: conn?.color ?? "var(--primary)" }} />}
                  {!isActive && conn?.color && <span className="absolute inset-x-0 top-0 h-px opacity-60" style={{ background: conn.color }} />}
                  <TabIcon tab={t} />
                  <span className={cn("truncate", t.kind === "query" && t.dirty && "italic")}>{tabTitle(t)}</span>
                  {isRunning && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-warning" />}
                  <button
                    className={cn("ml-auto flex size-4 shrink-0 items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-accent", isActive && "opacity-60")}
                    onClick={(e) => {
                      e.stopPropagation();
                      void closeTab(t);
                    }}
                    aria-label="Close tab"
                  >
                    {t.kind === "query" && t.dirty ? <span className="size-1.5 rounded-full bg-foreground/70 group-hover:hidden" /> : null}
                    <X className={cn("size-3", t.kind === "query" && t.dirty && "hidden group-hover:block")} />
                  </button>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-48">
                <ContextMenuItem onSelect={() => void closeTab(t)}>Close <span className="ml-auto kbd">Alt W</span></ContextMenuItem>
                <ContextMenuItem onSelect={() => closeOthers(t.id)}>Close others</ContextMenuItem>
                <ContextMenuItem onSelect={closeAll}>Close all</ContextMenuItem>
                {t.kind === "table" && (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => useWorkspace.getState().openQuery(t.connectionId, t.database)}>New query on this connection</ContextMenuItem>
                  </>
                )}
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-9 w-9 rounded-none border-l text-muted-foreground"
        disabled={!active}
        onClick={() => active && useWorkspace.getState().openQuery(active.id, active.database)}
        aria-label="New query"
        title="New query (Alt+N)"
      >
        <Plus />
      </Button>
    </div>
  );
}
