import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { api } from "@/lib/api";
import type { CatalogTable, Connection, ServerInfo } from "@/lib/types";
import { safeStorage } from "./storage";

type Status = "idle" | "connecting" | "connected" | "error";

interface ConnectionsState {
  connections: Connection[];
  loaded: boolean;
  activeId: string | null;
  status: Record<string, Status>;
  serverInfo: Record<string, ServerInfo>;
  errors: Record<string, string>;
  recent: string[]; // most recently used connection ids
  catalogs: Record<string, CatalogTable[]>;
  load: () => Promise<void>;
  setActive: (id: string | null) => void;
  connect: (id: string) => Promise<boolean>;
  disconnect: (id: string) => Promise<void>;
  upsert: (c: Connection) => void;
  remove: (id: string) => void;
  loadCatalog: (id: string, database: string | null, force?: boolean) => Promise<CatalogTable[]>;
  invalidateCatalog: (id: string) => void;
}

export const useConnections = create<ConnectionsState>()(
  persist(
    (set, get) => ({
      connections: [],
      loaded: false,
      activeId: null,
      status: {},
      serverInfo: {},
      errors: {},
      recent: [],
      catalogs: {},
      load: async () => {
        const list = await api.connections.list();
        set((s) => ({
          connections: list,
          loaded: true,
          activeId: s.activeId && list.some((c) => c.id === s.activeId) ? s.activeId : (list[0]?.id ?? null),
        }));
      },
      setActive: (id) => set({ activeId: id }),
      connect: async (id) => {
        set((s) => ({ status: { ...s.status, [id]: "connecting" } }));
        try {
          const info = await api.connections.connect(id);
          set((s) => ({
            status: { ...s.status, [id]: "connected" },
            serverInfo: { ...s.serverInfo, [id]: info },
            errors: { ...s.errors, [id]: "" },
            recent: [id, ...s.recent.filter((r) => r !== id)].slice(0, 8),
          }));
          return true;
        } catch (e) {
          set((s) => ({ status: { ...s.status, [id]: "error" }, errors: { ...s.errors, [id]: (e as Error).message } }));
          return false;
        }
      },
      disconnect: async (id) => {
        await api.connections.disconnect(id);
        set((s) => ({ status: { ...s.status, [id]: "idle" } }));
      },
      upsert: (c) =>
        set((s) => {
          const exists = s.connections.some((x) => x.id === c.id);
          const connections = exists ? s.connections.map((x) => (x.id === c.id ? c : x)) : [...s.connections, c];
          return { connections, status: exists ? { ...s.status, [c.id]: "idle" } : s.status };
        }),
      remove: (id) =>
        set((s) => ({
          connections: s.connections.filter((c) => c.id !== id),
          activeId: s.activeId === id ? (s.connections.find((c) => c.id !== id)?.id ?? null) : s.activeId,
          recent: s.recent.filter((r) => r !== id),
        })),
      loadCatalog: async (id, database, force) => {
        const key = `${id}:${database ?? ""}`;
        const cached = get().catalogs[key];
        if (cached && !force) return cached;
        const cat = await api.explorer.catalog(id, database);
        set((s) => ({ catalogs: { ...s.catalogs, [key]: cat } }));
        return cat;
      },
      invalidateCatalog: (id) =>
        set((s) => ({ catalogs: Object.fromEntries(Object.entries(s.catalogs).filter(([k]) => !k.startsWith(`${id}:`))) })),
    }),
    {
      name: "strata.connections",
      storage: createJSONStorage(() => safeStorage),
      // Only UI preferences are persisted — never connection details or credentials.
      partialize: (s) => ({ activeId: s.activeId, recent: s.recent }),
    },
  ),
);

export function useActiveConnection(): Connection | null {
  return useConnections((s) => s.connections.find((c) => c.id === s.activeId) ?? null);
}

export function connectionById(id: string | null | undefined): Connection | undefined {
  return useConnections.getState().connections.find((c) => c.id === id);
}
