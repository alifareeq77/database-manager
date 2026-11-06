import { create } from "zustand";
import type { SchemaChange } from "@/lib/types";

export interface ConfirmRequest {
  title: string;
  description?: React.ReactNode;
  confirmText?: string;
  destructive?: boolean;
  typeToConfirm?: string;
  resolve: (ok: boolean) => void;
}

export interface SchemaChangeRequest {
  connectionId: string;
  database: string | null;
  change: SchemaChange;
  title: string;
  onApplied?: () => void;
}

interface UiState {
  paletteOpen: boolean;
  connectionDialog: { open: boolean; editId: string | null };
  importDialog: { connectionId: string; database: string | null; schema: string | null; table: string | null } | null;
  createTable: { connectionId: string; database: string | null; schema: string | null } | null;
  schemaChange: SchemaChangeRequest | null;
  confirm: ConfirmRequest | null;
  sidebarCollapsed: boolean;
  setPalette: (open: boolean) => void;
  openConnectionDialog: (editId?: string | null) => void;
  closeConnectionDialog: () => void;
  setImportDialog: (v: UiState["importDialog"]) => void;
  setCreateTable: (v: UiState["createTable"]) => void;
  requestSchemaChange: (v: SchemaChangeRequest | null) => void;
  toggleSidebar: () => void;
}

export const useUi = create<UiState>()((set) => ({
  paletteOpen: false,
  connectionDialog: { open: false, editId: null },
  importDialog: null,
  createTable: null,
  schemaChange: null,
  confirm: null,
  sidebarCollapsed: false,
  setPalette: (open) => set({ paletteOpen: open }),
  openConnectionDialog: (editId = null) => set({ connectionDialog: { open: true, editId } }),
  closeConnectionDialog: () => set({ connectionDialog: { open: false, editId: null } }),
  setImportDialog: (v) => set({ importDialog: v }),
  setCreateTable: (v) => set({ createTable: v }),
  requestSchemaChange: (v) => set({ schemaChange: v }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
}));

/** Promise-based confirmation dialog. */
export function confirmAction(opts: Omit<ConfirmRequest, "resolve">): Promise<boolean> {
  return new Promise((resolve) => {
    useUi.setState({
      confirm: {
        ...opts,
        resolve: (ok) => {
          useUi.setState({ confirm: null });
          resolve(ok);
        },
      },
    });
  });
}
