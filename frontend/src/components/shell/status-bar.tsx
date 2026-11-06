"use client";

import { Lock, PanelBottom } from "lucide-react";
import { formatDuration } from "@/lib/format";
import { useConnections } from "@/stores/connections";
import { useResults } from "@/stores/results";
import { useWorkspace } from "@/stores/workspace";
import { StatusDot } from "@/components/connections/engine-icon";

export function StatusBar() {
  const conn = useConnections((s) => s.connections.find((c) => c.id === s.activeId));
  const status = useConnections((s) => (s.activeId ? s.status[s.activeId] : undefined));
  const info = useConnections((s) => (s.activeId ? s.serverInfo[s.activeId] : undefined));
  const tab = useWorkspace((s) => s.tabs.find((t) => t.id === s.activeId));
  const run = useResults((s) => (tab ? s.runs[tab.id] : undefined));
  const lastLog = useResults((s) => s.logs[s.logs.length - 1]);

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t bg-surface px-2.5 text-[11px] text-muted-foreground">
      {conn ? (
        <span className="flex items-center gap-1.5">
          <StatusDot status={status} />
          <span className="text-foreground/80">{conn.name}</span>
          {info && <span>{info.version}</span>}
          {info?.current_user && <span>· {info.current_user}</span>}
          {conn.read_only && (
            <span className="flex items-center gap-0.5 text-warning"><Lock className="size-3" /> read-only</span>
          )}
        </span>
      ) : (
        <span>No connection</span>
      )}
      <span className="ml-auto flex items-center gap-3">
        {run?.running ? (
          <span className="text-warning">Running…</span>
        ) : run?.result ? (
          <span>{run.result.status} · {formatDuration(run.result.duration_ms)}</span>
        ) : lastLog ? (
          <span className="max-w-96 truncate">{lastLog.message}</span>
        ) : null}
        <button className="flex items-center gap-1 hover:text-foreground" onClick={() => useResults.getState().toggleBottom()} title="Toggle panel (Ctrl+J)">
          <PanelBottom className="size-3" />
        </button>
      </span>
    </footer>
  );
}
