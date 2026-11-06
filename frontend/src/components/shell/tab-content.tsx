"use client";

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import { useConnections } from "@/stores/connections";
import { useWorkspace, type Tab } from "@/stores/workspace";
import { TableTab } from "@/components/data/table-tab";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { HistoryView } from "@/components/history/history-view";
import { AuditView } from "@/components/history/audit-view";
import { WelcomeView } from "./welcome-view";

// Monaco is large and browser-only: load it lazily.
const QueryTab = dynamic(() => import("@/components/editor/query-tab").then((m) => m.QueryTab), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
    </div>
  ),
});

export function TabContent() {
  const tabs = useWorkspace((s) => s.tabs);
  const activeId = useWorkspace((s) => s.activeId);
  if (!tabs.length) return <WelcomeView />;
  return (
    <div className="relative min-h-0 flex-1">
      {tabs.map((t) => (
        // Tabs stay mounted so editor state, scroll position and filters survive tab switches.
        <div key={t.id} className="absolute inset-0 flex flex-col" hidden={t.id !== activeId} style={{ display: t.id === activeId ? undefined : "none" }}>
          <TabBody tab={t} active={t.id === activeId} />
        </div>
      ))}
    </div>
  );
}

function TabBody({ tab, active }: { tab: Tab; active: boolean }) {
  const conn = useConnections((s) => ("connectionId" in tab ? s.connections.find((c) => c.id === tab.connectionId) : undefined));
  const loaded = useConnections((s) => s.loaded);
  if ("connectionId" in tab && !conn) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        {loaded ? "This connection no longer exists." : <Loader2 className="size-4 animate-spin" />}
      </div>
    );
  }
  switch (tab.kind) {
    case "table":
      return <TableTab tab={tab} conn={conn!} active={active} />;
    case "query":
      return <QueryTab tab={tab} conn={conn!} active={active} />;
    case "dashboard":
      return <DashboardView tab={tab} conn={conn!} active={active} />;
    case "history":
      return <HistoryView />;
    case "audit":
      return <AuditView />;
  }
}
