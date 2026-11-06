"use client";

import { useEffect } from "react";
import { usePanelRef } from "react-resizable-panels";
import { toast } from "sonner";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useConnections } from "@/stores/connections";
import { useResults } from "@/stores/results";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { useHotkey } from "@/hooks/use-hotkey";
import { Sidebar } from "./sidebar";
import { TabBar } from "./tab-bar";
import { TabContent } from "./tab-content";
import { BottomPanel } from "./bottom-panel";
import { StatusBar } from "./status-bar";
import { CommandPalette } from "./command-palette";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { ConnectionDialog } from "@/components/connections/connection-dialog";
import { SchemaChangeDialog } from "@/components/structure/schema-change-dialog";
import { CreateTableDialog } from "@/components/structure/create-table-dialog";
import { ImportDialog } from "@/components/data/import-dialog";

export function WorkspaceShell() {
  const load = useConnections((s) => s.load);
  const sidebarRef = usePanelRef();
  const bottomRef = usePanelRef();
  const bottomOpen = useResults((s) => s.bottomOpen);
  const sidebarCollapsed = useUi((s) => s.sidebarCollapsed);

  useEffect(() => {
    load().catch((e) => toast.error("Could not load connections", { description: (e as Error).message }));
  }, [load]);

  // Keep the imperative panel state in sync with the stores.
  useEffect(() => {
    const p = bottomRef.current;
    if (!p) return;
    if (bottomOpen && p.isCollapsed()) p.expand();
    if (!bottomOpen && !p.isCollapsed()) p.collapse();
  }, [bottomOpen, bottomRef]);
  useEffect(() => {
    const p = sidebarRef.current;
    if (!p) return;
    if (!sidebarCollapsed && p.isCollapsed()) p.expand();
    if (sidebarCollapsed && !p.isCollapsed()) p.collapse();
  }, [sidebarCollapsed, sidebarRef]);

  useHotkey("mod+k", () => useUi.getState().setPalette(!useUi.getState().paletteOpen));
  useHotkey("mod+b", () => useUi.getState().toggleSidebar());
  useHotkey("mod+j", () => useResults.getState().toggleBottom());
  useHotkey("alt+n", () => {
    const { activeId } = useConnections.getState();
    if (!activeId) return toast.info("Select a connection first");
    const conn = useConnections.getState().connections.find((c) => c.id === activeId);
    useWorkspace.getState().openQuery(activeId, conn?.database ?? null);
  });
  useHotkey("alt+w", () => {
    const { activeId, close } = useWorkspace.getState();
    if (activeId) close(activeId);
  });
  useHotkey("alt+]", () => cycleTab(1));
  useHotkey("alt+[", () => cycleTab(-1));

  return (
    <div className="flex h-full flex-col">
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel
          id="sidebar"
          panelRef={sidebarRef}
          defaultSize={272}
          minSize={200}
          maxSize="45"
          collapsible
          collapsedSize={0}
          onResize={(size) => {
            const collapsed = size.inPixels < 1;
            if (collapsed !== useUi.getState().sidebarCollapsed) useUi.setState({ sidebarCollapsed: collapsed });
          }}
        >
          <Sidebar />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="main" minSize="30">
          <ResizablePanelGroup orientation="vertical">
            <ResizablePanel id="editor" minSize={120}>
              <div className="flex h-full min-h-0 flex-col">
                <TabBar />
                <TabContent />
              </div>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel
              id="bottom"
              panelRef={bottomRef}
              defaultSize="32"
              minSize={110}
              collapsible
              collapsedSize={0}
              onResize={(size) => {
                const open = size.inPixels >= 1;
                if (open !== useResults.getState().bottomOpen) useResults.setState({ bottomOpen: open });
              }}
            >
              <BottomPanel />
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
      <StatusBar />
      <CommandPalette />
      <ConnectionDialog />
      <ConfirmDialog />
      <SchemaChangeDialog />
      <CreateTableDialog />
      <ImportDialog />
    </div>
  );
}

function cycleTab(dir: number) {
  const { tabs, activeId, activate } = useWorkspace.getState();
  if (!tabs.length) return;
  const i = tabs.findIndex((t) => t.id === activeId);
  activate(tabs[(i + dir + tabs.length) % tabs.length].id);
}
