"use client";

import { ChevronRight, Columns3, FileCode2, Table2 } from "lucide-react";
import type { Connection } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useWorkspace, type Tab, type TableView } from "@/stores/workspace";
import { TableDataView } from "./table-data-view";
import { StructureView } from "@/components/structure/structure-view";
import { DdlView } from "@/components/structure/ddl-view";

type TableTabT = Extract<Tab, { kind: "table" }>;

export function TableTab({ tab, conn, active }: { tab: TableTabT; conn: Connection; active: boolean }) {
  const setView = (view: TableView) => useWorkspace.getState().update(tab.id, { view });
  const views: { v: TableView; label: string; icon: React.ElementType }[] = [
    { v: "data", label: "Data", icon: Table2 },
    { v: "structure", label: "Structure", icon: Columns3 },
    { v: "ddl", label: "DDL", icon: FileCode2 },
  ];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b px-3">
        <Breadcrumb parts={[conn.name, tab.database, tab.schema, tab.table].filter(Boolean) as string[]} color={conn.color} />
        <div className="ml-auto flex rounded-md border p-0.5">
          {views.map(({ v, label, icon: Icon }) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                "flex h-6 items-center gap-1.5 rounded-[5px] px-2 text-[12px] transition-colors",
                tab.view === v ? "bg-accent text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" /> {label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {/* Data view stays mounted to keep filters, edits and scroll position. */}
        <div className={cn("h-full", tab.view !== "data" && "hidden")}>
          <TableDataView tab={tab} conn={conn} active={active && tab.view === "data"} />
        </div>
        {tab.view === "structure" && <StructureView conn={conn} database={tab.database} schema={tab.schema} table={tab.table} objectKind={tab.objectKind} />}
        {tab.view === "ddl" && <DdlView conn={conn} database={tab.database} schema={tab.schema} name={tab.table} kind={tab.objectKind} />}
      </div>
    </div>
  );
}

export function Breadcrumb({ parts, color }: { parts: string[]; color?: string | null }) {
  return (
    <nav className="flex min-w-0 items-center gap-1 text-[12px] text-muted-foreground" aria-label="Breadcrumb">
      {color && <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />}
      {parts.map((p, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1">
          {i > 0 && <ChevronRight className="size-3 shrink-0 opacity-60" />}
          <span className={cn("truncate", i === parts.length - 1 && "font-medium text-foreground")}>{p}</span>
        </span>
      ))}
    </nav>
  );
}
