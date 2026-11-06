import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { ObjectKind } from "@/lib/types";
import { safeStorage } from "./storage";

export type TableView = "data" | "structure" | "ddl";

export type Tab =
  | { id: string; kind: "table"; connectionId: string; database: string | null; schema: string | null; table: string; objectKind: ObjectKind; view: TableView }
  | { id: string; kind: "query"; connectionId: string; database: string | null; title: string; sql: string; savedId?: string; dirty?: boolean }
  | { id: string; kind: "dashboard"; connectionId: string; database: string | null }
  | { id: string; kind: "history" }
  | { id: string; kind: "audit" };

export interface RecentTable {
  connectionId: string;
  database: string | null;
  schema: string | null;
  table: string;
  objectKind: ObjectKind;
  at: number;
}

interface WorkspaceState {
  tabs: Tab[];
  activeId: string | null;
  recentTables: RecentTable[];
  queryCounter: number;
  open: (tab: Tab) => void;
  openTable: (t: Omit<Extract<Tab, { kind: "table" }>, "id" | "kind" | "view"> & { view?: TableView }) => void;
  openQuery: (connectionId: string, database: string | null, sql?: string, title?: string, savedId?: string) => string;
  close: (id: string) => void;
  closeOthers: (id: string) => void;
  closeAll: () => void;
  activate: (id: string) => void;
  update: (id: string, patch: Partial<Tab>) => void;
  move: (from: number, to: number) => void;
  closeForConnection: (connectionId: string) => void;
}

const uid = () => Math.random().toString(36).slice(2, 10);

export const useWorkspace = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeId: null,
      recentTables: [],
      queryCounter: 0,
      open: (tab) =>
        set((s) => {
          const existing = s.tabs.find((t) => t.id === tab.id);
          return { tabs: existing ? s.tabs : [...s.tabs, tab], activeId: tab.id };
        }),
      openTable: ({ connectionId, database, schema, table, objectKind, view = "data" }) => {
        const id = `table:${connectionId}:${database ?? ""}:${schema ?? ""}:${table}`;
        set((s) => {
          const recent: RecentTable = { connectionId, database, schema, table, objectKind, at: Date.now() };
          const recentTables = [recent, ...s.recentTables.filter((r) => !(r.connectionId === connectionId && r.database === database && r.schema === schema && r.table === table))].slice(0, 20);
          const existing = s.tabs.find((t) => t.id === id);
          if (existing) {
            return { activeId: id, recentTables, tabs: s.tabs.map((t) => (t.id === id ? ({ ...t, view } as Tab) : t)) };
          }
          return { tabs: [...s.tabs, { id, kind: "table", connectionId, database, schema, table, objectKind, view }], activeId: id, recentTables };
        });
      },
      openQuery: (connectionId, database, sql = "", title, savedId) => {
        const n = get().queryCounter + 1;
        const id = `query:${uid()}`;
        set((s) => ({
          queryCounter: n,
          tabs: [...s.tabs, { id, kind: "query", connectionId, database, sql, title: title ?? `Query ${n}`, savedId }],
          activeId: id,
        }));
        return id;
      },
      close: (id) =>
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.id === id);
          const tabs = s.tabs.filter((t) => t.id !== id);
          let activeId = s.activeId;
          if (s.activeId === id) activeId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
          return { tabs, activeId };
        }),
      closeOthers: (id) => set((s) => ({ tabs: s.tabs.filter((t) => t.id === id), activeId: id })),
      closeAll: () => set({ tabs: [], activeId: null }),
      activate: (id) => set({ activeId: id }),
      update: (id, patch) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? ({ ...t, ...patch } as Tab) : t)) })),
      move: (from, to) =>
        set((s) => {
          const tabs = [...s.tabs];
          const [t] = tabs.splice(from, 1);
          tabs.splice(to, 0, t);
          return { tabs };
        }),
      closeForConnection: (connectionId) =>
        set((s) => {
          const tabs = s.tabs.filter((t) => !("connectionId" in t) || t.connectionId !== connectionId);
          return { tabs, activeId: tabs.some((t) => t.id === s.activeId) ? s.activeId : (tabs[0]?.id ?? null) };
        }),
    }),
    { name: "strata.workspace", storage: createJSONStorage(() => safeStorage), version: 1 },
  ),
);

export function tabTitle(t: Tab): string {
  switch (t.kind) {
    case "table":
      return t.table;
    case "query":
      return t.title;
    case "dashboard":
      return "Overview";
    case "history":
      return "Query history";
    case "audit":
      return "Audit log";
  }
}
