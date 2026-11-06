import { create } from "zustand";
import type { ExecuteResult } from "@/lib/types";

export interface QueryRun {
  queryId: string;
  running: boolean;
  startedAt: number;
  result: ExecuteResult | null;
  error: string | null;
  sql: string;
}

export interface LogEntry {
  id: number;
  at: number;
  level: "info" | "success" | "error" | "warning";
  message: string;
  detail?: string;
  durationMs?: number;
  connectionName?: string;
}

type BottomTab = "results" | "history" | "log";

interface ResultsState {
  runs: Record<string, QueryRun>; // keyed by editor tab id
  logs: LogEntry[];
  bottomTab: BottomTab;
  bottomOpen: boolean;
  activeResult: Record<string, number>; // tab id -> selected result-set index
  start: (tabId: string, queryId: string, sql: string) => void;
  finish: (tabId: string, result: ExecuteResult | null, error?: string | null) => void;
  setActiveResult: (tabId: string, idx: number) => void;
  log: (e: Omit<LogEntry, "id" | "at">) => void;
  clearLogs: () => void;
  showBottom: (tab?: BottomTab) => void;
  toggleBottom: () => void;
  setBottomTab: (t: BottomTab) => void;
}

let logId = 0;

export const useResults = create<ResultsState>()((set) => ({
  runs: {},
  logs: [],
  bottomTab: "results",
  bottomOpen: true,
  activeResult: {},
  start: (tabId, queryId, sql) =>
    set((s) => ({ runs: { ...s.runs, [tabId]: { queryId, sql, running: true, startedAt: Date.now(), result: s.runs[tabId]?.result ?? null, error: null } } })),
  finish: (tabId, result, error = null) =>
    set((s) => {
      const prev = s.runs[tabId];
      if (!prev) return s;
      const firstRows = result ? Math.max(0, result.results.findIndex((r) => r.returns_rows || r.error)) : 0;
      return {
        runs: { ...s.runs, [tabId]: { ...prev, running: false, result, error } },
        activeResult: { ...s.activeResult, [tabId]: result ? (result.results.findIndex((r) => r.error) >= 0 ? result.results.length - 1 : firstRows) : 0 },
      };
    }),
  setActiveResult: (tabId, idx) => set((s) => ({ activeResult: { ...s.activeResult, [tabId]: idx } })),
  log: (e) => set((s) => ({ logs: [...s.logs.slice(-499), { ...e, id: ++logId, at: Date.now() }] })),
  clearLogs: () => set({ logs: [] }),
  showBottom: (tab) => set((s) => ({ bottomOpen: true, bottomTab: tab ?? s.bottomTab })),
  toggleBottom: () => set((s) => ({ bottomOpen: !s.bottomOpen })),
  setBottomTab: (t) => set({ bottomTab: t, bottomOpen: true }),
}));
